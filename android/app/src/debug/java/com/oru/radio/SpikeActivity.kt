package com.oru.radio

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Phase 0 (spec section 15) without React Native. This is an Activity rather than a
 * receiver because Android refuses to start a microphone foreground service from the
 * background: launching a visible component is what makes the start legal.
 *
 *   adb shell am start -n com.oru/com.oru.radio.SpikeActivity --es cmd start
 *
 * The adb contract is unchanged (`cmd` extras still work, SpikeReceiver still works), but
 * the activity now also carries a minimal debug UI instead of finishing immediately:
 * live state header, start/stop, a press-and-hold PTT button, and the whole BLE pairing
 * flow (scan / candidate pick / learning banner / saved / forget). Staying in the
 * foreground is not just convenience — Android 8.1+ returns nothing for unfiltered BLE
 * scans from apps with no visible activity, so the pairing scan only works while this
 * window is up.
 *
 * The "keys" command keeps its old meaning: log every key code the window receives,
 * which is how a HID button's key code is discovered.
 */
/**
 * Prints every state change and every error to logcat for the duration of the spike. The
 * activity's UI subscribes through the very same path ([RadioController.addListener]) with
 * its own listener; this one keeps the logcat record intact.
 */
object SpikeLogger : RadioEngineListener {

    override fun onStateChanged(state: RadioState) {
        Log.i("OruRadio", "spike: state=${state.toMap()}")
    }

    override fun onError(code: String, message: String) {
        Log.w("OruRadio", "spike: error $code $message")
    }
}

class SpikeActivity : Activity() {

    private companion object {
        const val TAG = "OruRadio"

        const val BG = Color.BLACK
        const val FG = 0xFFE0E0E0.toInt()
        const val DIM = 0xFF808080.toInt()
        const val ACCENT = 0xFF40C4FF.toInt() // named candidates, banners
        const val OK = 0xFF69F0AE.toInt()
        const val BAD = 0xFFFF5252.toInt()
    }

    private var capturingKeys = false

    // --- views -------------------------------------------------------------------------

    private lateinit var stateHeader: TextView
    private lateinit var errorLine: TextView
    private lateinit var pttButton: Button
    private lateinit var pairingBanner: TextView
    private lateinit var candidateList: LinearLayout
    private lateinit var cancelButton: Button

    /** Last state the engine delivered; null until the first callback. */
    private var latest: RadioState? = null
    private var lastError: String? = null

    /**
     * The UI's subscription. Same observation path as [SpikeLogger]: registered on
     * [RadioController], which forwards to the engine whenever one is attached, so state
     * arrives here whether the service was started by this UI or by adb. Engine callbacks
     * run on the engine's scheduler thread; [Activity.runOnUiThread] hops to main.
     */
    private val uiListener = object : RadioEngineListener {

        override fun onStateChanged(state: RadioState) = runOnUiThread {
            latest = state
            render()
        }

        override fun onError(code: String, message: String) = runOnUiThread {
            lastError = "$code: $message"
            render()
        }
    }

    /**
     * Re-renders the state header when an audio device comes or goes, so the route line
     * tracks plugging and unplugging without waiting for an engine state change. The
     * route itself is read straight off AudioManager in [routeLabel] -- deliberately NOT
     * plumbed through RadioState: routing lives in the service, RadioState is engine
     * state, and for a debug screen polling on render is the least invasive path.
     */
    private val routeCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = render()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = render()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val cmd = intent?.getStringExtra("cmd")

        if (cmd == "stop") {
            // Unchanged adb contract: stop and go away, no UI.
            RadioController.stop(this)
            Log.i(TAG, "spike: radio stopped")
            finish()
            return
        }

        buildUi()
        RadioController.addListener(uiListener)
        // null Handler = callbacks on the main thread, where render() must run anyway.
        getSystemService(AudioManager::class.java)
            ?.registerAudioDeviceCallback(routeCallback, null)

