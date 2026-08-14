package com.oru.radio

import org.json.JSONException
import org.json.JSONObject

/** Spec section 9.2. Hex values are uppercase with no separators, e.g. "01", "0100". */
sealed class PttBinding {

    data class Ble(
        val deviceId: String,
        val serviceUuid: String,
        val characteristicUuid: String,
        val pressedValue: String,
        val releasedValue: String,
    ) : PttBinding()

    data class Hid(val keyCode: Int) : PttBinding()
}

/** The result of the learning flow (spec section 6.1 PttConfiguration). */
data class PttConfiguration(val name: String, val binding: PttBinding)

object PttBindingCodec {

    private const val HEX_DIGITS = "0123456789ABCDEF"

    fun encode(configuration: PttConfiguration): String {
        val binding = JSONObject()
        when (val value = configuration.binding) {
            is PttBinding.Ble -> binding
                .put("type", "ble")
                .put("deviceId", value.deviceId)
                .put("serviceUuid", value.serviceUuid)
                .put("characteristicUuid", value.characteristicUuid)
                .put("pressedValue", value.pressedValue)
                .put("releasedValue", value.releasedValue)
            is PttBinding.Hid -> binding
                .put("type", "hid")
                .put("keyCode", value.keyCode)
        }
        return JSONObject()
            .put("name", configuration.name)
            .put("binding", binding)
            .toString()
    }

    /** Returns null for anything unusable; a corrupt preference must not crash the radio. */
    fun decode(raw: String?): PttConfiguration? {
        if (raw.isNullOrEmpty()) return null
        return try {
            val json = JSONObject(raw)
            val binding = json.optJSONObject("binding") ?: return null
            val parsed = when (binding.optString("type")) {
                "ble" -> PttBinding.Ble(
                    deviceId = binding.string("deviceId") ?: return null,
                    serviceUuid = binding.string("serviceUuid") ?: return null,
                    characteristicUuid = binding.string("characteristicUuid") ?: return null,
                    pressedValue = binding.string("pressedValue") ?: return null,
                    releasedValue = binding.string("releasedValue") ?: return null,
                )
                "hid" -> if (binding.get("keyCode") is Int) {
                    PttBinding.Hid(binding.getInt("keyCode"))
                } else {
                    return null
                }
                else -> return null
            }
            PttConfiguration(json.string("name") ?: "PTT", parsed)
        } catch (e: JSONException) {
            null
        }
    }

    fun toHex(bytes: ByteArray): String {
        val text = StringBuilder(bytes.size * 2)
        for (byte in bytes) {
            val value = byte.toInt() and 0xFF
            text.append(HEX_DIGITS[value ushr 4]).append(HEX_DIGITS[value and 0x0F])
        }
        return text.toString()
    }

    fun fromHex(hex: String): ByteArray? {
        if (hex.length % 2 != 0) return null
        val bytes = ByteArray(hex.length / 2)
        for (index in bytes.indices) {
            val high = Character.digit(hex[index * 2], 16)
            val low = Character.digit(hex[index * 2 + 1], 16)
            if (high < 0 || low < 0) return null
            bytes[index] = ((high shl 4) or low).toByte()
        }
        return bytes
    }

    private fun JSONObject.string(key: String): String? = optString(key).takeIf { it.isNotEmpty() }
}
