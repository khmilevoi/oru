package com.oru.bridge

import android.os.Build
import android.view.HapticFeedbackConstants
import com.facebook.react.bridge.ReactApplicationContext

/**
 * Plays the haptic effects named by `src/app/haptics.ts`. Which control deserves which
 * effect is product policy and stays in TypeScript; this class knows only how to make the
 * four effects happen.
 *
 * Deliberately [android.view.View.performHapticFeedback] and not [android.os.Vibrator]:
 *
 *  - the Vibrator service requires the `VIBRATE` permission, and this app's manifest is
 *    cross-checked line by line against §11 (`__tests__/permission-crosscheck.test.ts`).
 *    Widening the permission surface of a radio that already asks for the microphone,
 *    Bluetooth and background location, in order to decorate a button, is a bad trade.
 *  - a raw Vibrator call ignores the user's "touch feedback" system setting, while
 *    `performHapticFeedback` honours it. Feedback the user switched off must not play.
 *
 * The cost is that the effects are the platform's stock ones rather than arbitrary
 * waveforms, which is the right side of that trade anyway: they are what the rest of the
 * OS already feels like.
 *
 * It lives in `com.oru.bridge` rather than `com.oru.radio` because it is an app concern
 * with no engine counterpart -- the same reasoning as [SharedPreferencesAppLocaleStore],
 * and `com.oru.radio` is additionally forbidden from importing React Native at all
 * (`__tests__/android-radio.test.ts`).
 */
class HapticPlayer(private val reactContext: ReactApplicationContext) {

    /**
     * Silently ignores an effect it does not recognise, so a JS bundle newer than this
     * binary degrades to no buzz rather than to an error, and does nothing at all when
     * there is no Activity attached -- a press cannot happen without a window on screen,
     * so that case only arises for a call racing teardown.
     */
    fun play(effect: String) {
        val constant = when (effect) {
            // Mapped to the closest stock effects available at minSdk 26. LONG_PRESS is
            // the firmest of them, KEYBOARD_TAP the lightest, which is what keeps
            // transmit-start and transmit-end distinguishable under a finger.
            "impactLight" -> HapticFeedbackConstants.KEYBOARD_TAP
            "impactMedium" -> HapticFeedbackConstants.VIRTUAL_KEY
            "impactHeavy" -> HapticFeedbackConstants.LONG_PRESS
            // CONFIRM is API 30; below that VIRTUAL_KEY is the nearest thing to an
            // acknowledgement the platform offers.
            "notificationSuccess" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    HapticFeedbackConstants.CONFIRM
                } else {
                    HapticFeedbackConstants.VIRTUAL_KEY
                }
            else -> return
        }

        reactContext.runOnUiQueueThread {
            // No FLAG_IGNORE_GLOBAL_SETTING anywhere here, on purpose: respecting the
            // user's choice to switch touch feedback off is the whole reason this path
            // was chosen over the Vibrator.
            reactContext.currentActivity?.window?.decorView?.performHapticFeedback(constant)
        }
    }
}