        when (cmd) {
            "keys" -> {
                capturingKeys = true
                Log.i(TAG, "spike: capturing key codes; press the button, then press back")
            }
            else -> {
                // Unchanged adb contract: `cmd start` (and historically any other value,
                // including a plain launch) starts the radio. The activity now stays up
                // to show the UI instead of finishing.
                RadioController.start(this)
                Log.i(TAG, "spike: radio starting")
            }
        }
        render()
    }

    override fun onDestroy() {
        if (::stateHeader.isInitialized) {
            RadioController.removeListener(uiListener)
            getSystemService(AudioManager::class.java)
                ?.unregisterAudioDeviceCallback(routeCallback)
        }
        super.onDestroy()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (capturingKeys) {
            Log.i(TAG, "spike: keyCode=${event.keyCode} action=${event.action}")
        }
        return if (HidKeyEventBus.dispatch(event.keyCode, event.action)) {
            true
        } else {
            super.dispatchKeyEvent(event)
        }
    }

    // --- layout ------------------------------------------------------------------------

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    @SuppressLint("ClickableViewAccessibility") // debug-only spike UI; the PTT button is press-and-hold by design
    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }

        stateHeader = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextColor(FG)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            text = "state: (no engine yet)"
        }
        root.addView(stateHeader)

        errorLine = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextColor(BAD)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            visibility = View.GONE
            setPadding(0, dp(4), 0, 0)
        }
        root.addView(errorLine)

        // Start / Stop row.
        val controlRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(12), 0, 0)
        }
        controlRow.addView(
            Button(this).apply {
                text = "Start"
                setOnClickListener {
                    RadioController.start(this@SpikeActivity)
                    Log.i(TAG, "spike: radio starting (ui)")
                }
            },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        controlRow.addView(
            Button(this).apply {
                text = "Stop"
                setOnClickListener {
                    RadioController.stop(this@SpikeActivity)
                    Log.i(TAG, "spike: radio stopped (ui)")
                }
            },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        root.addView(controlRow)

        // Big press-and-hold PTT button: exactly the ptt-down / ptt-up paths.
        pttButton = Button(this).apply {
            text = "HOLD TO TALK"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            setOnTouchListener { view, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        view.isPressed = true
                        RadioController.engine()?.startTransmit()
                            ?: Log.w(TAG, "spike: ptt-down ignored - radio not running")
                        true
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        view.isPressed = false
                        RadioController.engine()?.stopTransmit()
                        true
                    }
                    else -> false
                }
            }
        }
        root.addView(
            pttButton,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(120)).apply {
                topMargin = dp(12)
            },
        )

        // Pairing section.
        root.addView(
            TextView(this).apply {
                text = "PTT button pairing"
                setTextColor(DIM)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                setPadding(0, dp(16), 0, 0)
            },
        )

        val pairingRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        pairingRow.addView(
            Button(this).apply {
                text = "Scan"
                setOnClickListener {
                    lastError = null
                    RadioController.engine()?.startPttPairing()
                        ?: Log.w(TAG, "spike: ptt-scan ignored - radio not running")
                    render()
                }
            },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        cancelButton = Button(this).apply {
            text = "Cancel"
            setOnClickListener { RadioController.engine()?.cancelPttPairing() }
        }
        pairingRow.addView(
            cancelButton,
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        pairingRow.addView(
            Button(this).apply {
                text = "Forget"
                setOnClickListener {
                    RadioController.engine()?.forgetPtt()
                        ?: Log.w(TAG, "spike: ptt-forget ignored - radio not running")
                }
            },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        root.addView(pairingRow)

        pairingBanner = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(dp(8), dp(10), dp(8), dp(10))
        }
        root.addView(pairingBanner)

        candidateList = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        root.addView(candidateList)

        setContentView(
            ScrollView(this).apply {
                setBackgroundColor(BG)
                isFillViewport = true
                addView(root)
            },
        )
    }

    // --- rendering ---------------------------------------------------------------------

    private fun render() {
        val state = latest

        val header = if (state == null) {
            "state: (no engine yet)"
        } else {
            val button = state.pttButton
            buildString {
                append("status: ${state.status.wire}   nearby: ${state.nearbyCount}\n")
                append("tx: ${state.transmitting}   rx: ${state.receiving}\n")
                append("button: ")
                if (!button.configured) {
                    append("(none configured)")
                } else {
                    append(button.name ?: "(unnamed)")
                    append(if (button.connected) "  connected" else "  disconnected")
                }
            }
        }
        stateHeader.text = "$header\n${routeLabel()}"

        errorLine.text = lastError?.let { "error: $it" } ?: ""
        errorLine.visibility = if (lastError == null) View.GONE else View.VISIBLE

        pttButton.text = if (state?.transmitting == true) "TRANSMITTING" else "HOLD TO TALK"

        renderPairing(state?.pttPairing)
    }

    /**
     * One-line route readout, e.g. "out: OPENEAR Bone G1 (A2DP) / mic: phone". Mirrors
     * the service's policy rows: an active communication device that is not a built-in
     * transducer means the headset-mic row (playback AND capture on it); otherwise
     * playback follows the first external output (media route) or the speaker, and the
     * mic is the phone's.
     */
    private fun routeLabel(): String {
        val audioManager = getSystemService(AudioManager::class.java) ?: return "route: ?"
        val comm =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.communicationDevice else null
        if (audioManager.mode == AudioManager.MODE_IN_COMMUNICATION &&
            comm != null &&
            comm.type != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER &&
            comm.type != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        ) {
            val label = "${comm.productName} (${routeTypeName(comm.type)})"
            return "out: $label / mic: $label"
        }
        val external = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .firstOrNull { isExternalOutput(it.type) }
        val out = external?.let { "${it.productName} (${routeTypeName(it.type)})" } ?: "speaker"
        return "out: $out / mic: phone"
    }

    private fun isExternalOutput(type: Int): Boolean = when (type) {
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

    private fun routeTypeName(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "A2DP"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "SCO"
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "LE"
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> "LE spk"
        AudioDeviceInfo.TYPE_BLE_BROADCAST -> "LE bcast"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired out"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB"
        AudioDeviceInfo.TYPE_HEARING_AID -> "hearing aid"
        else -> "type $type"
    }

    private fun renderPairing(pairing: PttPairingState?) {
        cancelButton.isEnabled = pairing != null
        candidateList.removeAllViews()

        if (pairing == null) {
            pairingBanner.visibility = View.GONE
            return
        }

        pairingBanner.visibility = View.VISIBLE
        when (pairing.phase) {
            PttPairingPhase.SCANNING -> {
                pairingBanner.setTextColor(ACCENT)
                pairingBanner.text = "Scanning... tap your button below"
                // PttManager already publishes strongest-signal-first; re-sorting here
                // keeps the UI honest even if that ever changes.
                pairing.candidates
                    .sortedByDescending { it.rssi }
                    .forEach { candidateList.addView(candidateRow(it)) }
                if (pairing.candidates.isEmpty()) {
                    candidateList.addView(
                        TextView(this).apply {
                            typeface = Typeface.MONOSPACE
                            setTextColor(DIM)
                            text = "(no devices seen yet)"
                            setPadding(dp(8), dp(8), dp(8), dp(8))
                        },
                    )
                }
            }
            PttPairingPhase.LEARNING -> {
                pairingBanner.setTextColor(ACCENT)
                pairingBanner.text = "Press the button NOW"
            }
            PttPairingPhase.SAVED -> {
                pairingBanner.setTextColor(OK)
                pairingBanner.text = "Saved. Tap Cancel to dismiss."
            }
        }
    }

    private fun candidateRow(candidate: PttCandidate): View {
        // A nameless device is published under its address (see PttCandidate), so a name
        // that differs from the deviceId means the advertisement carried a real name --
        // that is what makes PTT-Z01 stand out from the anonymous crowd.
        val named = candidate.name != candidate.deviceId
        return TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(if (named) ACCENT else FG)
            if (named) setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
            text = "${candidate.name}\n${candidate.deviceId}   ${candidate.rssi} dBm"
            setPadding(dp(8), dp(10), dp(8), dp(10))
            setOnClickListener {
                RadioController.engine()?.selectPttCandidate(candidate.deviceId)
            }
        }
    }
}
