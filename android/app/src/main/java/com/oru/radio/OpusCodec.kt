package com.oru.radio

import java.io.Closeable

/**
 * The JNI entry points of liboru_opus.so. Declared here, in com.oru.radio, because JNI
 * symbol names encode the declaring class: opus_jni.c defines
 * Java_com_oru_radio_OpusCodec_*. Nothing outside this file calls them.
 */
internal object OpusCodec {

    @Volatile
    private var loaded = false

    @Synchronized
    fun ensureLoaded() {
        if (!loaded) {
            System.loadLibrary("oru_opus")
            loaded = true
        }
    }

    @JvmStatic external fun nativeCreateEncoder(sampleRate: Int, channels: Int, bitrate: Int): Long
    @JvmStatic external fun nativeEncode(handle: Long, pcm: ShortArray, frameSamples: Int, out: ByteArray): Int
    @JvmStatic external fun nativeDestroyEncoder(handle: Long)
    @JvmStatic external fun nativeCreateDecoder(sampleRate: Int, channels: Int): Long
    @JvmStatic external fun nativeDecode(handle: Long, packet: ByteArray?, length: Int, pcm: ShortArray, frameSamples: Int): Int
    @JvmStatic external fun nativeDestroyDecoder(handle: Long)
}

/** Thrown when libopus refuses to create a codec; the engine turns this into an error event. */
class OpusException(message: String) : RuntimeException(message)

class OpusEncoder(
    sampleRateHz: Int = RadioConfig.SAMPLE_RATE_HZ,
    channels: Int = RadioConfig.CHANNEL_COUNT,
    bitrateBps: Int = RadioConfig.BITRATE_BPS,
) : Closeable {

    @Volatile
    private var handle: Long

    init {
        OpusCodec.ensureLoaded()
        handle = OpusCodec.nativeCreateEncoder(sampleRateHz, channels, bitrateBps)
        if (handle == 0L) throw OpusException("opus_encoder_create failed")
    }

    /** Returns the number of encoded bytes written into [out], or -1 on failure. */
    fun encode(pcm: ShortArray, frameSamples: Int, out: ByteArray): Int {
        val current = handle
        if (current == 0L) return -1
        return OpusCodec.nativeEncode(current, pcm, frameSamples, out)
    }

    override fun close() {
        val current = handle
        handle = 0L
        if (current != 0L) OpusCodec.nativeDestroyEncoder(current)
    }
}

class OpusDecoder(
    sampleRateHz: Int = RadioConfig.SAMPLE_RATE_HZ,
    channels: Int = RadioConfig.CHANNEL_COUNT,
) : Closeable {

    @Volatile
    private var handle: Long

    init {
        OpusCodec.ensureLoaded()
        handle = OpusCodec.nativeCreateDecoder(sampleRateHz, channels)
        if (handle == 0L) throw OpusException("opus_decoder_create failed")
    }

    /**
     * Decodes one packet into [pcm] and returns the sample count, or -1 on failure.
     * A null [packet] asks libopus for one frame of packet loss concealment.
     */
    fun decode(packet: ByteArray?, length: Int, pcm: ShortArray, frameSamples: Int): Int {
        val current = handle
        if (current == 0L) return -1
        return OpusCodec.nativeDecode(current, packet, length, pcm, frameSamples)
    }

    override fun close() {
        val current = handle
        handle = 0L
        if (current != 0L) OpusCodec.nativeDestroyDecoder(current)
    }
}
