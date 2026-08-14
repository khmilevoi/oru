package com.oru.radio

import org.json.JSONException
import org.json.JSONObject

/** The reliable BYTES control channel of spec section 7. */
sealed class ControlMessage {
    data class Hello(val version: Int) : ControlMessage()
    data class TxStart(val streamId: String) : ControlMessage()
    data class TxStop(val streamId: String) : ControlMessage()
}

/**
 * JSON on the wire, exactly the shapes in spec section 7. iOS and the TypeScript layer
 * implement the same three shapes; key order is irrelevant, key names are not.
 */
object ControlMessageCodec {

    fun encode(message: ControlMessage): ByteArray {
        val json = when (message) {
            is ControlMessage.Hello ->
                JSONObject().put("type", "hello").put("version", message.version)
            is ControlMessage.TxStart ->
                JSONObject().put("type", "tx-start").put("streamId", message.streamId)
            is ControlMessage.TxStop ->
                JSONObject().put("type", "tx-stop").put("streamId", message.streamId)
        }
        return json.toString().toByteArray(Charsets.UTF_8)
    }

    /** Returns null for anything this version cannot use; a peer never crashes us. */
    fun decode(bytes: ByteArray): ControlMessage? = try {
        val json = JSONObject(String(bytes, Charsets.UTF_8))
        when (json.optString("type")) {
            "hello" -> if (json.get("version") is Int) ControlMessage.Hello(json.getInt("version")) else null
            "tx-start" -> streamId(json)?.let(ControlMessage::TxStart)
            "tx-stop" -> streamId(json)?.let(ControlMessage::TxStop)
            else -> null
        }
    } catch (e: JSONException) {
        null
    }

    private fun streamId(json: JSONObject): String? =
        json.optString("streamId").takeIf { it.isNotEmpty() }
}
