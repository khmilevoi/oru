/*
 * The entire native surface of the radio: create/encode/decode/destroy. No audio
 * policy lives here -- frame sizes, bitrate and sample rate are passed in from
 * RadioConfig.kt so section 8's "codec parameters live in a single config" holds.
 *
 * Method names must stay in sync with com.oru.radio.OpusCodec.
 */
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <opus.h>

#define ORU_FN(name) Java_com_oru_radio_OpusCodec_##name

JNIEXPORT jlong JNICALL
ORU_FN(nativeCreateEncoder)(JNIEnv *env, jclass clazz, jint sampleRate, jint channels, jint bitrate) {
    (void) env;
    (void) clazz;
    int error = OPUS_OK;
    OpusEncoder *encoder = opus_encoder_create(sampleRate, channels, OPUS_APPLICATION_VOIP, &error);
    if (error != OPUS_OK || encoder == NULL) {
        return 0;
    }
    opus_encoder_ctl(encoder, OPUS_SET_BITRATE(bitrate));
    opus_encoder_ctl(encoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
    opus_encoder_ctl(encoder, OPUS_SET_INBAND_FEC(1));
    opus_encoder_ctl(encoder, OPUS_SET_PACKET_LOSS_PERC(10));
    return (jlong) (intptr_t) encoder;
}

JNIEXPORT jint JNICALL
ORU_FN(nativeEncode)(JNIEnv *env, jclass clazz, jlong handle, jshortArray pcm, jint frameSamples, jbyteArray out) {
    (void) clazz;
    OpusEncoder *encoder = (OpusEncoder *) (intptr_t) handle;
    if (encoder == NULL) {
        return -1;
    }
    jshort *pcmBuffer = (*env)->GetShortArrayElements(env, pcm, NULL);
    jbyte *outBuffer = (*env)->GetByteArrayElements(env, out, NULL);
    jint capacity = (*env)->GetArrayLength(env, out);

    int written = opus_encode(encoder, (const opus_int16 *) pcmBuffer, frameSamples,
                              (unsigned char *) outBuffer, capacity);

    (*env)->ReleaseShortArrayElements(env, pcm, pcmBuffer, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, out, outBuffer, 0);
    return written < 0 ? -1 : written;
}

JNIEXPORT void JNICALL
ORU_FN(nativeDestroyEncoder)(JNIEnv *env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    OpusEncoder *encoder = (OpusEncoder *) (intptr_t) handle;
    if (encoder != NULL) {
        opus_encoder_destroy(encoder);
    }
}

JNIEXPORT jlong JNICALL
ORU_FN(nativeCreateDecoder)(JNIEnv *env, jclass clazz, jint sampleRate, jint channels) {
    (void) env;
    (void) clazz;
    int error = OPUS_OK;
    OpusDecoder *decoder = opus_decoder_create(sampleRate, channels, &error);
    if (error != OPUS_OK || decoder == NULL) {
        return 0;
    }
    return (jlong) (intptr_t) decoder;
}

/* packet == NULL asks Opus for packet loss concealment for one frame. */
JNIEXPORT jint JNICALL
ORU_FN(nativeDecode)(JNIEnv *env, jclass clazz, jlong handle, jbyteArray packet, jint length, jshortArray pcm, jint frameSamples) {
    (void) clazz;
    OpusDecoder *decoder = (OpusDecoder *) (intptr_t) handle;
    if (decoder == NULL) {
        return -1;
    }
    jshort *pcmBuffer = (*env)->GetShortArrayElements(env, pcm, NULL);
    jbyte *packetBuffer = packet == NULL ? NULL : (*env)->GetByteArrayElements(env, packet, NULL);

    int samples = opus_decode(decoder,
                              packetBuffer == NULL ? NULL : (const unsigned char *) packetBuffer,
                              packetBuffer == NULL ? 0 : length,
                              (opus_int16 *) pcmBuffer, frameSamples,
                              packetBuffer == NULL ? 1 : 0);

    if (packetBuffer != NULL) {
        (*env)->ReleaseByteArrayElements(env, packet, packetBuffer, JNI_ABORT);
    }
    (*env)->ReleaseShortArrayElements(env, pcm, pcmBuffer, 0);
    return samples < 0 ? -1 : samples;
}

JNIEXPORT void JNICALL
ORU_FN(nativeDestroyDecoder)(JNIEnv *env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    OpusDecoder *decoder = (OpusDecoder *) (intptr_t) handle;
    if (decoder != NULL) {
        opus_decoder_destroy(decoder);
    }
}
