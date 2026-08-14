package com.oru.radio

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.mockito.kotlin.any
import org.mockito.kotlin.eq
import org.mockito.kotlin.mock
import org.mockito.kotlin.whenever

/**
 * Fix round 1, findings 2 and 3 (Task 9 review): [BleGattPttDriver] must not crash the GATT
 * callback thread when `setCharacteristicNotification` throws on a missing runtime
 * Bluetooth permission, and must not report a disconnect caused by its own [BleGattPttDriver.stop]
 * — `PttManager.attach()` calls `stop()` on the old driver and immediately starts a new one
 * with itself as listener for both, so a stale disconnect from the old driver must not flip
 * `PttManager.connected` back to `false` behind the new driver's back.
 *
 * See [BleLearningSessionTest]'s class doc for why these tests need Mockito (final,
 * constructor-less Android framework classes) and reflection (the callback object is a
 * private field with no other way to reach it).
 */
class BleGattPttDriverTest {

    private class RecordingDriverListener : PttDriverListener {
        var pressedCount = 0
        var releasedCount = 0
        val connectionChanges = mutableListOf<Boolean>()

        override fun onPressed() {
            pressedCount++
        }

        override fun onReleased() {
            releasedCount++
        }

        override fun onConnectionChanged(connected: Boolean) {
            connectionChanges.add(connected)
        }
    }

    private lateinit var context: Context
    private lateinit var bluetoothManager: BluetoothManager
    private lateinit var adapter: BluetoothAdapter
    private lateinit var device: BluetoothDevice
    private lateinit var gatt: BluetoothGatt
    private lateinit var listener: RecordingDriverListener
    private lateinit var binding: PttBinding.Ble
    private lateinit var driver: BleGattPttDriver

    @Before
    fun setUp() {
        context = mock()
        bluetoothManager = mock()
        adapter = mock()
        device = mock()
        gatt = mock()
        whenever(context.getSystemService(Context.BLUETOOTH_SERVICE)).thenReturn(bluetoothManager)
        whenever(bluetoothManager.adapter).thenReturn(adapter)
        whenever(adapter.getRemoteDevice("AA:AA:AA:AA:AA:AA")).thenReturn(device)
        whenever(device.connectGatt(eq(context), eq(true), any(), eq(BluetoothDevice.TRANSPORT_LE)))
            .thenReturn(gatt)

        binding = PttBinding.Ble(
            deviceId = "AA:AA:AA:AA:AA:AA",
            serviceUuid = "0000ffe0-0000-1000-8000-00805f9b34fb",
            characteristicUuid = "0000ffe1-0000-1000-8000-00805f9b34fb",
            pressedValue = "01",
            releasedValue = "00",
        )
        listener = RecordingDriverListener()
        driver = BleGattPttDriver(context, binding, listener)
        driver.start()
    }

    private fun callbackOf(): BluetoothGattCallback {
        val field = BleGattPttDriver::class.java.getDeclaredField("callback")
        field.isAccessible = true
        return field.get(driver) as BluetoothGattCallback
    }

    @Test
    fun `onServicesDiscovered degrades to not connected instead of crashing when setCharacteristicNotification is not permitted`() {
        val characteristic = mock<BluetoothGattCharacteristic>()
        val service = mock<BluetoothGattService>()
        whenever(gatt.getService(java.util.UUID.fromString(binding.serviceUuid))).thenReturn(service)
        whenever(service.getCharacteristic(java.util.UUID.fromString(binding.characteristicUuid)))
            .thenReturn(characteristic)
        whenever(gatt.setCharacteristicNotification(characteristic, true))
            .thenThrow(SecurityException("BLUETOOTH_CONNECT missing"))

        // Must not throw out of the callback: an uncaught SecurityException here would
        // kill the process.
        callbackOf().onServicesDiscovered(gatt, 0)

        assertEquals(listOf(false), listener.connectionChanges)
    }

    @Test
    fun `a stale disconnect callback after stop does not report a disconnect again`() {
        callbackOf().onConnectionStateChange(gatt, 0, BluetoothProfile.STATE_CONNECTED)
        listener.connectionChanges.clear()

        driver.stop()
        assertEquals(listOf(false), listener.connectionChanges)

        // Simulates PttManager.attach() replacing this driver: the old driver's async
        // disconnect arrives after stop() already reported "not connected" once.
        callbackOf().onConnectionStateChange(gatt, 0, BluetoothProfile.STATE_DISCONNECTED)

        assertEquals(
            "the stale callback must not add a second onConnectionChanged(false)",
            listOf(false),
            listener.connectionChanges,
        )
    }
}
