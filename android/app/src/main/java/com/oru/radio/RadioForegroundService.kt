package com.oru.radio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.oru.R

/**
 * Spec section 10.1: the radio lives in a foreground service with the microphone and
 * connectedDevice types, so it keeps running while the RN Activity is destroyed and while
 * the screen is locked.
 */
class RadioForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.oru.radio.action.START"
        const val ACTION_STOP = "com.oru.radio.action.STOP"
        private const val CHANNEL_ID = "oru.radio"
        private const val NOTIFICATION_ID = 1
        private const val ROUTE_MIC_TO_HEADSET = true
        private const val TAG = "OruRadio"

        /**
         * How many times a platform-cleared communication device is re-asserted before the
         * radio gives up on that headset and falls back to the output-only row. Keeps a
         * OEM stack that keeps rerouting from turning into an applyAudioMode loop.
         */
        private const val MAX_COMMUNICATION_DEVICE_REASSERTS = 3

        /** Retry budget while waiting for audioManager.mode to reach the requested mode. */
        private const val MODE_RETRY_LIMIT = 3
        private const val MODE_RETRY_DELAY_MS = 100L

        /**
         * Backstop on route establishment: if the platform has not confirmed our
         * setCommunicationDevice selection through OnCommunicationDeviceChangedListener
         * within this window, the headset is treated as failed (blacklist + output-only
         * fallback). The re-assert logic still runs first; this catches the OEM stacks
         * that neither confirm nor clear, which the listener alone can never see.
         */
        private const val ROUTE_ESTABLISH_TIMEOUT_MS = 6_000L
    }

    private var scheduler: HandlerScheduler? = null
    private var engine: RadioEngine? = null

    /** Adapter the HFP proxy was requested from; kept to close the proxy in onDestroy. */
    private var bluetoothAdapter: BluetoothAdapter? = null

    /**
     * The Bluetooth stack's HEADSET (HFP) profile proxy, delivered asynchronously by
     * [headsetProfileListener] and cached for the service's lifetime. Used by
     * [findExternalMicrophone] to cross-validate Bluetooth input candidates against the
     * devices the stack actually has connected on HFP -- the zero-MAC phantom filter
     * alone is a half-measure, because a phantom could carry a plausible address. Null
     * while the proxy has not arrived (treated as "no HFP headset": output-only row).
     */
    private var bluetoothHeadsetProxy: BluetoothProfile? = null

    /**
     * Profile-proxy callbacks are dispatched on the main thread (BluetoothProfileConnector
     * posts to the main handler), the same thread [applyAudioMode] runs on, so plain field
     * assignment is safe. When the proxy arrives after the radio already routed, the
     * policy is re-evaluated: a Bluetooth mic that was skipped as unverifiable may now
     * pass validation (or a phantom that slipped through is now rejected).
     */
    private val headsetProfileListener = object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            if (profile != BluetoothProfile.HEADSET) return
            bluetoothHeadsetProxy = proxy
            Log.v(TAG, "route: HFP profile proxy connected")
            if (communicationModeWanted) applyAudioMode()
        }

        override fun onServiceDisconnected(profile: Int) {
            if (profile != BluetoothProfile.HEADSET) return
            bluetoothHeadsetProxy = null
            Log.v(TAG, "route: HFP profile proxy disconnected")
            if (communicationModeWanted) applyAudioMode()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        requestHeadsetProfileProxy()

        val scheduler = HandlerScheduler()
        val engine = RadioEngine(
            transport = NearbyManager(this, Build.MODEL ?: "Android", scheduler),
            audio = AudioEngine(),
            ptt = PttManager(
                SharedPreferencesPttBindingStore(this),
                AndroidPttDriverFactory(this),
                scheduler,
            ),
            scheduler = scheduler,
        )
        // A task that throws its way out of the engine's single thread would otherwise
        // unwind Looper.loop() and kill the process; HandlerScheduler catches it, and this
        // is where it comes out: the one unrecoverable-failure path of spec section 13.
        scheduler.setUncaughtHandler { error ->
            engine.failFromHost("engine_task_failed", error.message ?: error.javaClass.simpleName)
        }
        this.scheduler = scheduler
        this.engine = engine
        RadioController.attach(engine)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // A service started with startForegroundService() must call startForeground()
            // shortly after, even on the path that immediately tears it back down again --
            // this is what makes ACTION_STOP the real stop path instead of dead code.
            startForegroundWithTypes()
            engine?.stopRadio()
            setCommunicationMode(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!startForegroundWithTypes()) {
            // Android 14+ refuses a `microphone` foreground service without RECORD_AUDIO
            // (and a `connectedDevice` one without the Bluetooth permissions) by throwing,
            // which would kill the service outright. Runtime permission sequencing is P7's
            // work; degrading to a reported failure and a clean stop is this service's.
            engine?.failFromHost(
                "foreground_service_denied",
                "The radio may not run in the foreground; are the microphone and Bluetooth permissions granted?",
            )
            stopSelf()
            return START_NOT_STICKY
        }
        setCommunicationMode(true)
        engine?.startRadio()
        Log.i(TAG, "radio service started")
        return START_STICKY
    }

    override fun onDestroy() {
        engine?.stopRadio()
        RadioController.detach()
        setCommunicationMode(false)
        closeHeadsetProfileProxy()
        // Shut the thread down from inside itself, so it runs after stopRadio's work.
        scheduler?.let { current -> current.execute { current.shutdown() } }
        engine = null
        scheduler = null
        Log.i(TAG, "radio service stopped")
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.radio_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun requestHeadsetProfileProxy() {
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        bluetoothAdapter = adapter
        if (adapter == null) {
            Log.w(TAG, "route: no Bluetooth adapter; HFP cross-validation unavailable")
            return
        }
        val requested = try {
            adapter.getProfileProxy(this, headsetProfileListener, BluetoothProfile.HEADSET)
        } catch (error: SecurityException) {
            Log.w(TAG, "route: HFP profile proxy refused", error)
            false
        }
        if (!requested) Log.w(TAG, "route: HFP profile proxy request rejected; Bluetooth mics will be skipped")
    }

    private fun closeHeadsetProfileProxy() {
        bluetoothHeadsetProxy?.let { proxy ->
            bluetoothAdapter?.closeProfileProxy(BluetoothProfile.HEADSET, proxy)
        }
        bluetoothHeadsetProxy = null
        bluetoothAdapter = null
    }

    /**
     * The devices the Bluetooth stack reports connected on the HEADSET (HFP) profile, or
     * null while the async proxy has not arrived. An empty list and null both mean "no
     * verifiable HFP mic"; the distinction is only logged. connectedDevices needs
     * BLUETOOTH_CONNECT (declared in the manifest, granted for Nearby); if it is somehow
     * revoked the SecurityException degrades to "none".
     */
    private fun connectedHfpDevices(): List<BluetoothDevice>? {
        val proxy = bluetoothHeadsetProxy ?: return null
        return try {
            proxy.connectedDevices
        } catch (error: SecurityException) {
            Log.w(TAG, "route: BLUETOOTH_CONNECT denied; cannot enumerate HFP devices", error)
            emptyList()
        }
    }

    private fun hfpDeviceLabel(device: BluetoothDevice): String {
        val name = try {
            device.name
        } catch (error: SecurityException) {
            null
        }
        return "${name ?: "unknown"}/${device.address}"
    }

    /**
     * Returns false when the platform refused the foreground service. From Android 14 a
     * `microphone` type without RECORD_AUDIO granted, or `connectedDevice` without the
     * Bluetooth permissions, throws `SecurityException`; `ForegroundServiceStartNotAllowedException`
     * and the missing/invalid-type exceptions are `IllegalStateException`s of the same kind.
     * Every one of them would otherwise propagate out of `onStartCommand` and take the
     * service down with no state, no error event and no log.
     */
    private fun startForegroundWithTypes(): Boolean {
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.radio_notification_title))
            .setContentText(getString(R.string.radio_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_speakerphone)
            .setOngoing(true)
            .build()

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (error: SecurityException) {
            Log.e(TAG, "the foreground service was refused", error)
            false
        } catch (error: IllegalStateException) {
            Log.e(TAG, "the foreground service was refused", error)
            false
        }
    }

    /**
     * Communication mode is what makes VOICE_COMMUNICATION capture and
     * USAGE_VOICE_COMMUNICATION playback share one echo-cancelled route, and it is what
     * puts the volume keys on the call stream while the radio is live.
     *
     * Routing policy, re-evaluated by [deviceCallback] on every connect/disconnect so
     * plugging a headset in or pulling it out re-routes live:
     *
     *  - An external *input-capable* device is present (Bluetooth headset, LE Audio
     *    headset, wired or USB headset with a mic): MODE_IN_COMMUNICATION, and the
     *    headset is made the communication device, so BOTH the VOICE_COMMUNICATION
     *    capture and the USAGE_VOICE_COMMUNICATION playback run through it. On API 31+
     *    that is `setCommunicationDevice`; below S the Bluetooth case falls back to
     *    `startBluetoothSco()` + `setBluetoothScoOn(true)` (wired/USB headsets route by
     *    default in communication mode and need no explicit selection). Note what SCO
     *    means for fidelity: the whole audio path narrows to the headset's telephony
     *    profile -- typically 16 kHz mSBC wideband -- which happens to match the radio's
     *    16 kHz wire format anyway; LE Audio (TYPE_BLE_HEADSET) does better than that.
     *  - Only an *output-capable* external device is present (A2DP-only earbuds, wired
     *    headphones without a mic): those cannot provide a mic, and in
     *    MODE_IN_COMMUNICATION the audio policy would drop A2DP/LE from the route and
     *    land playback on the loudspeaker. So the radio stays in MODE_NORMAL, playback
     *    follows the system's default (media) route into the headphones, and capture
     *    stays on the phone's mic. Trade-off: no system echo cancellation and volume
     *    keys stay on media -- acceptable, because the sound is in the listener's ears,
     *    not in the mic's field.
     *  - No external device: MODE_IN_COMMUNICATION on the built-in route (loudspeaker +
     *    phone mic), as before.
     *
     * Transitions are idempotent: the mode, the selected communication device and the
     * SCO state are each compared against what is already in force before touching them,
     * so a callback storm does not churn the audio policy.
     */
    private var communicationModeWanted = false

    /** Device id currently selected via setCommunicationDevice (API 31+), or null. */
    private var communicationDeviceId: Int? = null

    /**
     * Whether the legacy SCO establishment (startBluetoothSco/setBluetoothScoOn) is in
     * force. Used both by the pre-S branch (where it is the only mechanism) and, on S+,
     * alongside setCommunicationDevice for TYPE_BLUETOOTH_SCO routes: on OEM stacks that
     * still run SCO establishment in the Bluetooth stack rather than the audio framework
     * (`audio.scoManagedByAudio=false`, the ColorOS/Android 16 case), a platform-accepted
     * setCommunicationDevice never raises the SCO link by itself, so both calls are made
     * -- they are complementary, the documented pattern for stacks mid-AMSCO-transition
     * (cf. Zello's "Legacy Bluetooth" toggle).
     */
    private var scoStarted = false

    /** True once ACTION_SCO_AUDIO_STATE_UPDATED reported SCO_AUDIO_STATE_CONNECTED. */
    private var scoConfirmed = false

    /**
     * The communication-device candidate the legacy SCO establishment was started for
     * (so an SCO_AUDIO_STATE_ERROR can fail the right headset), or null when legacy SCO
     * is not in force.
     */
    private var scoRouteTarget: AudioDeviceInfo? = null

    /** Registered with the communication-mode lifecycle to track the SCO link state. */
    private var scoStateReceiver: BroadcastReceiver? = null

    /** Audio focus held for the radio session (voice-communication attributes), or null. */
    private var audioFocusRequest: AudioFocusRequest? = null

    /** Registered while the radio is live on API 31+, to see the platform's routing calls. */
    private var commDeviceListener: AudioManager.OnCommunicationDeviceChangedListener? = null

    /**
     * Headsets (as [deviceKey]s) on which communication routing failed: setCommunicationDevice
     * returned false, the device was missing from availableCommunicationDevices, or the
     * platform dropped our selection [MAX_COMMUNICATION_DEVICE_REASSERTS] times. They are
     * skipped by [findExternalMicrophone], so the policy lands on the output-only row
     * (MODE_NORMAL, playback over the headset's media route, phone mic) instead of leaving
     * audio on the earpiece or loudspeaker -- the failure the 2026-08-17 ColorOS session hit.
     * An entry is forgotten when the device disconnects, so a reconnect gets a fresh attempt.
     */
    private val failedHeadsetKeys = mutableSetOf<String>()

    /** Re-asserts done since the platform last confirmed our communication device. */
    private var reassertCount = 0

    /**
     * Pending [ROUTE_ESTABLISH_TIMEOUT_MS] backstop, armed each time setCommunicationDevice
     * is accepted and cancelled when the platform confirms the device, when the selection
     * is cleared, or when the headset is failed. Non-null only while a confirmation is
     * outstanding.
     */
    private var routeEstablishTimeout: Runnable? = null

    /** Delayed retries done while waiting for audioManager.mode to reach the requested mode. */
    private var modeRetryCount = 0

    private val mainHandler = Handler(Looper.getMainLooper())

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            Log.v(TAG, "route: devices added ${addedDevices.joinToString(prefix = "[", postfix = "]") { describeDevice(it) }}")
            reassertCount = 0
            applyAudioMode()
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            Log.v(TAG, "route: devices removed ${removedDevices.joinToString(prefix = "[", postfix = "]") { describeDevice(it) }}")
            // A disconnected headset gets a clean slate: reconnecting retries the
            // communication profile even if it failed during the previous connection.
            removedDevices.forEach { device -> failedHeadsetKeys.remove(deviceKey(device)) }
            applyAudioMode()
        }
    }

    private fun setCommunicationMode(active: Boolean) {
        val audioManager = getSystemService(AudioManager::class.java) ?: return
        if (active == communicationModeWanted) {
            if (active) applyAudioMode()
            return
        }
        communicationModeWanted = active
        if (active) {
            // Ordering per the platform's self-managed-call guidance: hold audio focus with
            // voice-communication attributes BEFORE touching the mode or the communication
            // device, so the audio policy treats this app as the active communication client
            // when it arbitrates the Bluetooth profile switch.
            requestRadioAudioFocus(audioManager)
            registerCommunicationDeviceListener(audioManager)
            registerScoStateReceiver()
            // Registration immediately delivers the current device list to
            // onAudioDevicesAdded, which applies the mode for the route present at start.
            audioManager.registerAudioDeviceCallback(deviceCallback, null)
        } else {
            mainHandler.removeCallbacksAndMessages(null)
            routeEstablishTimeout = null
            audioManager.unregisterAudioDeviceCallback(deviceCallback)
            unregisterCommunicationDeviceListener(audioManager)
            unregisterScoStateReceiver()
            failedHeadsetKeys.clear()
            reassertCount = 0
            modeRetryCount = 0
            applyAudioMode()
            // applyAudioMode -> routeCommunicationTo(null) already stops legacy SCO, but
            // repeat it here so the stop path holds even if a mode retry short-circuited
            // the routing step. stopLegacySco is idempotent.
            stopLegacySco(audioManager)
            abandonRadioAudioFocus(audioManager)
        }
    }

    private fun applyAudioMode() {
        val audioManager = getSystemService(AudioManager::class.java) ?: return
        val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
        val outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        Log.v(TAG, "route: inputs=${inputs.joinToString(prefix = "[", postfix = "]") { describeDevice(it) }}")
        Log.v(TAG, "route: outputs=${outputs.joinToString(prefix = "[", postfix = "]") { describeDevice(it) }}")
        val headset: AudioDeviceInfo? =
            if (ROUTE_MIC_TO_HEADSET && communicationModeWanted) findExternalMicrophone(audioManager) else null
        val mode: Int
        val policy: String
        when {
            !communicationModeWanted -> {
                mode = AudioManager.MODE_NORMAL
                policy = "inactive (MODE_NORMAL, default route)"
            }
            headset != null -> {
                mode = AudioManager.MODE_IN_COMMUNICATION
                policy = "headset-mic (MODE_IN_COMMUNICATION via headset)"
            }
            hasExternalPlaybackDevice(audioManager) -> {
                mode = AudioManager.MODE_NORMAL
                policy = "output-only (MODE_NORMAL, external playback, phone mic)"
            }
            else -> {
                mode = AudioManager.MODE_IN_COMMUNICATION
                policy = "built-in (MODE_IN_COMMUNICATION, loudspeaker + phone mic)"
            }
        }
        Log.v(
            TAG,
            "route: policy=$policy headset=${describeDevice(headset)} " +
                "requestedMode=${modeName(mode)} previousMode=${modeName(audioManager.mode)}",
        )
        if (audioManager.mode != mode) audioManager.mode = mode
        val actualMode = audioManager.mode
        Log.v(TAG, "route: mode after set: requested=${modeName(mode)} actual=${modeName(actualMode)}")
        if (actualMode != mode) {
            // Selecting the communication device while the mode has not actually landed is a
            // known way to lose the headset from the route (the selection is cleared on mode
            // change, and the Bluetooth profile switch races the policy update), so wait for
            // the mode before calling setCommunicationDevice.
            if (modeRetryCount < MODE_RETRY_LIMIT) {
                modeRetryCount++
                Log.w(
                    TAG,
                    "route: mode did not take effect, retrying in $MODE_RETRY_DELAY_MS ms " +
                        "($modeRetryCount/$MODE_RETRY_LIMIT)",
                )
                mainHandler.postDelayed(::applyAudioMode, MODE_RETRY_DELAY_MS)
                return
            }
            Log.e(TAG, "route: mode still ${modeName(actualMode)} after $MODE_RETRY_LIMIT retries; routing anyway")
        }
        modeRetryCount = 0
        routeCommunicationTo(audioManager, headset)
    }

    /**
     * The input-capable external device the radio should run through, or null to stay on
     * the built-in mic. When several are attached the physically plugged ones win (a
     * cable in the jack is a deliberate act, and it matches the system's own default
     * preference), then LE Audio over classic SCO. Headsets in [failedHeadsetKeys] are
     * skipped, which is what turns a communication-routing failure into the output-only
     * row instead of a retry loop.
     */
    private fun findExternalMicrophone(audioManager: AudioManager): AudioDeviceInfo? =
        audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .filter { device -> micPreference(device.type) >= 0 }
            .filter { device -> isTrustedBluetoothMicrophone(device) }
            .filter { device ->
                val failed = deviceKey(device) in failedHeadsetKeys
                if (failed) {
                    Log.v(TAG, "route: skipping ${describeDevice(device)}: communication routing failed on it earlier")
                }
                !failed
            }
            .maxByOrNull { device -> micPreference(device.type) }

    /**
     * Cross-validation against the Bluetooth stack (the WebRTC/audioswitch pattern): a
     * Bluetooth input is only trusted as a mic if the stack actually has a device
     * connected on the HEADSET (HFP) profile. Wired/USB inputs bypass it. Two cases:
     *
     *  - A real address: it must be among the connected HFP devices' addresses. This
     *    catches phantoms that carry a plausible address.
     *  - A zero/blank MAC on a TYPE_BLUETOOTH_SCO input: on ColorOS the audio framework
     *    enumerates a single SCO input named after the phone itself with a zeroed MAC.
     *    When NO HFP headset is connected that entry is a true phantom (routing to it is
     *    total silence), so it is rejected. But when the HFP proxy reports a connected
     *    headset, the same zero-MAC entry is this OEM's only representation of that
     *    headset's SCO input, so it is accepted as a proxy for it (2026-08-17 hardware
     *    session: OPENEAR Bone G1 with the HFP toggle on still only ever surfaces the
     *    zero-MAC CPH2747-named input).
     *
     * Trade-off: an LE Audio headset that is not dual-mode (no HFP leg) is skipped,
     * landing on the output-only row -- safe, if suboptimal, until an LE_AUDIO proxy
     * check is added.
     */
    private fun isTrustedBluetoothMicrophone(device: AudioDeviceInfo): Boolean {
        val bluetooth = device.type in intArrayOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
        )
        if (!bluetooth) return true
        val connected = connectedHfpDevices()
        val address = deviceAddress(device)
        val zeroMac = address.isBlank() || address == "00:00:00:00:00:00"
        if (zeroMac) {
            if (device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO && !connected.isNullOrEmpty()) {
                Log.i(
                    TAG,
                    "route: zero-MAC SCO accepted as proxy for ${hfpDeviceLabel(connected.first())}" +
                        if (connected.size > 1) " (+${connected.size - 1} more HFP devices)" else "",
                )
                return true
            }
            Log.v(
                TAG,
                "route: skipping ${describeDevice(device)}: placeholder Bluetooth input with no real address and " +
                    if (connected == null) "HFP profile proxy not ready yet" else "no connected HFP device",
            )
            return false
        }
        val verified = connected != null && connected.any { it.address.equals(address, ignoreCase = true) }
        if (!verified) {
            Log.v(
                TAG,
                "route: skipping ${describeDevice(device)}: " +
                    if (connected == null) "HFP profile proxy not ready yet"
                    else "not among connected HFP devices ${connected.map { it.address.uppercase() }}",
            )
        }
        return verified
    }

    private fun micPreference(type: Int): Int = when (type) {
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> 4
        AudioDeviceInfo.TYPE_USB_HEADSET -> 3
        AudioDeviceInfo.TYPE_BLE_HEADSET -> 2
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 1
        else -> -1
    }

    /**
     * Makes [headset] (an *input* AudioDeviceInfo, or null for the built-in route) the
     * communication device, idempotently. On API 31+ the matching entry from
     * [AudioManager.getAvailableCommunicationDevices] is selected -- matched by address
     * then type, because setCommunicationDevice only accepts devices from that list and
     * the input-side AudioDeviceInfo is a different object. For TYPE_BLUETOOTH_SCO
     * targets the legacy establishment ([startLegacySco]) is ALWAYS run alongside it,
     * because on stacks with `scoManagedByAudio=false` setCommunicationDevice never
     * raises the SCO link. Below S only Bluetooth needs an explicit action (SCO); wired
     * and USB headsets route by default in MODE_IN_COMMUNICATION.
     */
    private fun routeCommunicationTo(audioManager: AudioManager, headset: AudioDeviceInfo?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val candidates = audioManager.availableCommunicationDevices
            Log.v(
                TAG,
                "route: availableCommunicationDevices=" +
                    candidates.joinToString(prefix = "[", postfix = "]") { describeDevice(it) } +
                    " current=${describeDevice(audioManager.communicationDevice)}",
            )
            if (headset == null) {
                stopLegacySco(audioManager)
                if (communicationDeviceId != null) {
                    // Null the id before the call so our own clear is not mistaken for a
                    // platform-initiated drop by onCommunicationDeviceChanged.
                    communicationDeviceId = null
                    cancelRouteEstablishTimeout()
                    audioManager.clearCommunicationDevice()
                    Log.v(TAG, "route: clearCommunicationDevice(), readBack=${describeDevice(audioManager.communicationDevice)}")
                }
                return
            }
            val target = candidates.firstOrNull { it.address == headset.address && it.type == headset.type }
                ?: candidates.firstOrNull { it.type == headset.type }
            if (target == null) {
                Log.e(TAG, "route: ${describeDevice(headset)} is not an available communication device")
                failHeadsetRouting(audioManager, headset)
                return
            }
            if (target.type != AudioDeviceInfo.TYPE_BLUETOOTH_SCO) stopLegacySco(audioManager)
            if (communicationDeviceId == target.id && audioManager.communicationDevice?.id == target.id) {
                Log.v(TAG, "route: communication device already ${describeDevice(target)}")
                if (target.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) startLegacySco(audioManager, target)
                // The platform's view matches ours; an outstanding backstop is satisfied
                // unless the route is SCO and the SCO link itself has not come up yet.
                if (!scoPending()) cancelRouteEstablishTimeout()
                return
            }
            val accepted = audioManager.setCommunicationDevice(target)
            Log.v(
                TAG,
                "route: setCommunicationDevice(${describeDevice(target)}) -> $accepted, " +
                    "readBack=${describeDevice(audioManager.communicationDevice)}",
            )
            if (accepted) {
                communicationDeviceId = target.id
                // On SCO routes the two establishment paths are complementary: on stacks
                // where the audio framework owns SCO (`scoManagedByAudio=true`) the
                // setCommunicationDevice call raises the link and legacy SCO is a no-op,
                // and on stacks where the Bluetooth stack still owns it the legacy call
                // is the only thing that does (the 2026-08-17 total-silence failure).
                if (target.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) startLegacySco(audioManager, target)
                armRouteEstablishTimeout(audioManager, target)
            } else {
                failHeadsetRouting(audioManager, target)
            }
        } else {
            val wantSco = headset != null &&
                headset.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            if (wantSco) startLegacySco(audioManager, headset!!) else stopLegacySco(audioManager)
        }
    }

    /** Idempotent legacy SCO establishment; [target] is remembered for error handling. */
    @Suppress("DEPRECATION")
    private fun startLegacySco(audioManager: AudioManager, target: AudioDeviceInfo) {
        if (scoStarted) return
        Log.v(TAG, "route: legacy SCO start (startBluetoothSco + setBluetoothScoOn) for ${describeDevice(target)}")
        scoStarted = true
        scoConfirmed = false
        scoRouteTarget = target
        audioManager.startBluetoothSco()
        audioManager.isBluetoothScoOn = true
    }

    /** Idempotent legacy SCO teardown, shared by the fallback, re-route and stop paths. */
    @Suppress("DEPRECATION")
    private fun stopLegacySco(audioManager: AudioManager) {
        if (!scoStarted) return
        Log.v(TAG, "route: legacy SCO stop (setBluetoothScoOn(false) + stopBluetoothSco)")
        scoStarted = false
        scoConfirmed = false
        scoRouteTarget = null
        audioManager.isBluetoothScoOn = false
        audioManager.stopBluetoothSco()
    }

    /** True while legacy SCO establishment is running but the link has not connected. */
    private fun scoPending(): Boolean = scoStarted && !scoConfirmed

    /**
     * The failure mode observed on ColorOS (2026-08-17 hardware session): switching the
     * buds into the communication profile dropped them from the app's route entirely.
     * Instead of leaving playback on the earpiece or loudspeaker, blacklist this headset
     * for the rest of its connection and re-evaluate, which lands the policy on the
     * output-only row: MODE_NORMAL, playback over the headset's media (A2DP/LE media)
     * route, capture on the phone mic. The blacklist entry is dropped when the device
     * disconnects (see [deviceCallback]), so a reconnect tries the full route again.
     */
    /**
     * The backstop of the WebRTC/audioswitch pattern: setCommunicationDevice returning
     * true only means the request was accepted, not that the route was built. If the
     * platform neither confirms nor clears our selection within
     * [ROUTE_ESTABLISH_TIMEOUT_MS], the headset is failed the same way an outright
     * rejection is. The re-assert logic ([onPlatformCommunicationDeviceChanged]) keeps
     * handling the cases the listener does see; each accepted re-assert re-arms this
     * timeout, and the re-assert cap bounds the total attempts.
     */
    private fun armRouteEstablishTimeout(audioManager: AudioManager, target: AudioDeviceInfo) {
        cancelRouteEstablishTimeout()
        val timeout = Runnable {
            routeEstablishTimeout = null
            if (!communicationModeWanted || communicationDeviceId != target.id) return@Runnable
            if (audioManager.communicationDevice?.id == target.id && !scoPending()) {
                // The route did land and only the listener event went missing; nothing to fix.
                Log.v(TAG, "route: establish timeout fired but ${describeDevice(target)} is in force; keeping it")
                return@Runnable
            }
            Log.e(
                TAG,
                "route: ${describeDevice(target)} not confirmed within ${ROUTE_ESTABLISH_TIMEOUT_MS} ms " +
                    "(now=${describeDevice(audioManager.communicationDevice)}, scoPending=${scoPending()}); " +
                    "treating as failed",
            )
            failHeadsetRouting(audioManager, target)
        }
        routeEstablishTimeout = timeout
        mainHandler.postDelayed(timeout, ROUTE_ESTABLISH_TIMEOUT_MS)
    }

    private fun cancelRouteEstablishTimeout() {
        routeEstablishTimeout?.let(mainHandler::removeCallbacks)
        routeEstablishTimeout = null
    }

    private fun failHeadsetRouting(audioManager: AudioManager, headset: AudioDeviceInfo) {
        cancelRouteEstablishTimeout()
        stopLegacySco(audioManager)
        Log.e(
            TAG,
            "route: FALLBACK: giving up on ${describeDevice(headset)} for communication " +
                "(reasserts=$reassertCount); falling back to output-only row " +
                "(MODE_NORMAL, external playback, phone mic)",
        )
        failedHeadsetKeys.add(deviceKey(headset))
        reassertCount = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && communicationDeviceId != null) {
            communicationDeviceId = null
            audioManager.clearCommunicationDevice()
        }
        applyAudioMode()
    }

    /**
     * Watches the platform's own view of the communication device (API 31+). ColorOS and
     * other OEM stacks are known to clear or replace an app's selection mid-session while
     * they arbitrate the Bluetooth profile switch; when that happens the selection is
     * re-asserted up to [MAX_COMMUNICATION_DEVICE_REASSERTS] times, then the headset is
     * given up on via [failHeadsetRouting].
     */
    private fun registerCommunicationDeviceListener(audioManager: AudioManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || commDeviceListener != null) return
        val listener = AudioManager.OnCommunicationDeviceChangedListener { device ->
            onPlatformCommunicationDeviceChanged(audioManager, device)
        }
        audioManager.addOnCommunicationDeviceChangedListener(mainExecutor, listener)
        commDeviceListener = listener
    }

    private fun unregisterCommunicationDeviceListener(audioManager: AudioManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        commDeviceListener?.let { audioManager.removeOnCommunicationDeviceChangedListener(it) }
        commDeviceListener = null
    }

    /**
     * Tracks the SCO link itself via ACTION_SCO_AUDIO_STATE_UPDATED, the only signal
     * that distinguishes "selection accepted" from "audio actually flowing" on stacks
     * where the Bluetooth stack owns SCO establishment. Registered/unregistered with the
     * communication-mode lifecycle ([setCommunicationMode]); delivery is on the main
     * thread, the same thread all routing state lives on. The broadcast is sticky, so
     * registration immediately reports the current state (typically DISCONNECTED, which
     * is only logged).
     */
    @Suppress("DEPRECATION")
    private fun registerScoStateReceiver() {
        if (scoStateReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED) return
                onScoAudioStateChanged(
                    intent.getIntExtra(
                        AudioManager.EXTRA_SCO_AUDIO_STATE,
                        AudioManager.SCO_AUDIO_STATE_ERROR,
                    ),
                )
            }
        }
        val filter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(receiver, filter)
        }
        scoStateReceiver = receiver
    }

    private fun unregisterScoStateReceiver() {
        scoStateReceiver?.let(::unregisterReceiver)
        scoStateReceiver = null
    }

    @Suppress("DEPRECATION")
    private fun onScoAudioStateChanged(state: Int) {
        Log.v(
            TAG,
            "route: SCO audio state -> ${scoStateName(state)} " +
                "(scoStarted=$scoStarted, scoConfirmed=$scoConfirmed, target=${describeDevice(scoRouteTarget)})",
        )
        if (!communicationModeWanted) return
        val audioManager = getSystemService(AudioManager::class.java) ?: return
        when (state) {
            AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                scoConfirmed = true
                reassertCount = 0
                Log.i(TAG, "route: SCO link established; treating as route confirmation")
                cancelRouteEstablishTimeout()
            }
            AudioManager.SCO_AUDIO_STATE_ERROR -> {
                val target = scoRouteTarget
                if (target != null) {
                    Log.e(TAG, "route: SCO establishment error for ${describeDevice(target)}")
                    failHeadsetRouting(audioManager, target)
                }
            }
            AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
                if (scoConfirmed) Log.w(TAG, "route: SCO link dropped after being established")
                scoConfirmed = false
            }
            // SCO_AUDIO_STATE_CONNECTING: progress only, already logged above.
        }
    }

    @Suppress("DEPRECATION")
    private fun scoStateName(state: Int): String = when (state) {
        AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> "DISCONNECTED"
        AudioManager.SCO_AUDIO_STATE_CONNECTED -> "CONNECTED"
        AudioManager.SCO_AUDIO_STATE_CONNECTING -> "CONNECTING"
        AudioManager.SCO_AUDIO_STATE_ERROR -> "ERROR"
        else -> "STATE_$state"
    }

    private fun onPlatformCommunicationDeviceChanged(audioManager: AudioManager, device: AudioDeviceInfo?) {
        Log.v(TAG, "route: onCommunicationDeviceChanged -> ${describeDevice(device)}")
        if (!communicationModeWanted) return
        val wantedId = communicationDeviceId ?: return
        if (device != null && device.id == wantedId) {
            reassertCount = 0
            if (scoPending()) {
                // On SCO routes the platform accepting the device selection is exactly the
                // state the 2026-08-17 total-silence session got stuck in: confirmed
                // selection, no SCO link. Keep the establish timeout armed until
                // ACTION_SCO_AUDIO_STATE_UPDATED reports CONNECTED.
                Log.v(TAG, "route: platform confirmed communication device id=$wantedId; awaiting SCO link before treating the route as established")
            } else {
                Log.v(TAG, "route: platform confirmed communication device id=$wantedId")
                cancelRouteEstablishTimeout()
            }
            return
        }
        if (reassertCount < MAX_COMMUNICATION_DEVICE_REASSERTS) {
            reassertCount++
            Log.w(
                TAG,
                "route: platform ${if (device == null) "cleared" else "replaced"} our communication " +
                    "device (now=${describeDevice(device)}); re-asserting " +
                    "($reassertCount/$MAX_COMMUNICATION_DEVICE_REASSERTS)",
            )
            applyAudioMode()
        } else {
            communicationDeviceId = null
            val headset = findExternalMicrophone(audioManager)
            if (headset != null) failHeadsetRouting(audioManager, headset) else applyAudioMode()
        }
    }

    private fun requestRadioAudioFocus(audioManager: AudioManager) {
        if (audioFocusRequest != null) return
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener { change ->
                Log.v(TAG, "route: audio focus changed -> ${focusChangeName(change)}")
            }
            .build()
        val result = audioManager.requestAudioFocus(request)
        Log.v(TAG, "route: requestAudioFocus(GAIN, USAGE_VOICE_COMMUNICATION) -> ${focusResultName(result)}")
        if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) audioFocusRequest = request
    }

    private fun abandonRadioAudioFocus(audioManager: AudioManager) {
        audioFocusRequest?.let { request ->
            audioManager.abandonAudioFocusRequest(request)
            Log.v(TAG, "route: abandoned audio focus")
        }
        audioFocusRequest = null
    }

    /** Stable identity for the blacklist: type plus hardware address. */
    private fun deviceKey(device: AudioDeviceInfo): String = "${device.type}|${deviceAddress(device)}"

    private fun deviceAddress(device: AudioDeviceInfo): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) device.address else ""

    private fun describeDevice(device: AudioDeviceInfo?): String =
        if (device == null) "null"
        else "${deviceTypeName(device.type)}(id=${device.id}, addr=${deviceAddress(device)}, name=${device.productName})"

    private fun deviceTypeName(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "BUILTIN_EARPIECE"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> "BUILTIN_SPEAKER_SAFE"
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "BUILTIN_MIC"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "WIRED_HEADPHONES"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB_DEVICE"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB_HEADSET"
        AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB_ACCESSORY"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE_HEADSET"
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> "BLE_SPEAKER"
        AudioDeviceInfo.TYPE_BLE_BROADCAST -> "BLE_BROADCAST"
        AudioDeviceInfo.TYPE_HEARING_AID -> "HEARING_AID"
        AudioDeviceInfo.TYPE_TELEPHONY -> "TELEPHONY"
        AudioDeviceInfo.TYPE_FM_TUNER -> "FM_TUNER"
        AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "REMOTE_SUBMIX"
        AudioDeviceInfo.TYPE_HDMI -> "HDMI"
        AudioDeviceInfo.TYPE_DOCK -> "DOCK"
        else -> "TYPE_$type"
    }

    private fun modeName(mode: Int): String = when (mode) {
        AudioManager.MODE_NORMAL -> "MODE_NORMAL"
        AudioManager.MODE_RINGTONE -> "MODE_RINGTONE"
        AudioManager.MODE_IN_CALL -> "MODE_IN_CALL"
        AudioManager.MODE_IN_COMMUNICATION -> "MODE_IN_COMMUNICATION"
        AudioManager.MODE_CALL_SCREENING -> "MODE_CALL_SCREENING"
        else -> "MODE_$mode"
    }

    private fun focusResultName(result: Int): String = when (result) {
        AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> "GRANTED"
        AudioManager.AUDIOFOCUS_REQUEST_FAILED -> "FAILED"
        AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> "DELAYED"
        else -> "RESULT_$result"
    }

    private fun focusChangeName(change: Int): String = when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> "GAIN"
        AudioManager.AUDIOFOCUS_LOSS -> "LOSS"
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "LOSS_TRANSIENT"
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "LOSS_TRANSIENT_CAN_DUCK"
        else -> "CHANGE_$change"
    }

    private fun hasExternalPlaybackDevice(audioManager: AudioManager): Boolean =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { device ->
            when (device.type) {
                AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                AudioDeviceInfo.TYPE_BLE_HEADSET,
                AudioDeviceInfo.TYPE_BLE_SPEAKER,
                AudioDeviceInfo.TYPE_BLE_BROADCAST,
                AudioDeviceInfo.TYPE_WIRED_HEADSET,
                AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                AudioDeviceInfo.TYPE_USB_HEADSET,
                AudioDeviceInfo.TYPE_HEARING_AID,
                -> true
                else -> false
            }
        }
}
