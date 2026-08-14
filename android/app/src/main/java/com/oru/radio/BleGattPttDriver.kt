package com.oru.radio

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.util.Log
import java.util.UUID

/**
 * The preferred driver (spec section 9.1): a GATT notify characteristic, connected with
 * autoConnect so the platform re-establishes the link by itself when the button comes back
 * in range — that is the "button reconnects automatically" requirement of section 9.2, and
 * it costs no code of ours.
 *
 * Threading: [start]/[stop] are always called from the engine's single scheduler thread
 * (`RadioEngine` wraps every `PttSource` call in `scheduler.execute { }`, and `PttManager`
 * calls straight through to this driver from there). [callback] fires on whatever thread
 * the Bluetooth stack picks, which is not that thread. [gatt] and [pressed] are therefore
 * touched from two threads and are `@Volatile`. `connectGatt` is called without a `Handler`,
 * which means a binder *pool* rather than one callback thread, so `@Volatile` is not enough
 * on its own for [pressed]: every read-and-set of it goes through a synchronized helper, or
 * two repeats of the same value arriving at once would both pass the same check.
 *
 * Bug fix: `PttManager.attach()` calls `driver?.stop()` and immediately creates and starts
 * a *new* driver, with the same `PttManager` as [listener] for both. If this driver's
 * asynchronous `onConnectionStateChange(STATE_DISCONNECTED)` fires after [stop] has already
 * torn the connection down — or even after a newly attached driver already reported
 * `onConnectionChanged(true)` — it must not report a disconnect again; the callback can
 * fire synchronously off `disconnect()` too. [closing] is set before disconnecting, the
 * same self-initiated-teardown discipline [BleLearningSession] uses for the same reason.
 *
 * Bug fix: every callback below that receives a `gatt` parameter also checks it is the
 * instance currently held in [gatt] before touching any state, the same identity guard
 * [BleLearningSession.gattCallback] uses and for the same reason — [closing] alone only
 * covers a synchronous echo of [stop]'s own disconnect, not a stale callback from a
 * connection this driver has already moved on from.
 */
@SuppressLint("MissingPermission")
class BleGattPttDriver(
    private val context: Context,
    private val binding: PttBinding.Ble,
    private val listener: PttDriverListener,
) : PttDriver {

    private companion object {
        const val TAG = "OruRadio"
        val CLIENT_CONFIG: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    @Volatile
    private var gatt: BluetoothGatt? = null

    @Volatile
    private var pressed = false

    /** Set before [stop] disconnects, so the async STATE_DISCONNECTED it causes is not
     *  mistaken for the button dropping out on its own. See the class doc. */
    @Volatile
    private var closing = false

    override fun start() {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        // Runtime BLE permissions (BLUETOOTH_CONNECT) are P7's job; getRemoteDevice() and
        // connectGatt() both throw SecurityException when they are missing, and a missing
        // permission must degrade to "not connected", never crash the radio.
        val connection = runCatching {
            val device = manager?.adapter?.getRemoteDevice(binding.deviceId) ?: return@runCatching null
            device.connectGatt(context, true, callback, BluetoothDevice.TRANSPORT_LE)
        }.getOrNull()
        if (connection == null) {
            Log.w(TAG, "could not open a BLE connection to ${binding.deviceId}")
            return
        }
        gatt = connection
    }

    override fun stop() {
        // Set before disconnecting, not after: onConnectionStateChange(STATE_DISCONNECTED)
        // can fire synchronously off the disconnect() call below, and a re-attach on the
        // same PttManager must not see this self-initiated teardown as a real disconnect.
        closing = true
        val current = gatt
        gatt = null
        runCatching {
            current?.disconnect()
            current?.close()
        }
        clearPress()
        listener.onConnectionChanged(false)
    }

    private val callback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (gatt !== this@BleGattPttDriver.gatt) return
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    listener.onConnectionChanged(true)
                    runCatching { gatt.discoverServices() }
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    clearPress()
                    if (!closing) {
                        listener.onConnectionChanged(false)
                    }
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (gatt !== this@BleGattPttDriver.gatt) return
            val characteristic = gatt
                .getService(UUID.fromString(binding.serviceUuid))
                ?.getCharacteristic(UUID.fromString(binding.characteristicUuid))
            if (characteristic == null) {
                Log.w(TAG, "the bound characteristic is gone; the button changed firmware?")
                return
            }
            // BLUETOOTH_CONNECT (API 31+) guards this the same as connectGatt()/
            // discoverServices() above; a missing runtime permission (P7's job) must
            // degrade to "not connected", not crash the GATT callback thread. It is not a
            // learning flow here, so there is no onLearningFailed to report through.
            val enabled = runCatching { gatt.setCharacteristicNotification(characteristic, true) }
                .getOrDefault(false)
            if (!enabled) {
                Log.w(TAG, "could not enable PTT notifications; is BLUETOOTH_CONNECT granted?")
                listener.onConnectionChanged(false)
                return
            }
            characteristic.getDescriptor(CLIENT_CONFIG)?.let { enableNotifications(gatt, it) }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            if (gatt !== this@BleGattPttDriver.gatt) return
            handle(PttBindingCodec.toHex(value))
        }

        @Deprecated("Android below 13 calls this overload instead")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            if (gatt !== this@BleGattPttDriver.gatt) return
            @Suppress("DEPRECATION")
            handle(PttBindingCodec.toHex(characteristic.value ?: return))
        }
    }

    private fun enableNotifications(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor) {
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

    /** Strictly hold-to-talk (spec section 9.4); unknown values are simply not ours. */
    private fun handle(valueHex: String) {
        when (valueHex) {
            binding.pressedValue -> if (takePress()) listener.onPressed()
            binding.releasedValue -> if (takeRelease()) listener.onReleased()
            else -> Log.d(TAG, "ignoring PTT characteristic value $valueHex")
        }
    }

    /**
     * The read-and-set of [pressed] is one step, not two. `connectGatt` is called without a
     * `Handler`, so notifications arrive on a binder *pool* and two repeats of the same
     * value can be in [handle] at once on different threads; `@Volatile` makes each read
     * current but does nothing about two of them passing the same check. The listener is
     * notified outside the lock, since it hands the event on to the engine's scheduler.
     */
    @Synchronized
    private fun takePress(): Boolean {
        if (pressed) return false
        pressed = true
        return true
    }

    @Synchronized
    private fun takeRelease(): Boolean {
        if (!pressed) return false
        pressed = false
        return true
    }

    /** A teardown or a dropped link forgets the press without reporting a release. */
    @Synchronized
    private fun clearPress() {
        pressed = false
    }
}
