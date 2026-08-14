package com.oru.radio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * The audio pipeline of spec section 8:
 *
 *   microphone -> PCM 16 kHz mono -> Opus 20 ms -> TransmissionSink
 *   incoming frames -> jitter buffer -> Opus decode -> mix -> AudioTrack
 *
 * Two threads: one for capture (started only while transmitting) and one for playback
 * (running while at least one peer is transmitting). Both are paced by the audio hardware,
 * so neither spins. JS never sees a frame.
 */
class AudioEngine : AudioIo {

    private companion object {
        const val TAG = "OruRadio"
        const val BYTES_PER_SAMPLE = 2
    }

    /**
     * One peer's decode pipeline. [decodeInto] (called only from `oru-playback`) and
     * [close] (called only from the scheduler thread) share this object's monitor, so a
     * close can never run concurrently with an in-flight decode of the same peer: close
     * blocks until any decode already in progress finishes, and a decode that arrives
     * after close observes [closed] and returns without touching the decoder — which may
     * already have destroyed its native handle. This is what makes it safe for the
     * scheduler thread to remove a peer from [playbacks] and close its decoder while the
     * playback thread is mid-iteration over that same map.
     */
    private class Playback(
        val jitter: JitterBuffer = JitterBuffer(),
        private val decoder: OpusDecoder = OpusDecoder(),
    ) {
        val pcm = ShortArray(RadioConfig.FRAME_SAMPLES)
        private var closed = false

        /** Decodes [frame] into [pcm], returning the sample count, or -1 once closed. */
        @Synchronized
        fun decodeInto(frame: ByteArray, length: Int): Int {
            if (closed) return -1
            return decoder.decode(frame, length, pcm, RadioConfig.FRAME_SAMPLES)
        }

        @Synchronized
        fun close() {
            if (closed) return
            closed = true
            decoder.close()
        }
    }

    private val playbacks = ConcurrentHashMap<String, Playback>()

    @Volatile private var capturing = false
    @Volatile private var playing = false
    @Volatile private var onFailure: ((String, String) -> Unit)? = null
    private var captureThread: Thread? = null
    private var playbackThread: Thread? = null

    override fun setFailureListener(listener: (code: String, message: String) -> Unit) {
        onFailure = listener
    }

    // --- capture ---------------------------------------------------------------------------

    override fun startCapture(sink: TransmissionSink) {
        if (capturing) return
        capturing = true
        captureThread = Thread({ captureLoop(sink) }, "oru-capture").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
    }

    override fun stopCapture() {
        capturing = false
        captureThread?.join(500)
        captureThread = null
    }

