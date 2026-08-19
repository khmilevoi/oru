package com.oru.radio

import android.media.AudioDeviceInfo
import android.media.AudioManager

/**
 * The §10 fake `AudioManager` facade: an in-memory platform whose every observable is a
 * public field, so a test states the world and then asserts the calls the controller made.
 */
class FakeAudioManagerFacade : AudioManagerFacade {

    var listener: AudioFacadeListener? = null
    var started = false
    var stopped = false

    /** The world. Mutate through [connect] / [disconnect] so the callback fires too. */
    val devices = mutableListOf<RouteDevice>()

    var hfpAddresses: List<String>? = emptyList()

    // Named differently from the interface method it backs: a property named `mode`
    // generates a synthetic `setMode(Int)` setter whose erased JVM signature clashes with
    // the explicit override below (same pattern as `capturedFailureListener` in FakeAudioIo).
    var currentMode: Int = AudioManager.MODE_NORMAL
    val modeSets = mutableListOf<Int>()

    /** False for the OEM stacks whose `setMode` silently does not take effect. */
    var modeFollowsSet = true

    var communicationDevice: RouteDevice? = null
    var acceptsCommunicationDevice = true

    /** When false, an accepted selection is not echoed back through the listener. */
    var confirmsCommunicationDevice = true

    val communicationDeviceSelections = mutableListOf<RouteDevice>()
    var communicationDeviceClears = 0

    val voiceLinkStarts = mutableListOf<RouteDevice>()
    var voiceLinkStops = 0

    /** Ground truth for [isVoiceLinkConnected] — deliberately independent of the callbacks. */
    var voiceLinkConnected = false

    var focusGranted = true
    var focusRequests = 0
    var focusAbandons = 0

    var musicActive = false
    val grantTones = mutableListOf<ModePolicy.Profile>()

    override fun start(listener: AudioFacadeListener) {
        this.listener = listener
        started = true
    }

    override fun stop() {
        listener = null
        stopped = true
    }

    override fun devices(): List<RouteDevice> = devices.toList()

    override fun availableCommunicationDevices(): List<RouteDevice> =
        devices.filter { it.isSink || it.isSource }

    override fun currentCommunicationDevice(): RouteDevice? = communicationDevice

    override fun connectedHfpAddresses(): List<String>? = hfpAddresses

    override fun mode(): Int = currentMode

    override fun setMode(mode: Int) {
        modeSets.add(mode)
        if (!modeFollowsSet) return
        currentMode = mode
        listener?.onModeChanged(mode)
    }

    override fun setCommunicationDevice(device: RouteDevice): Boolean {
        communicationDeviceSelections.add(device)
        if (!acceptsCommunicationDevice) return false
        communicationDevice = device
        if (confirmsCommunicationDevice) listener?.onCommunicationDeviceChanged(device)
        return true
    }

    override fun clearCommunicationDevice() {
        communicationDeviceClears++
        communicationDevice = null
    }

    override fun startVoiceLink(device: RouteDevice) {
        voiceLinkStarts.add(device)
    }

    override fun stopVoiceLink() {
        voiceLinkStops++
        voiceLinkConnected = false
    }

    override fun isVoiceLinkConnected(device: RouteDevice): Boolean = voiceLinkConnected

    override fun requestTransientDuckFocus(): Boolean {
        focusRequests++
        return focusGranted
    }

    override fun abandonFocus() {
        focusAbandons++
    }

    override fun isMusicActive(): Boolean = musicActive

    override fun playGrantTone(profile: ModePolicy.Profile) {
        grantTones.add(profile)
    }

    // --- world manipulation ---------------------------------------------------------------

    fun connect(vararg added: RouteDevice) {
        devices.addAll(added)
        listener?.onDevicesChanged(added.toList(), emptyList())
    }

    fun disconnect(vararg removed: RouteDevice) {
        devices.removeAll(removed.toSet())
        if (removed.any { it.id == communicationDevice?.id }) communicationDevice = null
        listener?.onDevicesChanged(emptyList(), removed.toList())
    }

    /** The platform's own view changed — a clear, a replacement, or our own confirmation. */
    fun platformCommunicationDevice(device: RouteDevice?) {
        communicationDevice = device
        listener?.onCommunicationDeviceChanged(device)
    }

    fun voiceLink(state: VoiceLinkState) {
        voiceLinkConnected = state == VoiceLinkState.CONNECTED
        listener?.onVoiceLinkStateChanged(state)
    }

    fun otherAudio(active: Boolean) {
        musicActive = active
        listener?.onOtherAudioActiveChanged(active)
    }

    fun becomingNoisy() {
        listener?.onBecomingNoisy()
    }
}

class RecordingRouteListener : AudioRouteListener {
    val routes = mutableListOf<AudioRoute>()
    val grants = mutableListOf<ModePolicy.MicSource>()

    override fun onAudioRouteChanged(route: AudioRoute) {
        routes.add(route)
    }

    override fun onCaptureGranted(mic: ModePolicy.MicSource) {
        grants.add(mic)
    }

    val last: AudioRoute get() = routes.last()
}

class RecordingRouteLogger : RouteLogger {
    val lines = mutableListOf<String>()

    override fun log(line: String) {
        lines.add(line)
    }
}

/** The device fixtures every controller test shares. */
object TestDevices {
    val speaker = RouteDevice(1, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "", "speaker", false, true)
    val phoneMic = RouteDevice(2, AudioDeviceInfo.TYPE_BUILTIN_MIC, "", "mic", true, false)

    const val BT_ADDRESS = "AA:BB:CC:DD:EE:FF"

    val btMic = RouteDevice(
        id = 7,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        address = BT_ADDRESS,
        productName = "Buds Pro",
        isSource = true,
        isSink = true,
    )
    val btMedia = RouteDevice(
        id = 8,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        address = BT_ADDRESS,
        productName = "Buds Pro",
        isSource = false,
        isSink = true,
    )
    val wiredHeadset = RouteDevice(
        id = 3,
        type = AudioDeviceInfo.TYPE_WIRED_HEADSET,
        address = "",
        productName = "Wired headset",
        isSource = true,
        isSink = true,
    )
    val wiredHeadphones = RouteDevice(
        id = 5,
        type = AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        address = "",
        productName = "Wired headphones",
        isSource = false,
        isSink = true,
    )
    val watch = RouteDevice(
        id = 12,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        address = "99:99:99:99:99:99",
        productName = "Galaxy Watch5",
        isSource = true,
        isSink = true,
    )
}
