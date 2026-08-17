package com.oru.radio

/**
 * The capture half of the learning flow (spec section 9.3): the user presses the button
 * once, and the first two *different* values seen on one notifying characteristic become
 * pressedValue and releasedValue. Pure, so the rule is testable without a button.
 *
 * Order of appearance alone is not enough to tell which value is the press. Telink-style
 * buttons (PTT-Z01) push their *current* state the moment the CCCD subscription lands, so
 * the first value seen is usually the idle `00`, not the press — latching it as
 * pressedValue inverted every binding (transmit on release). Hence the completion rule:
 * when exactly one of the two captured values is all-zero bytes ("00", "0000", ...), the
 * nonzero value is pressedValue and the zero value is releasedValue, regardless of arrival
 * order. When neither (or both) is all-zero there is nothing better to go on — some
 * buttons use two nonzero codes — so order of appearance decides, as before.
 *
 * Threading: notifications arrive from `BluetoothGattCallback`, and `connectGatt(context,
 * false, callback, TRANSPORT_LE)` — the overload without a `Handler` — has AOSP deliver them
 * straight onto binder threads, a *pool*, so two notifications of the same press can land on
 * two different threads at once. Both mutating methods are therefore synchronized on the
 * instance, the same answer [JitterBuffer] gives to the same problem. Unsynchronized, the
 * second notification could miss the first's [firstValue] and learning would silently
 * never finish until the 60 s timeout, or two interleaved notifications could save a
 * [serviceUuid]/[characteristicUuid] pair that exists on no characteristic at all.
 *
 * [completed] closes the other half of it: capture-and-complete has to be one atomic step,
 * or both of two concurrent notifications can complete the same machine and emit two
 * different configurations — one saved, a different one handed to the driver.
 */
class PttLearningStateMachine(
    private val deviceId: String,
    private val deviceName: String?,
) {
    private var serviceUuid: String? = null
    private var characteristicUuid: String? = null
    private var firstValue: String? = null
    private var completed = false

    /** Returns the finished configuration on the notification that completes it, else null. */
    @Synchronized
    fun onNotification(
        serviceUuid: String,
        characteristicUuid: String,
        valueHex: String,
    ): PttConfiguration? {
        if (completed) return null
        if (valueHex.isEmpty()) return null

        val first = firstValue
        if (first == null) {
            this.serviceUuid = serviceUuid
            this.characteristicUuid = characteristicUuid
            firstValue = valueHex
            return null
        }

        if (serviceUuid != this.serviceUuid || characteristicUuid != this.characteristicUuid) {
            return null
        }
        if (valueHex == first) return null

        completed = true
        // Idle-first correction (see the class KDoc): a button that announces its idle
        // all-zero state on subscribe delivers `00` before the press, so a zero first
        // value must not be latched as the press.
        val pressedIsSecond = isAllZero(first) && !isAllZero(valueHex)
        return PttConfiguration(
            name = deviceName ?: deviceId,
            binding = PttBinding.Ble(
                deviceId = deviceId,
                serviceUuid = serviceUuid,
                characteristicUuid = characteristicUuid,
                pressedValue = if (pressedIsSecond) valueHex else first,
                releasedValue = if (pressedIsSecond) first else valueHex,
            ),
        )
    }

    @Synchronized
    fun reset() {
        serviceUuid = null
        characteristicUuid = null
        firstValue = null
        completed = false
    }

    private companion object {
        /** True for hex strings that decode to only zero bytes ("00", "0000", ...). */
        fun isAllZero(hex: String): Boolean = hex.isNotEmpty() && hex.all { it == '0' }
    }
}
