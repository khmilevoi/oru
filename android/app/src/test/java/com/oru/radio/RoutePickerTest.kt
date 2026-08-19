package com.oru.radio

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Section 6 "Device selection and recovery", as pure functions. Everything the route
 * controller decides about a device list is decided here, so it is testable without an
 * android.media.AudioDeviceInfo (which has no public constructor).
 */
class RoutePickerTest {

    private fun device(
        id: Int,
        type: Int,
        address: String = "",
        productName: String = "device",
        isSource: Boolean = false,
        isSink: Boolean = false,
    ) = RouteDevice(id, type, address, productName, isSource, isSink)

    private val btMic = device(
        id = 7,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        address = "AA:BB:CC:DD:EE:FF",
        productName = "Buds Pro",
        isSource = true,
        isSink = true,
    )
    private val btMedia = device(
        id = 8,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        address = "AA:BB:CC:DD:EE:FF",
        productName = "Buds Pro",
        isSink = true,
    )
    private val wiredHeadset = device(
        id = 3,
        type = AudioDeviceInfo.TYPE_WIRED_HEADSET,
        productName = "Wired headset",
        isSource = true,
        isSink = true,
    )
    private val usbHeadset = device(
        id = 4,
        type = AudioDeviceInfo.TYPE_USB_HEADSET,
        productName = "USB headset",
        isSource = true,
        isSink = true,
    )
    private val bleHeadset = device(
        id = 9,
        type = AudioDeviceInfo.TYPE_BLE_HEADSET,
        address = "11:22:33:44:55:66",
        productName = "LE buds",
        isSource = true,
        isSink = true,
    )
    private val speaker = device(id = 1, type = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, isSink = true)
    private val phoneMic = device(id = 2, type = AudioDeviceInfo.TYPE_BUILTIN_MIC, isSource = true)

    private val hfp = listOf("AA:BB:CC:DD:EE:FF")

    @Test
    fun `bluetooth wins over wired and usb, and le audio wins inside bluetooth`() {
        // Section 6: "BT SCO / BLE headset > wired headset > USB headset". This deliberately
        // reverses the pre-spec order, which preferred a plugged cable.
        val devices = listOf(speaker, phoneMic, usbHeadset, wiredHeadset, btMic, bleHeadset)

        val candidates = RoutePicker.inputCandidates(devices, hfp + "11:22:33:44:55:66")

        assertEquals(
            listOf(bleHeadset, btMic, wiredHeadset, usbHeadset),
            candidates,
        )
    }

    @Test
    fun `devices with no microphone are never candidates`() {
        assertEquals(emptyList<RouteDevice>(), RoutePicker.inputCandidates(listOf(speaker, btMedia), hfp))
    }

    @Test
    fun `a watch is filtered out of both candidates and outputs`() {
        val watch = device(
            id = 12,
            type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            address = "99:99:99:99:99:99",
            productName = "Galaxy Watch5",
            isSource = true,
            isSink = true,
        )

        assertTrue(RoutePicker.isWatch(watch))
        assertFalse(RoutePicker.isWatch(btMic))
        assertEquals(
            emptyList<RouteDevice>(),
            RoutePicker.inputCandidates(listOf(watch), listOf("99:99:99:99:99:99")),
        )
        assertNull(RoutePicker.outputDevice(listOf(speaker, watch)))
    }

    @Test
    fun `a bluetooth input is only trusted when the hfp stack has it connected`() {
        assertTrue(RoutePicker.isTrustedBluetoothInput(btMic, hfp))
        assertFalse(RoutePicker.isTrustedBluetoothInput(btMic, emptyList()))
        // Null means the profile proxy has not arrived: unverifiable, so untrusted.
        assertFalse(RoutePicker.isTrustedBluetoothInput(btMic, null))
        // Wired and USB inputs bypass the cross-validation entirely.
        assertTrue(RoutePicker.isTrustedBluetoothInput(wiredHeadset, null))
    }

