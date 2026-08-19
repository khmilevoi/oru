package com.oru.radio

import android.media.AudioDeviceInfo

/**
 * One audio device as the route controller sees it.
 *
 * `android.media.AudioDeviceInfo` has no public constructor and is a framework stub on the
 * unit-test classpath, so nothing above [AudioManagerFacade] ever touches one: the facade
 * maps them into this value type on the way in, and every §6 decision is made against it.
 *
 * A Bluetooth Classic headset surfaces as two devices — a `TYPE_BLUETOOTH_SCO` entry that is
 * both source and sink, and a `TYPE_BLUETOOTH_A2DP` sink — with the same address.
 */
data class RouteDevice(
    val id: Int,
    /** One of `AudioDeviceInfo.TYPE_*`. */
    val type: Int,
    /** The hardware address, or "" below API 28 and for devices that report none. */
    val address: String,
    val productName: String,
    val isSource: Boolean,
    val isSink: Boolean,
) {
    /**
     * Stable identity for the per-episode attempt counters of §6. Type plus address, so a
     * headset that reconnects with a new `id` is still recognised as the same device.
     */
    val key: String get() = "$type|$address"
}

/** The SCO / communication-device link state, as §6 recovery reasons about it. */
enum class VoiceLinkState { CONNECTING, CONNECTED, DISCONNECTED, ERROR }

/**
 * Spec §8's `audioRoute`, as the engine publishes it. `mode` is the *effective* profile the
 * radio is running — never the user's `audioMode` pin.
 */
data class AudioRoute(
    val kind: Kind = Kind.SPEAKER,
    /** Bluetooth routes only; absent rather than empty when the device reports no name. */
    val label: String? = null,
    val mode: ModePolicy.Profile = ModePolicy.Profile.VOICE,
) {
    enum class Kind(val wire: String) {
        SPEAKER("speaker"),
        WIRED("wired"),
        BLUETOOTH("bluetooth"),
        USB("usb"),
    }

    /**
     * §8 makes `label` optional, not nullable, so an absent label is an absent key — the
     * same rule `pttButton.name` follows on this bridge.
     */
    fun toMap(): Map<String, Any?> = buildMap {
        put("kind", kind.wire)
        label?.let { put("label", it) }
        put("mode", mode.wire())
    }
}

/**
 * The §8 wire spellings of the two merged-P1 enums.
 *
 * They are extensions here rather than properties on `ModePolicy` because `ModePolicy.kt` is
 * the shared contract with iOS and this plan may not edit it: a wire spelling is Android
 * bridge business, not policy business.
 */
fun ModePolicy.Profile.wire(): String = when (this) {
    ModePolicy.Profile.VOICE -> "voice"
    ModePolicy.Profile.MEDIA -> "media"
}

fun ModePolicy.AudioMode.wire(): String = when (this) {
    ModePolicy.AudioMode.AUTO -> "auto"
    ModePolicy.AudioMode.VOICE -> "voice"
    ModePolicy.AudioMode.MEDIA -> "media"
}

/** Anything unrecognised — including a missing stored value — is §8's `auto` default. */
fun audioModeFromWire(value: String?): ModePolicy.AudioMode = when (value) {
    "voice" -> ModePolicy.AudioMode.VOICE
    "media" -> ModePolicy.AudioMode.MEDIA
    else -> ModePolicy.AudioMode.AUTO
}

/**
 * Every §6 device decision, as pure functions over a [RouteDevice] list.
 */
object RoutePicker {

    /**
     * §6: "devices whose `productName` contains ` Watch` are filtered out (Galaxy Watch
     * hijack)". The leading space is deliberate — it is what keeps a "Watchtower" speaker
     * out of the filter.
     */
    const val WATCH_MARKER = " Watch"

    fun isWatch(device: RouteDevice): Boolean = device.productName.contains(WATCH_MARKER)

    /**
     * True when a Bluetooth entry reports one of the phone's own names ([localNames] — see
     * [AudioManagerFacade.localDeviceNames]).
     *
     * On the 2026-08-19 hardware session a single `OPENEAR Bone G1` connecting made ColorOS
     * enumerate two extra entries called `CPH2747`, the phone's own model name, and one of
     * them then carried the whole route: the indicator showed the phone instead of the
     * headset. Such an entry is the stack's own duplicate, so it loses every tie to a
     * differently named sibling and never labels the route while one exists. A name only
     * breaks ties: it never reorders the §6 priority table, because on that same stack the
     * phone's name is what the headset's LE Audio side reports, and demoting LE below A2DP
     * would move real audio off the better path over a naming quirk.
     *
     * It is *not* filtered out: on ColorOS the zero-MAC SCO entry named after the phone is the
     * only representation of the headset's microphone there is (see [isTrustedBluetoothInput]),
     * so dropping it would cost the mic path entirely. Non-Bluetooth devices are exempt —
     * built-in speakers and mics are routinely named after the phone and are recognised by
     * type, never by name.
     */
    fun isSelfNamed(device: RouteDevice, localNames: Collection<String>): Boolean {
        if (kindOf(device) != AudioRoute.Kind.BLUETOOTH) return false
        val name = device.productName.trim()
        if (name.isEmpty()) return false
        return localNames.any { it.trim().equals(name, ignoreCase = true) }
    }

