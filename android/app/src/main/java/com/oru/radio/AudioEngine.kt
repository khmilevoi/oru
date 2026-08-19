package com.oru.radio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Process
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

        /** How long a stop waits for an audio thread before giving up on the join. */
        const val THREAD_JOIN_MS = 500L
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

    /**
     * Bumped by [onRouteChanged] on the engine's scheduler thread and read once per iteration
     * by each audio thread. [routeProfile] is written before [routeGeneration] by the single
     * writer and read after it by the single reader ([playbackLoop]; [captureLoop] never reads
     * [routeProfile]), so a reader that observes generation G can only ever see a profile equal
     * to or newer than the one [onRouteChanged] paired with G — never older. The only anomaly
     * possible is the reverse: a rebuild can be stamped with a *newer* [routeProfile] than the
     * [routeGeneration] it records, which just makes [AudioStreamGuard]'s `builtGeneration` lag
     * behind. That self-corrects on the very next iteration, which re-reads the true
     * [routeGeneration], still finds it changed, and rebuilds again — no further
     * [onRouteChanged] call is needed.
     */
    @Volatile private var routeGeneration = 0
    @Volatile private var routeProfile: ModePolicy.Profile = ModePolicy.Profile.VOICE

    override fun setFailureListener(listener: (code: String, message: String) -> Unit) {
        onFailure = listener
    }

    override fun onRouteChanged(profile: ModePolicy.Profile) {
        routeProfile = profile
        routeGeneration++
        Log.i(TAG, "audio: route changed, streams rebuild on the next frame (profile=$profile)")
    }

    // --- capture ---------------------------------------------------------------------------

    override fun startCapture(sink: TransmissionSink) {
        if (capturing) return
        val previous = captureThread
        if (previous != null && previous.isAlive) {
            // The previous capture thread outlived its join and still owns an AudioRecord
            // it has not released yet — in practice it is blocked in sink.writeFrame on a
            // wedged peer's Nearby pipe (~64 KB draining at ~3 KB/s fills in about 20 s).
            // Opening a second AudioRecord now would return STATE_UNINITIALIZED, report
            // microphone_unavailable and leave the radio in status 'error' until the
            // process restarts, so this transmission is dropped instead: the orphan exits
            // on its own as soon as its blocked write fails, and the next press works.
            Log.w(TAG, "the previous capture has not finished; skipping this transmission")
            return
        }
        capturing = true
        captureThread = Thread({ captureLoop(sink) }, "oru-capture").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
    }

    override fun stopCapture() {
        capturing = false
        captureThread?.join(THREAD_JOIN_MS)
        // Deliberately not cleared: a thread that outlived the join is still winding down
        // and still owns its AudioRecord, and startCapture has to be able to see that. A
        // reference to a thread that did finish is harmless — startCapture replaces it.
    }

    /**
     * VOICE_COMMUNICATION in both profiles (§6 capture row): the route decides the mic.
     * VOICE_COMMUNICATION also gives us the system's echo cancellation and noise suppression
     * (spec section 8).
     */
    private fun openRecord(): AudioRecord? {
        val minimum = AudioRecord.getMinBufferSize(
            RadioConfig.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val bufferBytes = maxOf(
            minimum,
            RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * RadioConfig.AUDIO_BUFFER_FRAMES,
        )
        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            RadioConfig.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            Log.e(TAG, "AudioRecord did not initialize")
            onFailure?.invoke("microphone_unavailable", "AudioRecord did not initialize")
            return null
        }
        return record
    }

    /**
     * Section 6's playback row. VOICE plays on the voice-communication path, which follows the
     * communication device; MEDIA plays as navigation guidance on the media path, which mixes
     * into A2DP instead of dragging the headset onto SCO.
     */
    private fun openTrack(profile: ModePolicy.Profile): AudioTrack {
        val usage = when (profile) {
            ModePolicy.Profile.VOICE -> AudioAttributes.USAGE_VOICE_COMMUNICATION
            ModePolicy.Profile.MEDIA -> AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE
        }
        val minimum = AudioTrack.getMinBufferSize(
            RadioConfig.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(usage)
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
    }

    private fun releaseRecord(record: AudioRecord?) {
        if (record == null) return
        runCatching { record.stop() }
        record.release()
    }

    private fun releaseTrack(track: AudioTrack?) {
        if (track == null) return
        runCatching { track.stop() }
        track.release()
    }

    /**
     * Owns its AudioRecord from open to release. The release lives in this thread's own
     * `finally` rather than in [stopCapture] on purpose: [stopCapture]'s join has a fixed
     * timeout and returns whether or not the thread actually exited, so anything that
     * depended on the join succeeding would leak the device the moment a peer wedged.
     */
    private fun captureLoop(sink: TransmissionSink) {
        // Java thread priority barely moves Android's scheduler; this is the call that
        // actually puts the thread in the audio scheduling group, and it only works from
        // inside the thread it applies to.
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val guard = AudioStreamGuard()
        var record: AudioRecord? = null
        var encoder: OpusEncoder? = null
        try {
            encoder = OpusEncoder()
            val pcm = ShortArray(RadioConfig.FRAME_SAMPLES)
            val encoded = ByteArray(RadioConfig.MAX_ENCODED_FRAME_BYTES)

            while (capturing) {
                if (guard.needsRebuild(routeGeneration)) {
                    releaseRecord(record)
                    // Null it immediately: if openRecord() fails and returns, the `finally`
                    // below must not see a reference to the record we just released.
                    record = null
                    record = openRecord() ?: return
                    record.startRecording()
                }
                val active = record ?: return
                var offset = 0
                var readFailed = false
                while (offset < pcm.size && capturing) {
                    val read = active.read(pcm, offset, pcm.size - offset)
                    if (read < 0) {
                        readFailed = true
                        break
                    }
                    if (read == 0) break
                    offset += read
                }
                if (readFailed) {
                    // A single bad read is tolerated (the hardware can hiccup, and a route
                    // change is a hiccup); only a persistent run on a stable route means the
                    // device is dead. Looping on that at MAX_PRIORITY with no backoff is the
                    // spin spec section 13 forbids.
                    if (guard.onError()) {
                        Log.e(TAG, "AudioRecord.read failed repeatedly")
                        onFailure?.invoke("microphone_read_failed", "AudioRecord.read failed repeatedly")
                        break
                    }
                    continue
                }
                guard.onSuccess()
                if (offset < pcm.size) continue

                val length = encoder.encode(pcm, RadioConfig.FRAME_SAMPLES, encoded)
                if (length > 0) sink.writeFrame(encoded.copyOf(length))
            }
        } catch (error: Exception) {
            Log.e(TAG, "capture stopped on an error", error)
            onFailure?.invoke("capture_failed", error.message ?: error.javaClass.simpleName)
        } finally {
            releaseRecord(record)
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
        playbackThread?.join(THREAD_JOIN_MS)
        playbackThread = null
    }

    private fun playbackLoop() {
        // See captureLoop: Process.setThreadPriority, called from inside the thread, is the
        // priority Android's scheduler actually honours.
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val guard = AudioStreamGuard()
        var track: AudioTrack? = null
        try {
            val mixed = ShortArray(RadioConfig.FRAME_SAMPLES)
            val ready = ArrayList<ShortArray>(4)

            while (playing) {
                if (guard.needsRebuild(routeGeneration)) {
                    releaseTrack(track)
                    // Null it immediately: openTrack() signals failure by throwing (its
                    // Builder.build() can throw UnsupportedOperationException), and if it
                    // does, the `finally` below must not see a reference to the track we
                    // just released.
                    track = null
                    track = openTrack(routeProfile)
                    track.play()
                }
                val active = track ?: return
                ready.clear()
                for (playback in playbacks.values) {
                    val frame = playback.jitter.pop() ?: continue
                    // decodeInto is synchronized on the Playback itself, so it can never
                    // run concurrently with that same peer's close() on the scheduler
                    // thread; it returns -1 without touching the decoder if that peer was
                    // already closed since jitter.pop() returned this frame.
                    val samples = playback.decodeInto(frame, frame.size)
                    // playback.pcm is reused, which is safe: it is mixed below, before
                    // this peer decodes again on the next iteration. Only the samples this
                    // decode actually produced are mixed, though: a short decode leaves the
                    // previous frame's tail in the rest of the buffer, and mixing that back
                    // in replays a slice of old audio. The full-length case — every
                    // well-formed 20 ms packet — still mixes the buffer itself, so the
                    // normal path allocates nothing.
                    if (samples > 0) {
                        ready.add(
                            if (samples == RadioConfig.FRAME_SAMPLES) playback.pcm
                            else playback.pcm.copyOf(samples),
                        )
                    }
                }
                AudioMixer.mix(ready, mixed)
                // A silent frame when nothing is ready keeps AudioTrack's blocking write
                // pacing this loop at real time instead of spinning.
                val written = active.write(mixed, 0, mixed.size)
                if (written < 0) {
                    // A dead AudioTrack returns an error immediately instead of blocking, so
                    // without this check the loop would busy-spin at Thread.MAX_PRIORITY
                    // exactly like an unchecked read failure would.
                    if (guard.onError()) {
                        Log.e(TAG, "AudioTrack.write failed repeatedly")
                        onFailure?.invoke("speaker_write_failed", "AudioTrack.write failed repeatedly")
                        break
                    }
                } else {
                    guard.onSuccess()
                }
            }
        } catch (error: Exception) {
            Log.e(TAG, "playback stopped on an error", error)
            onFailure?.invoke("playback_failed", error.message ?: error.javaClass.simpleName)
        } finally {
            releaseTrack(track)
        }
    }
}
