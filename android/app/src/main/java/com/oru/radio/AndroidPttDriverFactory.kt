package com.oru.radio

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedDeque

/**
 * Builds the real drivers and runs the real learning session (spec sections 9.1, 9.3).
 *
 * Threading: every method here ([create], [startLearning], [selectCandidate],
 * [cancelLearning]) is called only from the engine's single scheduler thread (`RadioEngine`
 * wraps every `PttSource`/pairing call in `scheduler.execute { }`, and `PttManager` calls
 * straight through), so [learning] has a single writer/reader and needs no extra guarding
 * beyond `@Volatile` for cross-thread visibility should that assumption ever loosen.
 */
class AndroidPttDriverFactory(private val context: Context) : PttDriverFactory {

    @Volatile
    private var learning: BleLearningSession? = null

    override fun create(binding: PttBinding, listener: PttDriverListener): PttDriver? =
        when (PttDriverSelection.kindFor(binding)) {
            PttDriverKind.BLE ->
                // "Null when this device cannot drive the binding" (PttDriverFactory):
                // a device with no BLE radio at all cannot run a BleGattPttDriver.
                if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
                    null
                } else {
                    BleGattPttDriver(context, binding as PttBinding.Ble, listener)
                }
            PttDriverKind.MEDIA_BUTTON ->
                MediaButtonPttDriver(context, (binding as PttBinding.Hid).keyCode, listener)
            PttDriverKind.HID ->
                HidPttDriver((binding as PttBinding.Hid).keyCode, listener)
        }

    override fun startLearning(listener: PttLearningListener) {
        cancelLearning()
        learning = BleLearningSession(context, listener).also { it.startScan() }
    }

    override fun selectCandidate(deviceId: String) {
        learning?.select(deviceId)
    }

    override fun cancelLearning() {
        learning?.cancel()
        learning = null
    }
}

/**
 * Spec section 9.3: scan -> select -> "press the button" -> capture. Every notifying
 * characteristic of the picked device is subscribed to, one descriptor write at a time
 * (the GATT stack allows exactly one outstanding operation), and the first characteristic
 * that produces two different values wins.
 *
 * Threading: [startScan], [select] and [cancel] run on the engine's single scheduler
 * thread; [scanCallback] and [gattCallback] fire on whatever thread the Bluetooth stack
 * picks, which is a different thread. Every field either callback touches is therefore
 * `@Volatile`, and [pendingDescriptors] — mutated from both [gattCallback] and [cancel] — is
 * a [ConcurrentLinkedDeque] rather than a plain [ArrayDeque].
 *
 * Bug fix: a successful capture calls [BleLearningSession.cancel] to tear the connection
 * down, and `cancel()` calling `gatt.disconnect()` asynchronously fires
 * `onConnectionStateChange(STATE_DISCONNECTED)` afterwards. Without [closing], that would
 * report a spurious `onLearningFailed("device_disconnected", ...)` right after a successful
 * `onLearned`. [cancel] is the one deliberate-teardown path — reached both after a
 * successful capture and from an outside caller's [AndroidPttDriverFactory.cancelLearning] —
 * so it sets [closing] before disconnecting; the callback then tells "we did this on
 * purpose" from "the button actually disconnected on us" and only reports failure in the
 * latter case.
 *
 * Bug fix: [select] can be called more than once in the same session — a double tap, a
 * bridge retry, a user changing their mind about which candidate to pair with — and must
 * not leak whatever [gatt] the previous call already opened; Android's BLE stack refuses
 * new connections after roughly 30 such leaks. [select] therefore closes any existing
 * [gatt] first (see `closePreviousGatt`), using the same [closing] flag so that self-close
 * is not reported as `onLearningFailed("device_disconnected", ...)` either.
 *
 * Bug fix: [closing] alone only covers the *synchronous* echo of a self-close (the case
 * where the stack re-enters [gattCallback] from inside `disconnect()`). It does not cover
 * the realistic asynchronous case: `closePreviousGatt()` closes the old `gatt`, `select`
 * opens a new one and resets [closing] to `false` — and only then does the stack deliver
 * the old connection's `STATE_DISCONNECTED`. By that point [closing] is already `false`
 * again, so the stale echo from the dead connection would be reported as a failure against
 * the *new* candidate. Every callback below that receives a `gatt` parameter therefore
 * first checks it is the instance currently held in [gatt] and returns immediately
 * otherwise — a stale callback from a connection this session has already moved on from
 * must not touch any state or report anything.
 */
