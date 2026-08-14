package com.oru.radio

/** Spec section 6.1: 'starting' | 'ready' | 'error'. */
enum class RadioStatus(val wire: String) {
    STARTING("starting"),
    READY("ready"),
    ERROR("error"),
}

data class PttButtonState(
    val configured: Boolean = false,
    val connected: Boolean = false,
    val name: String? = null,
)

/** The four-step pairing flow of spec section 9.3, as the contract amendment names it. */
enum class PttPairingPhase(val wire: String) {
    SCANNING("scanning"),
    LEARNING("learning"),
    SAVED("saved"),
}

/** `name` is never null on the wire: a nameless device is published under its address. */
data class PttCandidate(val deviceId: String, val name: String, val rssi: Int)

data class PttPairingState(
    val phase: PttPairingPhase,
    val candidates: List<PttCandidate> = emptyList(),
)

/** Exactly the RadioState of spec section 6.1, plus the amended optional pairing field. */
data class RadioState(
    val status: RadioStatus = RadioStatus.STARTING,
    val nearbyCount: Int = 0,
    val transmitting: Boolean = false,
    val receiving: Boolean = false,
    val pttButton: PttButtonState = PttButtonState(),
    /** Non-null only while a pairing session is running (contract amendment 2026-08-14). */
    val pttPairing: PttPairingState? = null,
) {
    /**
     * The bridge (P5) serializes exactly this map; the engine owns the shape. When there
     * is no pairing session the key is omitted entirely rather than sent as null, so JS
     * sees `pttPairing === undefined` and the TypeScript optional field holds.
     */
    fun toMap(): Map<String, Any?> = buildMap {
        put("status", status.wire)
        put("nearbyCount", nearbyCount)
        put("transmitting", transmitting)
        put("receiving", receiving)
        put(
            "pttButton",
            mapOf(
                "configured" to pttButton.configured,
                "connected" to pttButton.connected,
                "name" to pttButton.name,
            ),
        )
        pttPairing?.let { pairing ->
            put(
                "pttPairing",
                mapOf(
                    "phase" to pairing.phase.wire,
                    "candidates" to pairing.candidates.map { candidate ->
                        mapOf(
                            "deviceId" to candidate.deviceId,
                            "name" to candidate.name,
                            "rssi" to candidate.rssi,
                        )
                    },
                ),
            )
        }
    }
}
