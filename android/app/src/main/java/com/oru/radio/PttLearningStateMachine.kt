package com.oru.radio

/**
 * The capture half of the learning flow (spec section 9.3): the user presses the button
 * once, and the first two *different* values seen on one notifying characteristic become
 * pressedValue and releasedValue. Pure, so the rule is testable without a button.
 *
 * Threading: notifications arrive from `BluetoothGattCallback`, and `connectGatt(context,
 * false, callback, TRANSPORT_LE)` — the overload without a `Handler` — has AOSP deliver them
 * straight onto binder threads, a *pool*, so two notifications of the same press can land on
 * two different threads at once. Both mutating methods are therefore synchronized on the
 * instance, the same answer [JitterBuffer] gives to the same problem. Unsynchronized, the
 * second notification could miss the first's [pressedValue] and learning would silently
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
    private var pressedValue: String? = null
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

        val pressed = pressedValue
        if (pressed == null) {
            this.serviceUuid = serviceUuid
            this.characteristicUuid = characteristicUuid
            pressedValue = valueHex
            return null
        }

        if (serviceUuid != this.serviceUuid || characteristicUuid != this.characteristicUuid) {
            return null
        }
        if (valueHex == pressed) return null

        completed = true
        return PttConfiguration(
            name = deviceName ?: deviceId,
            binding = PttBinding.Ble(
                deviceId = deviceId,
                serviceUuid = serviceUuid,
                characteristicUuid = characteristicUuid,
                pressedValue = pressed,
                releasedValue = valueHex,
            ),
        )
    }

    @Synchronized
    fun reset() {
        serviceUuid = null
        characteristicUuid = null
        pressedValue = null
        completed = false
    }
}