@SuppressLint("MissingPermission")
class BleLearningSession(
    private val context: Context,
    private val listener: PttLearningListener,
) {
    private companion object {
        const val TAG = "OruRadio"
        val CLIENT_CONFIG: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    private val names = ConcurrentHashMap<String, String>()
    private val pendingDescriptors = ConcurrentLinkedDeque<BluetoothGattDescriptor>()

    @Volatile
    private var gatt: BluetoothGatt? = null

    @Volatile
    private var machine: PttLearningStateMachine? = null

    @Volatile
    private var scanning = false

    /** Set before any deliberate disconnect so the async STATE_DISCONNECTED it causes is
     *  not mistaken for the button dropping out on its own. See the class doc. */
    @Volatile
    private var closing = false

    fun startScan() {
        try {
            val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
            if (adapter == null || !adapter.isEnabled) {
                listener.onLearningFailed("bluetooth_unavailable", "Bluetooth is off or missing")
                return
            }
            val scanner = adapter.bluetoothLeScanner
            if (scanner == null) {
                listener.onLearningFailed("scan_unavailable", "No BLE scanner on this device")
                return
            }
            scanning = true
            scanner.startScan(scanCallback)
        } catch (security: SecurityException) {
            // Runtime BLE permissions (BLUETOOTH_SCAN) are P7's job; a missing permission
            // fails the pairing session gracefully instead of crashing the radio.
            scanning = false
            listener.onLearningFailed("permission_denied", "Bluetooth scan permission is not granted")
        }
    }

    fun select(deviceId: String) {
        stopScan()
        closePreviousGatt()
        try {
            val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
            val device = adapter?.getRemoteDevice(deviceId)
            if (device == null) {
                listener.onLearningFailed("unknown_device", deviceId)
                return
            }
            machine = PttLearningStateMachine(deviceId, names[deviceId] ?: device.name)
            gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            // The new connection is live: further STATE_DISCONNECTED callbacks are real
            // again, not an echo of the teardown closePreviousGatt() just performed.
            closing = false
        } catch (invalid: IllegalArgumentException) {
            // getRemoteDevice() throws on anything that is not a well-formed MAC address,
            // and this method is reachable from the bridge and from the spike runbook's
            // `ptt-pick --es device <address>`. Uncaught, it unwound the engine's single
            // looper thread and killed the process: a typo in the runbook took the whole
            // app down. It is exactly the same condition as an address the adapter does not
            // know, so it reports the same failure.
            Log.w(TAG, "not a usable Bluetooth address: $deviceId", invalid)
            listener.onLearningFailed("unknown_device", deviceId)
        } catch (security: SecurityException) {
            listener.onLearningFailed("permission_denied", "Bluetooth connect permission is not granted")
        }
    }

    /**
     * A second [select] in the same pairing session (a double tap, a bridge retry, a
     * changed mind) must not leak whatever [gatt] a previous [select] already opened —
     * Android's BLE stack refuses new connections after roughly 30 such leaks. Uses the
     * same [closing] flag [cancel] does, so the async STATE_DISCONNECTED this self-close
     * causes is not mistaken for the button disconnecting and reported as a learning
     * failure.
     */
    private fun closePreviousGatt() {
        val previous = gatt ?: return
        closing = true
        gatt = null
        runCatching {
            previous.disconnect()
            previous.close()
        }
    }

    fun cancel() {
        // Set before disconnecting, not after: onConnectionStateChange(STATE_DISCONNECTED)
        // can fire synchronously off the disconnect() call below, and the check inside it
        // must already see this session as self-closing.
        closing = true
        stopScan()
        val current = gatt
        gatt = null
        runCatching {
            current?.disconnect()
            current?.close()
        }
        machine = null
        pendingDescriptors.clear()
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val address = result.device?.address ?: return
            val name = result.device?.name ?: result.scanRecord?.deviceName
            if (name != null) names[address] = name
            // rssi is what orders the candidate list the pairing UI shows.
            listener.onDeviceFound(address, name, result.rssi)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            listener.onLearningFailed("scan_failed", "BLE scan failed with code $errorCode")
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (gatt !== this@BleLearningSession.gatt) return
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> runCatching { gatt.discoverServices() }
                BluetoothProfile.STATE_DISCONNECTED ->
                    if (!closing) {
                        listener.onLearningFailed("device_disconnected", "The button disconnected")
                    }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (gatt !== this@BleLearningSession.gatt) return
            pendingDescriptors.clear()
            try {
                for (service in gatt.services) {
                    for (characteristic in service.characteristics) {
                        val notifies = characteristic.properties and
                            (BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                                BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
                        if (!notifies) continue
                        // BLUETOOTH_CONNECT (API 31+) guards this the same as connectGatt()
                        // and discoverServices() above; a missing runtime permission (P7's
                        // job) must fail the pairing session gracefully, not crash the GATT
                        // callback thread.
                        gatt.setCharacteristicNotification(characteristic, true)
                        characteristic.getDescriptor(CLIENT_CONFIG)?.let { pendingDescriptors.addLast(it) }
                    }
                }
            } catch (security: SecurityException) {
                listener.onLearningFailed("permission_denied", "Bluetooth connect permission is not granted")
                return
            }
            if (pendingDescriptors.isEmpty()) {
                listener.onLearningFailed("no_notify_characteristic", "This device notifies nothing")
                return
            }
            writeNextDescriptor(gatt)
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            if (gatt !== this@BleLearningSession.gatt) return
            writeNextDescriptor(gatt)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            if (gatt !== this@BleLearningSession.gatt) return
            capture(characteristic, PttBindingCodec.toHex(value))
        }

        @Deprecated("Android below 13 calls this overload instead")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            if (gatt !== this@BleLearningSession.gatt) return
            @Suppress("DEPRECATION")
            capture(characteristic, PttBindingCodec.toHex(characteristic.value ?: return))
        }
    }

    private fun writeNextDescriptor(gatt: BluetoothGatt) {
        val descriptor = pendingDescriptors.pollFirst() ?: return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } else {
                @Suppress("DEPRECATION")
                descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                @Suppress("DEPRECATION")
                gatt.writeDescriptor(descriptor)
            }
        }
    }

    /**
     * `connectGatt` is called without a `Handler`, so notifications arrive on a binder
     * *pool*: two of them can be inside this method at the same time, on different threads,
     * and both can pass the [machine] null-check before [cancel] nulls it. What keeps that
     * from emitting two configurations is not this null-check but
     * [PttLearningStateMachine.onNotification] itself, which is synchronized and completes
     * at most once — everything after the first winner gets null here and returns.
     */
    private fun capture(characteristic: BluetoothGattCharacteristic, valueHex: String) {
        val learned = machine?.onNotification(
            characteristic.service.uuid.toString(),
            characteristic.uuid.toString(),
            valueHex,
        ) ?: return
        Log.i(TAG, "learned a PTT binding on ${characteristic.uuid}")
        listener.onLearned(learned)
        cancel()
    }
}
