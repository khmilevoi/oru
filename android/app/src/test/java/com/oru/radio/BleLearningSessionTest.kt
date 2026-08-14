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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.kotlin.any
import org.mockito.kotlin.doAnswer
import org.mockito.kotlin.eq
import org.mockito.kotlin.mock
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever

/**
 * Fix round 1, findings 1 and 2 (Task 9 review): [BleLearningSession] must not leak a
 * [BluetoothGatt] when [BleLearningSession.select] is called a second time in the same
 * pairing session, and every `BluetoothGatt` call that can throw `SecurityException` on a
 * missing runtime Bluetooth permission must degrade gracefully instead of crashing the GATT
 * callback thread.
 *
 * [BluetoothGatt]/[BluetoothDevice]/[BluetoothAdapter] have no public constructor and are
 * declared `final`, so real instances cannot be built by hand here; they are mocked with
 * Mockito (whose default "inline" mock maker, as of Mockito 5, can mock final Android
 * framework classes). [BleLearningSession.gattCallback] is a private field with no other
 * way to reach it, so it is fetched through reflection to simulate the Bluetooth stack
 * invoking it, exactly as the framework would.
 */
class BleLearningSessionTest {

    private class RecordingLearningListener : PttLearningListener {
        val found = mutableListOf<Triple<String, String?, Int>>()
        val learned = mutableListOf<PttConfiguration>()
        val failures = mutableListOf<Pair<String, String>>()

        override fun onDeviceFound(deviceId: String, name: String?, rssi: Int) {
            found.add(Triple(deviceId, name, rssi))
        }

        override fun onLearned(configuration: PttConfiguration) {
            learned.add(configuration)
        }

        override fun onLearningFailed(code: String, message: String) {
            failures.add(code to message)
        }
    }

    private lateinit var context: Context
    private lateinit var bluetoothManager: BluetoothManager
    private lateinit var adapter: BluetoothAdapter
    private lateinit var listener: RecordingLearningListener

    @Before
    fun setUp() {
        context = mock()
        bluetoothManager = mock()
        adapter = mock()
        whenever(context.getSystemService(Context.BLUETOOTH_SERVICE)).thenReturn(bluetoothManager)
        whenever(bluetoothManager.adapter).thenReturn(adapter)
        listener = RecordingLearningListener()
    }

    private fun gattCallbackOf(session: BleLearningSession): BluetoothGattCallback {
        val field = BleLearningSession::class.java.getDeclaredField("gattCallback")
        field.isAccessible = true
        return field.get(session) as BluetoothGattCallback
    }

    @Suppress("UNCHECKED_CAST")
    private fun gattFieldOf(session: BleLearningSession): BluetoothGatt? {
        val field = BleLearningSession::class.java.getDeclaredField("gatt")
        field.isAccessible = true
        return field.get(session) as BluetoothGatt?
    }

    @Test
    fun `a second select closes the previous gatt instead of leaking it`() {
        val deviceA = mock<BluetoothDevice>()
        val deviceB = mock<BluetoothDevice>()
        val gattA = mock<BluetoothGatt>()
        val gattB = mock<BluetoothGatt>()
        whenever(adapter.getRemoteDevice("AA:AA:AA:AA:AA:AA")).thenReturn(deviceA)
        whenever(adapter.getRemoteDevice("BB:BB:BB:BB:BB:BB")).thenReturn(deviceB)
        whenever(deviceA.connectGatt(eq(context), eq(false), any(), eq(BluetoothDevice.TRANSPORT_LE)))
            .thenReturn(gattA)
        whenever(deviceB.connectGatt(eq(context), eq(false), any(), eq(BluetoothDevice.TRANSPORT_LE)))
            .thenReturn(gattB)

        val session = BleLearningSession(context, listener)
        session.select("AA:AA:AA:AA:AA:AA")
        assertEquals(gattA, gattFieldOf(session))

        session.select("BB:BB:BB:BB:BB:BB")

        verify(gattA).disconnect()
        verify(gattA).close()
        assertEquals(gattB, gattFieldOf(session))
    }

    @Test
    fun `the deliberate self-close of a second select does not report a spurious device_disconnected failure`() {
        val deviceA = mock<BluetoothDevice>()
        val deviceB = mock<BluetoothDevice>()
        val gattA = mock<BluetoothGatt>()
        val gattB = mock<BluetoothGatt>()
        whenever(adapter.getRemoteDevice("AA:AA:AA:AA:AA:AA")).thenReturn(deviceA)
        whenever(adapter.getRemoteDevice("BB:BB:BB:BB:BB:BB")).thenReturn(deviceB)
        whenever(deviceA.connectGatt(eq(context), eq(false), any(), eq(BluetoothDevice.TRANSPORT_LE)))
            .thenReturn(gattA)
        whenever(deviceB.connectGatt(eq(context), eq(false), any(), eq(BluetoothDevice.TRANSPORT_LE)))
            .thenReturn(gattB)

        val session = BleLearningSession(context, listener)
        val callback = gattCallbackOf(session)
        // Some GATT stack implementations invoke the disconnect callback synchronously off
        // disconnect(); simulate that worst case so the closing-flag guard is exercised for
        // real, not just given a chance to run later.
        doAnswer {
            callback.onConnectionStateChange(gattA, 0, BluetoothProfile.STATE_DISCONNECTED)
        }.whenever(gattA).disconnect()

        session.select("AA:AA:AA:AA:AA:AA")
        session.select("BB:BB:BB:BB:BB:BB")

        assertTrue(
            "expected no device_disconnected failure, got: ${listener.failures}",
            listener.failures.none { it.first == "device_disconnected" },
        )
    }