    private fun captureLoop(sink: TransmissionSink) {
        var record: AudioRecord? = null
        var encoder: OpusEncoder? = null
        try {
            val minimum = AudioRecord.getMinBufferSize(
                RadioConfig.SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            val bufferBytes = maxOf(
                minimum,
                RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * RadioConfig.AUDIO_BUFFER_FRAMES,
            )
            // VOICE_COMMUNICATION gives us the system's echo cancellation and noise
            // suppression (spec section 8).
            record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                RadioConfig.SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes,
            )
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord did not initialize")
                onFailure?.invoke("microphone_unavailable", "AudioRecord did not initialize")
                return
            }

            encoder = OpusEncoder()
            val pcm = ShortArray(RadioConfig.FRAME_SAMPLES)
            val encoded = ByteArray(RadioConfig.MAX_ENCODED_FRAME_BYTES)

            record.startRecording()
            var consecutiveReadErrors = 0
            while (capturing) {
                var offset = 0
                var readFailed = false
                while (offset < pcm.size && capturing) {
                    val read = record.read(pcm, offset, pcm.size - offset)
                    if (read < 0) {
                        readFailed = true
                        break
                    }
                    if (read == 0) break
                    offset += read
                }
                if (readFailed) {
                    // A single bad read is tolerated (the hardware can hiccup); only a
                    // persistent run of them means the device is dead, and looping on
                    // that at Thread.MAX_PRIORITY with no backoff is exactly the spin
                    // spec section 13 forbids.
                    consecutiveReadErrors++
                    if (consecutiveReadErrors >= RadioConfig.AUDIO_MAX_CONSECUTIVE_IO_ERRORS) {
                        Log.e(TAG, "AudioRecord.read failed repeatedly")
                        onFailure?.invoke("microphone_read_failed", "AudioRecord.read failed repeatedly")
                        break
                    }
                    continue
                }
                consecutiveReadErrors = 0
                if (offset < pcm.size) continue

                val length = encoder.encode(pcm, RadioConfig.FRAME_SAMPLES, encoded)
                if (length > 0) sink.writeFrame(encoded.copyOf(length))
            }
        } catch (error: Exception) {
            Log.e(TAG, "capture stopped on an error", error)
            onFailure?.invoke("capture_failed", error.message ?: error.javaClass.simpleName)
        } finally {
            runCatching { record?.stop() }
            record?.release()
            encoder?.close()
        }
    }

    // --- playback --------------------------------------------------------------------------

    override fun openPlayback(peerId: String) {
        if (playbacks.containsKey(peerId)) return
        try {
            playbacks[peerId] = Playback()
        } catch (error: OpusException) {
            Log.e(TAG, "no decoder for $peerId", error)
            onFailure?.invoke("decoder_unavailable", error.message ?: "opus_decoder_create failed")
            return
        }
        startPlayback()
    }

    override fun playFrame(peerId: String, frame: ByteArray) {
        playbacks[peerId]?.jitter?.push(frame)
    }

    override fun closePlayback(peerId: String) {
        playbacks.remove(peerId)?.close()
        if (playbacks.isEmpty()) stopPlayback()
    }

    override fun release() {
        stopCapture()
        // Stop and join the playback thread before closing any decoder: stopPlayback()'s
        // join has a fixed 500 ms timeout and returns regardless of whether the thread
        // actually exited, so the per-Playback lock (not just this ordering) is what keeps
        // a decoder close from ever racing a decode still in flight on that thread.
        stopPlayback()
        playbacks.keys.toList().forEach { peerId -> playbacks.remove(peerId)?.close() }
    }

    private fun startPlayback() {
        if (playing) return
        playing = true
        playbackThread = Thread(::playbackLoop, "oru-playback").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
    }

    private fun stopPlayback() {
        if (!playing) return
        playing = false
        playbackThread?.join(500)
        playbackThread = null
    }

    private fun playbackLoop() {
        var track: AudioTrack? = null
        try {
            val minimum = AudioTrack.getMinBufferSize(
                RadioConfig.SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(RadioConfig.SAMPLE_RATE_HZ)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(
                    maxOf(
                        minimum,
                        RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * RadioConfig.AUDIO_BUFFER_FRAMES,
                    ),
                )
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            val mixed = ShortArray(RadioConfig.FRAME_SAMPLES)
            val ready = ArrayList<ShortArray>(4)
            track.play()

            var consecutiveWriteErrors = 0
            while (playing) {
                ready.clear()
                for (playback in playbacks.values) {
                    val frame = playback.jitter.pop() ?: continue
                    // decodeInto is synchronized on the Playback itself, so it can never
                    // run concurrently with that same peer's close() on the scheduler
                    // thread; it returns -1 without touching the decoder if that peer was
                    // already closed since jitter.pop() returned this frame.
                    val samples = playback.decodeInto(frame, frame.size)
                    // playback.pcm is reused, which is safe: it is mixed below, before
                    // this peer decodes again on the next iteration.
                    if (samples > 0) ready.add(playback.pcm)
                }
                AudioMixer.mix(ready, mixed)
                // A silent frame when nothing is ready keeps AudioTrack's blocking write
                // pacing this loop at real time instead of spinning.
                val written = track.write(mixed, 0, mixed.size)
                if (written < 0) {
                    // A dead AudioTrack returns an error immediately instead of blocking,
                    // so without this check the loop would busy-spin at
                    // Thread.MAX_PRIORITY exactly like an unchecked read failure would.
                    consecutiveWriteErrors++
                    if (consecutiveWriteErrors >= RadioConfig.AUDIO_MAX_CONSECUTIVE_IO_ERRORS) {
                        Log.e(TAG, "AudioTrack.write failed repeatedly")
                        onFailure?.invoke("speaker_write_failed", "AudioTrack.write failed repeatedly")
                        break
                    }
                } else {
                    consecutiveWriteErrors = 0
                }
            }
        } catch (error: Exception) {
            Log.e(TAG, "playback stopped on an error", error)
            onFailure?.invoke("playback_failed", error.message ?: error.javaClass.simpleName)
        } finally {
            runCatching { track?.stop() }
            track?.release()
        }
    }
}
