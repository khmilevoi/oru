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
        const val BUFFER_FRAMES = 4
    }

    private class Playback(
        val jitter: JitterBuffer = JitterBuffer(),
        val decoder: OpusDecoder = OpusDecoder(),
        val pcm: ShortArray = ShortArray(RadioConfig.FRAME_SAMPLES),
    )

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
                RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * BUFFER_FRAMES,
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
            while (capturing) {
                var offset = 0
                while (offset < pcm.size && capturing) {
                    val read = record.read(pcm, offset, pcm.size - offset)
                    if (read <= 0) break
                    offset += read
                }
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
        playbacks.remove(peerId)?.decoder?.close()
        if (playbacks.isEmpty()) stopPlayback()
    }

    override fun release() {
        stopCapture()
        playbacks.keys.toList().forEach { closePlayback(it) }
        stopPlayback()
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
                    maxOf(minimum, RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * BUFFER_FRAMES),
                )
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            val mixed = ShortArray(RadioConfig.FRAME_SAMPLES)
            val ready = ArrayList<ShortArray>(4)
            track.play()

            while (playing) {
                ready.clear()
                for (playback in playbacks.values) {
                    val frame = playback.jitter.pop() ?: continue
                    val samples = playback.decoder.decode(
                        frame,
                        frame.size,
                        playback.pcm,
                        RadioConfig.FRAME_SAMPLES,
                    )
                    // playback.pcm is reused, which is safe: it is mixed below, before
                    // this peer decodes again on the next iteration.
                    if (samples > 0) ready.add(playback.pcm)
                }
                AudioMixer.mix(ready, mixed)
                // A silent frame when nothing is ready keeps AudioTrack's blocking write
                // pacing this loop at real time instead of spinning.
                track.write(mixed, 0, mixed.size)
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