    @Test
    fun `a stale disconnect delivered after a later select completes is not reported as a failure`() {
        val deviceA = mock<BluetoothDevice>()
        val deviceB = mock<BluetoothDevice>()
        val gattA = mock<BluetoothGatt>()
        val gattB = mock<BluetoothGatt>()
        whenever(adapter.getRemoteDevice("AA:AA:AA:AA:AA:AA")).thenReturn(deviceA)
        whenever(adapter.getRemoteDevice("BB:BB:BB:BB:BB:BB")).thenReturn(deviceB)
        whenever(deviceA.connectGatt(eq(context), eq(false), any(), eq(BluetoothDevice.TRANSPORT_LE)))
            .thenReturn(gattA)
        whenever(deviceB.connectGatt(eq(context), eq(false), any(), eq(BluetoothDevice.TRANSPORT_LE)))
            .thenReturn(gattB)

        val session = BleLearningSession(context, listener)
        // select(deviceA) then select(deviceB) run to completion first, with no callback
        // fired synchronously off gattA.disconnect() this time (unlike the test above) —
        // this is the realistic case where the BLE stack takes its time to deliver the old
        // connection's disconnect. By the time select(deviceB) returns, `closing` is already
        // back to `false` (reset once the new connectGatt() call is made), so only an
        // identity check on the callback's own `gatt` parameter can still catch this.
        session.select("AA:AA:AA:AA:AA:AA")
        session.select("BB:BB:BB:BB:BB:BB")
        assertEquals("the session must have moved on to deviceB's gatt", gattB, gattFieldOf(session))

        // Now, only after select(deviceB) has fully completed, the stack delivers gattA's
        // stale disconnect.
        val callback = gattCallbackOf(session)
        callback.onConnectionStateChange(gattA, 0, BluetoothProfile.STATE_DISCONNECTED)

        assertTrue(
            "expected no device_disconnected failure, got: ${listener.failures}",
            listener.failures.none { it.first == "device_disconnected" },
        )
        assertEquals(
            "the deviceB session must be undisturbed by the stale gattA callback",
            gattB,
            gattFieldOf(session),
        )
    }

    @Test
    fun `a malformed address is reported as a learning failure instead of thrown`() {
        // BluetoothAdapter.getRemoteDevice throws IllegalArgumentException on anything that
        // is not a well-formed MAC. The surrounding try caught only SecurityException, so a
        // typo in `ptt-pick --es device <address>` unwound the engine's single looper
        // thread and killed the whole process.
        whenever(adapter.getRemoteDevice("AA:BB:CC:DD:EE:F"))
            .thenThrow(IllegalArgumentException("not a valid Bluetooth address"))

        val session = BleLearningSession(context, listener)
        session.select("AA:BB:CC:DD:EE:F")

        assertEquals(listOf("unknown_device" to "AA:BB:CC:DD:EE:F"), listener.failures)
    }

    @Test
    fun `onServicesDiscovered reports permission_denied instead of crashing when setCharacteristicNotification is not permitted`() {
        val device = mock<BluetoothDevice>()
        val gatt = mock<BluetoothGatt>()
        whenever(adapter.getRemoteDevice("AA:AA:AA:AA:AA:AA")).thenReturn(device)
        whenever(device.connectGatt(eq(context), eq(false), any(), eq(BluetoothDevice.TRANSPORT_LE)))
            .thenReturn(gatt)

        val characteristic = mock<BluetoothGattCharacteristic>()
        whenever(characteristic.properties).thenReturn(BluetoothGattCharacteristic.PROPERTY_NOTIFY)
        val service = mock<BluetoothGattService>()
        whenever(service.characteristics).thenReturn(listOf(characteristic))
        whenever(gatt.services).thenReturn(listOf(service))
        whenever(gatt.setCharacteristicNotification(characteristic, true))
            .thenThrow(SecurityException("BLUETOOTH_CONNECT missing"))

        val session = BleLearningSession(context, listener)
        session.select("AA:AA:AA:AA:AA:AA")
        val callback = gattCallbackOf(session)

        // Must not throw out of the callback: an uncaught SecurityException here would
        // kill the process.
        callback.onServicesDiscovered(gatt, 0)

        assertEquals(
            listOf("permission_denied" to "Bluetooth connect permission is not granted"),
            listener.failures,
        )
    }
}
