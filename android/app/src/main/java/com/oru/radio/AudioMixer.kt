package com.oru.radio

/**
 * Spec section 7: there is no floor control, so a receiver mixes concurrent transmitters.
 * Summing with saturation is the whole policy; the practical design limit is 2 speakers.
 */
object AudioMixer {

    fun mix(sources: List<ShortArray>, out: ShortArray) {
        for (index in out.indices) {
            var sum = 0
            for (source in sources) {
                if (index < source.size) sum += source[index]
            }
            out[index] = when {
                sum > Short.MAX_VALUE -> Short.MAX_VALUE
                sum < Short.MIN_VALUE -> Short.MIN_VALUE
                else -> sum.toShort()
            }
        }
    }
}