    /**
     * §6 priority, input-capable: BT SCO / BLE headset > wired headset > USB headset. LE
     * Audio ranks above BT Classic inside the Bluetooth class because it carries a mic
     * without suspending media (§4).
     */
    private fun inputPreference(type: Int): Int = when (type) {
        AudioDeviceInfo.TYPE_BLE_HEADSET -> 4
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 3
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> 2
        AudioDeviceInfo.TYPE_USB_HEADSET -> 1
        else -> -1
    }

    /** Output-capable externals, most preferred first. Everything else is the loudspeaker. */
    private fun outputPreference(type: Int): Int = when (type) {
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER,
        AudioDeviceInfo.TYPE_BLE_BROADCAST,
        -> 5
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        -> 4
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        -> 3
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_ACCESSORY,
        -> 2
        AudioDeviceInfo.TYPE_HEARING_AID -> 1
        else -> -1
    }

    /**
     * Cross-validation against the Bluetooth stack (§11 keeps it): a Bluetooth input is only
     * trusted as a mic when the HFP proxy actually has a device connected.
     *
     * [hfpAddresses] is null while the async profile proxy has not arrived — unverifiable,
     * therefore untrusted. Wired and USB inputs bypass the check.
     */
    fun isTrustedBluetoothInput(device: RouteDevice, hfpAddresses: List<String>?): Boolean {
        val bluetooth = device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
            device.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        if (!bluetooth) return true
        val connected = hfpAddresses ?: return false
        val address = device.address
        val zeroMac = address.isBlank() || address == "00:00:00:00:00:00"
        if (zeroMac) {
            // ColorOS's single zero-MAC SCO input is the OEM's only representation of a
            // connected headset, and a true phantom (total silence) when none is connected.
            return device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO && connected.isNotEmpty()
        }
        return connected.any { it.equals(address, ignoreCase = true) }
    }

    /**
     * The input-capable externals worth trying, most preferred first. A [isSelfNamed]
     * duplicate sorts behind its equally ranked siblings, so it is picked only when it is all
     * there is.
     */
    fun inputCandidates(
        devices: List<RouteDevice>,
        hfpAddresses: List<String>?,
        localNames: Collection<String> = emptyList(),
    ): List<RouteDevice> = devices
        .filter { it.isSource && inputPreference(it.type) >= 0 }
        .filterNot(::isWatch)
        .filter { isTrustedBluetoothInput(it, hfpAddresses) }
        .sortedWith(
            compareByDescending<RouteDevice> { inputPreference(it.type) }
                .thenBy { if (isSelfNamed(it, localNames)) 1 else 0 },
        )

    /** The external sink playback lands on, or null for the loudspeaker. */
    fun outputDevice(
        devices: List<RouteDevice>,
        localNames: Collection<String> = emptyList(),
    ): RouteDevice? = devices
        .filter { it.isSink && outputPreference(it.type) >= 0 }
        .filterNot(::isWatch)
        // maxWith keeps the first of equal elements, so a self-named duplicate only wins when
        // no sibling of the same rank is there to beat it.
        .maxWithOrNull(
            compareBy<RouteDevice> { outputPreference(it.type) }
                .thenBy { if (isSelfNamed(it, localNames)) 0 else 1 },
        )

    fun kindOf(device: RouteDevice?): AudioRoute.Kind = when (device?.type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER,
        AudioDeviceInfo.TYPE_BLE_BROADCAST,
        AudioDeviceInfo.TYPE_HEARING_AID,
        -> AudioRoute.Kind.BLUETOOTH
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        -> AudioRoute.Kind.WIRED
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_ACCESSORY,
        -> AudioRoute.Kind.USB
        else -> AudioRoute.Kind.SPEAKER
    }

    /**
     * §8's `label`. [devices] and [localNames] are the enumeration the route was picked from
     * and the phone's own names: when the routed device is one of the stack's [isSelfNamed]
     * duplicates, the indicator names the best differently named Bluetooth sibling instead —
     * the accessory the user is actually wearing. With no such sibling the duplicate's own
     * name is still better than nothing.
     */
    fun labelOf(
        device: RouteDevice?,
        devices: List<RouteDevice> = emptyList(),
        localNames: Collection<String> = emptyList(),
    ): String? {
        if (device == null || kindOf(device) != AudioRoute.Kind.BLUETOOTH) return null
        val name = if (isSelfNamed(device, localNames)) {
            val sibling = devices
                .filter { kindOf(it) == AudioRoute.Kind.BLUETOOTH }
                .filterNot(::isWatch)
                .filterNot { isSelfNamed(it, localNames) }
                .filter { it.productName.isNotBlank() }
                .maxByOrNull { outputPreference(it.type) }
            sibling?.productName ?: device.productName
        } else {
            device.productName
        }
        return name.trim().ifBlank { null }
    }

    /**
     * §7: only Bluetooth Classic has the HFP/A2DP conflict. Speaker, wired, USB and LE Audio
     * need no raise, and the mode policy is inert on them.
     */
    fun requiresVoiceLink(device: RouteDevice?): Boolean =
        device?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
}
