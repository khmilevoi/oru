package com.oru.radio

/**
 * The capture half of the learning flow (spec section 9.3): the user presses the button
 * once, and the first two *different* values seen on one notifying characteristic become
 * pressedValue and releasedValue. Pure, so the rule is testable without a button.
 */
class PttLearningStateMachine(
    private val deviceId: String,
    private val deviceName: String?,
) {
    private var serviceUuid: String? = null
    private var characteristicUuid: String? = null
    private var pressedValue: String? = null

    /** Returns the finished configuration on the notification that completes it, else null. */
    fun onNotification(
        serviceUuid: String,
        characteristicUuid: String,
        valueHex: String,
    ): PttConfiguration? {
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

    fun reset() {
        serviceUuid = null
        characteristicUuid = null
        pressedValue = null
    }
}