    @Test
    fun `a zero-mac sco input stands in for a connected hfp headset`() {
        // ColorOS enumerates one SCO input named after the phone with a zeroed MAC; it is the
        // OEM's only representation of the headset when HFP really is connected, and a true
        // phantom when it is not (2026-08-17 hardware session).
        val zeroMac = btMic.copy(id = 21, address = "00:00:00:00:00:00", productName = "CPH2747")

        assertTrue(RoutePicker.isTrustedBluetoothInput(zeroMac, hfp))
        assertFalse(RoutePicker.isTrustedBluetoothInput(zeroMac, emptyList()))
        assertFalse(RoutePicker.isTrustedBluetoothInput(zeroMac.copy(address = ""), null))
    }

    @Test
    fun `the output device is the highest priority external sink`() {
        assertEquals(btMedia, RoutePicker.outputDevice(listOf(speaker, btMedia, wiredHeadset)))
        assertEquals(wiredHeadset, RoutePicker.outputDevice(listOf(speaker, wiredHeadset)))
        assertNull(RoutePicker.outputDevice(listOf(speaker, phoneMic)))
    }

    @Test
    fun `route kinds and labels follow section 8`() {
        assertEquals(AudioRoute.Kind.BLUETOOTH, RoutePicker.kindOf(btMedia))
        assertEquals(AudioRoute.Kind.BLUETOOTH, RoutePicker.kindOf(bleHeadset))
        assertEquals(AudioRoute.Kind.WIRED, RoutePicker.kindOf(wiredHeadset))
        assertEquals(AudioRoute.Kind.USB, RoutePicker.kindOf(usbHeadset))
        assertEquals(AudioRoute.Kind.SPEAKER, RoutePicker.kindOf(null))
        assertEquals(AudioRoute.Kind.SPEAKER, RoutePicker.kindOf(speaker))

        assertEquals("Buds Pro", RoutePicker.labelOf(btMedia))
        // Only bluetooth routes carry a label, and a nameless one carries none at all.
        assertNull(RoutePicker.labelOf(wiredHeadset))
        assertNull(RoutePicker.labelOf(btMedia.copy(productName = "  ")))
        assertNull(RoutePicker.labelOf(null))
    }

    @Test
    fun `only bluetooth classic needs a voice link raised`() {
        // Section 7: the policy is inert on speaker, wired, USB and LE Audio.
        assertTrue(RoutePicker.requiresVoiceLink(btMic))
        assertFalse(RoutePicker.requiresVoiceLink(bleHeadset))
        assertFalse(RoutePicker.requiresVoiceLink(wiredHeadset))
        assertFalse(RoutePicker.requiresVoiceLink(usbHeadset))
        assertFalse(RoutePicker.requiresVoiceLink(null))
    }

    @Test
    fun `the wire mappings match the section 8 contract`() {
        assertEquals("voice", ModePolicy.Profile.VOICE.wire())
        assertEquals("media", ModePolicy.Profile.MEDIA.wire())
        assertEquals("auto", ModePolicy.AudioMode.AUTO.wire())
        assertEquals("voice", ModePolicy.AudioMode.VOICE.wire())
        assertEquals("media", ModePolicy.AudioMode.MEDIA.wire())

        assertEquals(ModePolicy.AudioMode.VOICE, audioModeFromWire("voice"))
        assertEquals(ModePolicy.AudioMode.MEDIA, audioModeFromWire("media"))
        assertEquals(ModePolicy.AudioMode.AUTO, audioModeFromWire("auto"))
        // An unknown or absent value is the default, never a crash.
        assertEquals(ModePolicy.AudioMode.AUTO, audioModeFromWire(null))
        assertEquals(ModePolicy.AudioMode.AUTO, audioModeFromWire("nonsense"))
    }

    @Test
    fun `an audio route projects the section 8 shape and omits an absent label`() {
        val bluetooth = AudioRoute(AudioRoute.Kind.BLUETOOTH, "Buds Pro", ModePolicy.Profile.MEDIA)
        assertEquals(
            mapOf("kind" to "bluetooth", "label" to "Buds Pro", "mode" to "media"),
            bluetooth.toMap(),
        )
        assertEquals(
            mapOf("kind" to "speaker", "mode" to "voice"),
            AudioRoute().toMap(),
        )
    }
}
