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
 * touched from two threads and are `@Volatile`.
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
        val current = gatt
        gatt = null
        runCatching {
            current?.disconnect()
            current?.close()
        }
        pressed = false
        listener.onConnectionChanged(false)
    }

    private val callback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    listener.onConnectionChanged(true)
                    runCatching { gatt.discoverServices() }
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    pressed = false
                    listener.onConnectionChanged(false)
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val characteristic = gatt
                .getService(UUID.fromString(binding.serviceUuid))
                ?.getCharacteristic(UUID.fromString(binding.characteristicUuid))
            if (characteristic == null) {
                Log.w(TAG, "the bound characteristic is gone; the button changed firmware?")
                return
            }
            gatt.setCharacteristicNotification(characteristic, true)
            characteristic.getDescriptor(CLIENT_CONFIG)?.let { enableNotifications(gatt, it) }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            handle(PttBindingCodec.toHex(value))
        }

        @Deprecated("Android below 13 calls this overload instead")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
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
            binding.pressedValue -> if (!pressed) {
                pressed = true
                listener.onPressed()
            }
            binding.releasedValue -> if (pressed) {
                pressed = false
                listener.onReleased()
            }
            else -> Log.d(TAG, "ignoring PTT characteristic value $valueHex")
        }
    }
}
