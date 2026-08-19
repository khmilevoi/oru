package com.oru.radio

/**
 * The whole platform surface [AudioRouteController] is allowed to touch (§6: "`AudioManager`
 * is accessed through an injected facade so the controller is unit-testable").
 *
 * Implementations carry no decisions: every method is a direct platform call or a direct
 * enumeration. The decisions live in [RoutePicker] and [AudioRouteController].
 *
 * Threading: every method is called from the controller's `audio-route` thread. Callbacks
 * may arrive on any thread — the controller re-posts them.
 */
interface AudioManagerFacade {

    /** Registers every platform listener of §6. Idempotent. */
    fun start(listener: AudioFacadeListener)

    /** Unregisters everything [start] registered and releases the grant tone. Idempotent. */
    fun stop()

    /** Inputs and outputs, deduplicated by device id. */
    fun devices(): List<RouteDevice>

    /**
     * The names this phone answers to — its Bluetooth adapter name, its user-visible device
     * name and `Build.MODEL`. §6 device selection uses them to recognise the duplicate
     * entries an OEM stack enumerates under the phone's *own* name when a headset connects
     * (2026-08-19 hardware session: `added=[CPH2747, CPH2747]` next to `OPENEAR Bone G1`).
     */
    fun localDeviceNames(): List<String>

    /** `AudioManager.getAvailableCommunicationDevices()`, empty below API 31. */
    fun availableCommunicationDevices(): List<RouteDevice>

    /** `AudioManager.getCommunicationDevice()`, null below API 31. */
    fun currentCommunicationDevice(): RouteDevice?

    /**
     * Addresses the Bluetooth stack reports connected on HFP, or null while the async
     * profile proxy has not arrived (§11 keeps this cross-validation).
     */
    fun connectedHfpAddresses(): List<String>?

    fun mode(): Int

    fun setMode(mode: Int)

    /** True when the platform accepted the selection — not that the route was built. */
    fun setCommunicationDevice(device: RouteDevice): Boolean

    fun clearCommunicationDevice()

    /**
     * Legacy SCO establishment (`startBluetoothSco` + `setBluetoothScoOn(true)`), run
     * alongside [setCommunicationDevice] on Bluetooth Classic targets: on stacks with
     * `scoManagedByAudio=false` the selection alone never raises the link.
     */
    fun startVoiceLink(device: RouteDevice)

    /** Idempotent legacy SCO teardown. */
    fun stopVoiceLink()

    /**
     * §6's ground truth, re-checked before a timeout is declared: is SCO audio actually
     * connected to [device]? Implemented against `BluetoothHeadset.isAudioConnected`, with
     * `AudioManager.isBluetoothScoOn` as the fallback.
     */
    fun isVoiceLinkConnected(device: RouteDevice): Boolean

    /** §6/D6: `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`. True when granted. */
    fun requestTransientDuckFocus(): Boolean

    fun abandonFocus()

    /** `AudioManager.isMusicActive()`, used only to seed other-audio state at start. */
    fun isMusicActive(): Boolean

    /** D2's talk-permit tone, played on [profile]'s path. */
    fun playGrantTone(profile: ModePolicy.Profile)
}

/**
 * Platform events, as §6 names them. Every method may be called from any thread.
 */
interface AudioFacadeListener {
    /**
     * One device-list change. `added` drives the ~500 ms debounce of §6 (the list flaps
     * during BT profile negotiation); `removed` is always handled immediately.
     */
    fun onDevicesChanged(added: List<RouteDevice>, removed: List<RouteDevice>)

    /** `ACTION_AUDIO_BECOMING_NOISY`: the §6 fast path to the loudspeaker. */
    fun onBecomingNoisy()

    /** `OnCommunicationDeviceChangedListener`: the platform's own view of our selection. */
    fun onCommunicationDeviceChanged(device: RouteDevice?)

    /** `OnModeChangedListener` — §6 replaces the 3 × 100 ms mode polling with this. */
    fun onModeChanged(mode: Int)

    /** `ACTION_SCO_AUDIO_STATE_UPDATED`, mapped onto [VoiceLinkState]. */
    fun onVoiceLinkStateChanged(state: VoiceLinkState)

    /** §6 other-audio detection, already filtered to media usages that are not ours. */
    fun onOtherAudioActiveChanged(active: Boolean)
}

/**
 * Where the §10 instrumentation lines go. A seam rather than a direct `Log` call so a test
 * can assert that a switch carries its measured latency.
 */
fun interface RouteLogger {
    fun log(line: String)
}
