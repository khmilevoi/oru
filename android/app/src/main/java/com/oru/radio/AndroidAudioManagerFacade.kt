package com.oru.radio

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.provider.Settings
import android.util.Log

/** The `RouteLogger` used in production: one tagged logcat line per event. */
class AndroidRouteLogger : RouteLogger {
    override fun log(line: String) {
        Log.i("OruRadio", line)
    }
}

/**
 * The one Android implementation of [AudioManagerFacade].
 *
 * [handler] is the route thread's handler: every platform listener that accepts an executor
 * or handler is registered against it, so callbacks arrive on the same thread the controller
 * runs on and the controller's own re-post is a no-op hop rather than a thread switch.
 */
class AndroidAudioManagerFacade(
    context: Context,
    private val handler: Handler,
) : AudioManagerFacade {

    private companion object {
        const val TAG = "OruRadio"
        const val TONE_MS = 150
        const val TONE_RELEASE_DELAY_MS = 400L
        const val TONE_VOLUME = 80
    }

    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(AudioManager::class.java)

    private var listener: AudioFacadeListener? = null
    private var focusRequest: AudioFocusRequest? = null

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var headsetProxy: BluetoothProfile? = null

    private var deviceCallback: AudioDeviceCallback? = null
    private var noisyReceiver: BroadcastReceiver? = null
    private var scoReceiver: BroadcastReceiver? = null
    private var commDeviceListener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private var modeListener: AudioManager.OnModeChangedListener? = null
    private var playbackCallback: AudioManager.AudioPlaybackCallback? = null
    private var otherAudioActive = false

    /**
     * The grant tone's generator, live between [playGrantTone] and its release -- by the
     * delayed release below on the normal path, or immediately by [stop] when the session
     * ends first. Tracked so [stop] can honour the interface's "releases the grant tone"
     * contract instead of leaving it to the delayed release alone.
     */
    private var toneGenerator: ToneGenerator? = null

    private val headsetProfileListener = object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            if (profile != BluetoothProfile.HEADSET) return
            headsetProxy = proxy
            // A mic that was skipped as unverifiable may now pass cross-validation.
            listener?.onDevicesChanged(emptyList(), emptyList())
        }

        override fun onServiceDisconnected(profile: Int) {
            if (profile != BluetoothProfile.HEADSET) return
            headsetProxy = null
            listener?.onDevicesChanged(emptyList(), emptyList())
        }
    }

    override fun start(listener: AudioFacadeListener) {
        if (this.listener != null) return
        this.listener = listener
        val manager = audioManager ?: return

        requestHeadsetProxy()

        val devices = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
                listener.onDevicesChanged(addedDevices.map(::toRouteDevice), emptyList())
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
                listener.onDevicesChanged(emptyList(), removedDevices.map(::toRouteDevice))
            }
        }
        deviceCallback = devices
        manager.registerAudioDeviceCallback(devices, handler)

        noisyReceiver = register(AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
            listener.onBecomingNoisy()
        }
        @Suppress("DEPRECATION")
        scoReceiver = register(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED) { intent ->
            listener.onVoiceLinkStateChanged(
                when (
                    intent.getIntExtra(
                        AudioManager.EXTRA_SCO_AUDIO_STATE,
                        AudioManager.SCO_AUDIO_STATE_ERROR,
                    )
                ) {
                    AudioManager.SCO_AUDIO_STATE_CONNECTED -> VoiceLinkState.CONNECTED
                    AudioManager.SCO_AUDIO_STATE_CONNECTING -> VoiceLinkState.CONNECTING
                    AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> VoiceLinkState.DISCONNECTED
                    else -> VoiceLinkState.ERROR
                },
            )
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val comm = AudioManager.OnCommunicationDeviceChangedListener { device ->
                listener.onCommunicationDeviceChanged(device?.let(::toRouteDevice))
            }
            commDeviceListener = comm
            manager.addOnCommunicationDeviceChangedListener(handler::post, comm)

            val mode = AudioManager.OnModeChangedListener { value -> listener.onModeChanged(value) }
            modeListener = mode
            manager.addOnModeChangedListener(handler::post, mode)
        }

        val playback = object : AudioManager.AudioPlaybackCallback() {
            override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) {
                publishOtherAudio(configs.any(::isForeignMedia))
            }
        }
        playbackCallback = playback
        manager.registerAudioPlaybackCallback(playback, handler)
        // Seeded once, before the radio plays anything of its own: after this the callback is
        // the only source of truth, because our own MEDIA-profile track counts as music to
        // isMusicActive() and would latch MEDIA forever.
        publishOtherAudio(manager.isMusicActive)
    }

    override fun stop() {
        val manager = audioManager
        listener = null
        deviceCallback?.let { manager?.unregisterAudioDeviceCallback(it) }
        deviceCallback = null
        noisyReceiver?.let(appContext::unregisterReceiver)
        noisyReceiver = null
        scoReceiver?.let(appContext::unregisterReceiver)
        scoReceiver = null
        playbackCallback?.let { manager?.unregisterAudioPlaybackCallback(it) }
        playbackCallback = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            commDeviceListener?.let { manager?.removeOnCommunicationDeviceChangedListener(it) }
            modeListener?.let { manager?.removeOnModeChangedListener(it) }
        }
        commDeviceListener = null
        modeListener = null
        headsetProxy?.let { proxy ->
            bluetoothAdapter?.closeProfileProxy(BluetoothProfile.HEADSET, proxy)
        }
        headsetProxy = null
        bluetoothAdapter = null
        localNames = null
        otherAudioActive = false
        // Honours the interface's "and releases the grant tone": clearing the field here, not
        // just releasing it, is what stops the delayed release below from releasing it again.
        toneGenerator?.release()
        toneGenerator = null
    }

    override fun devices(): List<RouteDevice> {
        val manager = audioManager ?: return emptyList()
        return (
            manager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList() +
                manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
            )
            .distinctBy { it.id }
            .map(::toRouteDevice)
    }

    /**
     * Cached because it is read on every evaluation pass while the device list flaps, and each
     * of the three sources behind it is a binder call. Cleared by [stop] so a phone renamed
     * between sessions is picked up on the next one.
     */
    private var localNames: List<String>? = null

    override fun localDeviceNames(): List<String> =
        localNames ?: buildLocalDeviceNames().also { localNames = it }

    override fun availableCommunicationDevices(): List<RouteDevice> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return emptyList()
        return audioManager?.availableCommunicationDevices.orEmpty().map(::toRouteDevice)
    }

    override fun currentCommunicationDevice(): RouteDevice? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        return audioManager?.communicationDevice?.let(::toRouteDevice)
    }

    override fun connectedHfpAddresses(): List<String>? {
        val proxy = headsetProxy ?: return null
        return try {
            proxy.connectedDevices.map { it.address }
        } catch (error: SecurityException) {
            Log.w(TAG, "route: BLUETOOTH_CONNECT denied; cannot enumerate HFP devices", error)
            emptyList()
        }
    }

    override fun mode(): Int = audioManager?.mode ?: AudioManager.MODE_NORMAL

    override fun setMode(mode: Int) {
        audioManager?.mode = mode
    }

    override fun setCommunicationDevice(device: RouteDevice): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val manager = audioManager ?: return false
        // setCommunicationDevice only accepts objects from this list, and the input-side
        // AudioDeviceInfo is a different object with the same address.
        val target = manager.availableCommunicationDevices.firstOrNull { it.id == device.id }
            ?: manager.availableCommunicationDevices.firstOrNull {
                it.address == device.address && it.type == device.type
            }
            ?: manager.availableCommunicationDevices.firstOrNull { it.type == device.type }
            ?: return false
        return try {
            manager.setCommunicationDevice(target)
        } catch (error: SecurityException) {
            // A mid-session BLUETOOTH_CONNECT revocation must not throw off the route thread:
            // `false` reads to the controller as "the platform refused it", which spends an
            // establish attempt and demotes the device after the second -- a per-device
            // failure, not a whole-session one.
            Log.w(TAG, "route: BLUETOOTH_CONNECT denied; cannot set communication device", error)
            false
        }
    }

    override fun clearCommunicationDevice() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        try {
            audioManager?.clearCommunicationDevice()
        } catch (error: SecurityException) {
            Log.w(TAG, "route: BLUETOOTH_CONNECT denied; cannot clear communication device", error)
        }
    }

    @Suppress("DEPRECATION")
    override fun startVoiceLink(device: RouteDevice) {
        val manager = audioManager ?: return
        try {
            manager.startBluetoothSco()
            manager.isBluetoothScoOn = true
        } catch (error: SecurityException) {
            // The link never comes up; the establish timeout fails the device on its own.
            Log.w(TAG, "route: BLUETOOTH_CONNECT denied; cannot start the voice link", error)
        }
    }

    @Suppress("DEPRECATION")
    override fun stopVoiceLink() {
        val manager = audioManager ?: return
        try {
            manager.isBluetoothScoOn = false
            manager.stopBluetoothSco()
        } catch (error: SecurityException) {
            Log.w(TAG, "route: BLUETOOTH_CONNECT denied; cannot stop the voice link", error)
        }
    }

    @Suppress("DEPRECATION")
    override fun isVoiceLinkConnected(device: RouteDevice): Boolean {
        val proxy = headsetProxy as? BluetoothHeadset
        if (proxy != null) {
            val match = try {
                proxy.connectedDevices.firstOrNull { it.address.equals(device.address, true) }
            } catch (error: SecurityException) {
                null
            }
            if (match != null) {
                return try {
                    proxy.isAudioConnected(match)
                } catch (error: SecurityException) {
                    audioManager?.isBluetoothScoOn == true
                }
            }
        }
        return audioManager?.isBluetoothScoOn == true
    }

    override fun requestTransientDuckFocus(): Boolean {
        val manager = audioManager ?: return false
        if (focusRequest != null) return true
        val request = AudioFocusRequest
            .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener({ change ->
                Log.v(TAG, "route: audio focus changed -> $change")
            }, handler)
            .build()
        val granted = manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (granted) focusRequest = request
        return granted
    }

    override fun abandonFocus() {
        val manager = audioManager ?: return
        focusRequest?.let(manager::abandonAudioFocusRequest)
        focusRequest = null
    }

    override fun isMusicActive(): Boolean = audioManager?.isMusicActive == true

    @Suppress("DEPRECATION")
    override fun playGrantTone(profile: ModePolicy.Profile) {
        val stream = when (profile) {
            ModePolicy.Profile.VOICE -> AudioManager.STREAM_VOICE_CALL
            ModePolicy.Profile.MEDIA -> AudioManager.STREAM_MUSIC
        }
        val generator = try {
            ToneGenerator(stream, TONE_VOLUME)
        } catch (error: RuntimeException) {
            Log.w(TAG, "route: no tone generator", error)
            return
        }
        // A grant tone inside the previous one's release window supersedes it: release the
        // outgoing generator here rather than leaving it to a delayed callback whose identity
        // check will now skip it. Its tone is already done or being cut off by this one.
        toneGenerator?.release()
        toneGenerator = generator
        generator.startTone(ToneGenerator.TONE_PROP_BEEP, TONE_MS)
        handler.postDelayed(
            {
                // Only release through this path if [generator] is still the current one:
                // identity, not just non-null, because `stop()` may already have released and
                // cleared it, or a later grant tone may have replaced it with a newer generator
                // that has its own delayed release pending. Either way, releasing here would
                // release the wrong instance -- once twice, once too early.
                if (toneGenerator === generator) {
                    generator.release()
                    toneGenerator = null
                }
            },
            TONE_RELEASE_DELAY_MS,
        )
    }

    // --- internals -----------------------------------------------------------------------

    /**
     * All three names are collected, not just the adapter's: `BluetoothAdapter.getName()`
     * needs `BLUETOOTH_CONNECT` and returns null before the adapter is up, the user-visible
     * device name is what most stacks copy onto the duplicate entry, and `Build.MODEL` is what
     * ColorOS used on the 2026-08-19 session (`CPH2747`).
     */
    private fun buildLocalDeviceNames(): List<String> = buildList {
        Build.MODEL?.let(::add)
        try {
            bluetoothAdapter?.name?.let(::add)
        } catch (error: SecurityException) {
            Log.w(TAG, "route: BLUETOOTH_CONNECT denied; cannot read the adapter name", error)
        }
        runCatching {
            Settings.Global.getString(appContext.contentResolver, Settings.Global.DEVICE_NAME)
        }.getOrNull()?.let(::add)
    }.filter { it.isNotBlank() }.distinct()

    private fun publishOtherAudio(active: Boolean) {
        if (active == otherAudioActive) return
        otherAudioActive = active
        listener?.onOtherAudioActiveChanged(active)
    }

    /**
     * §6: "filtering out our own player and non-media usages". Our own two players use
     * `USAGE_VOICE_COMMUNICATION` (VOICE) and `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` (MEDIA),
     * so counting only genuine media usages excludes them without a uid check — which is not
     * public API.
     */
    private fun isForeignMedia(config: AudioPlaybackConfiguration): Boolean =
        when (config.audioAttributes.usage) {
            AudioAttributes.USAGE_MEDIA,
            AudioAttributes.USAGE_GAME,
            AudioAttributes.USAGE_UNKNOWN,
            -> true
            else -> false
        }

    private fun register(action: String, onReceive: (Intent) -> Unit): BroadcastReceiver {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == action) onReceive(intent)
            }
        }
        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appContext.registerReceiver(receiver, filter, null, handler, Context.RECEIVER_NOT_EXPORTED)
        } else {
            appContext.registerReceiver(receiver, filter, null, handler)
        }
        return receiver
    }

    private fun requestHeadsetProxy() {
        val adapter = appContext.getSystemService(BluetoothManager::class.java)?.adapter
        bluetoothAdapter = adapter ?: return
        try {
            adapter.getProfileProxy(appContext, headsetProfileListener, BluetoothProfile.HEADSET)
        } catch (error: SecurityException) {
            Log.w(TAG, "route: HFP profile proxy refused", error)
        }
    }

    private fun toRouteDevice(device: AudioDeviceInfo): RouteDevice = RouteDevice(
        id = device.id,
        type = device.type,
        address = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) device.address else "",
        productName = device.productName?.toString().orEmpty(),
        isSource = device.isSource,
        isSink = device.isSink,
    )
}
