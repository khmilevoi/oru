import {RadioNative} from '../radio/radio.native';

/**
 * Which controls buzz, and what they feel like. The product decision lives
 * here in one file so it can be read, argued with and re-tuned in one place —
 * call sites name an *intent* ("transmit just started") and never an effect,
 * let alone a vibration duration.
 *
 * It sits in `src/app` rather than `src/ui` for a reason enforced by
 * `__tests__/ui-independence.test.ts`: spec section 6.4 forbids anything under
 * `src/ui` or `src/screens` from touching a native binding, and this module
 * has to call one. Its neighbour `locale.model.ts` is here for exactly the
 * same reason — both are app concerns that use the section 6.1 bridge as a
 * plain leaf with no engine behind it.
 *
 * ## Which controls are key, and why the rest stay silent
 *
 * The owner asked for the key controls only, so the list is short and the
 * exclusions are deliberate rather than pending:
 *
 *  - **Push-to-talk press and release** (`RadioScreen`'s talk area). The app's
 *    one physical action, and the one performed with the phone in a pocket or
 *    at arm's length. Press and release are given deliberately *different*
 *    effects — a firm impact against a light one — because the whole value of
 *    a haptic here is telling transmit-started from transmit-ended without
 *    looking. The same buzz twice would carry no information at all.
 *  - **Radio on and radio off** (`PowerKey` via `RadioScreen`). A power state
 *    the user must be certain of. Off is the *completion* of a press-and-hold,
 *    which the canvas already specifies a haptic for: "THE CLOSE IS ANNOUNCED
 *    BY THAT FLASH AND A HAPTIC" (`design/01 Radio.dc.html:446`). An aborted
 *    hold stays silent — that falls out of wiring the intent to `onActivate`,
 *    which a released-too-early hold never reaches.
 *  - **Pairing saved** (`PairingFlow`). The end of a wait the user is actively
 *    watching for, and the one moment here that is a result rather than a
 *    press, so it takes the notification effect rather than an impact.
 *
 * Everything else stays silent, and should stay that way. Not haptic: back
 * chevrons, Cancel, Skip, Replace, the onboarding Allow / Open-settings
 * buttons, the pairing candidate rows and Done, and the Settings segmented
 * controls (audio mode, language). They are ordinary navigation and
 * configuration, performed while looking at the screen, and a buzz on each
 * would spend the vocabulary's whole meaning on noise: if everything buzzes,
 * nothing is being announced.
 *
 * Settings' **Test** key is the interesting exclusion, because it drives the
 * very same `pressPtt`/`releasePtt` as the talk area. It stays silent on
 * purpose. Its job is to prove that the *external* button works, and the user
 * is watching the screen while pressing it; a phone buzz there is a second
 * sensation competing with the one under test, and eyes-free confirmation —
 * the entire reason the talk area buzzes — does not apply to a control you are
 * looking at. `__tests__/haptics.test.tsx` pins that, so it cannot be
 * "completed" by accident later.
 *
 * There is deliberately no user-facing on/off setting: it was not asked for.
 * Adding one later means gating `fire` below on an atom and nothing else,
 * which is why every intent funnels through that single function.
 */

/**
 * The platform effects, named once. These are the only strings that cross the
 * bridge; `ios/Oru/RadioBridge.swift` and
 * `android/app/src/main/java/com/oru/bridge/HapticPlayer.kt` translate them and
 * must agree with this list exactly.
 */
export type HapticEffect =
  | 'impactLight'
  | 'impactMedium'
  | 'impactHeavy'
  | 'notificationSuccess';

/** What a call site is allowed to mean. */
export type HapticIntent =
  | 'transmitStart'
  | 'transmitEnd'
  | 'powerOn'
  | 'powerOff'
  | 'paired';

/**
 * The policy itself: intent in, platform effect out.
 *
 * The weights are chosen relative to each other, not in isolation. Transmit
 * start is the heaviest thing the app does and release is the lightest, so the
 * pair reads as open/close under a finger. Power-on sits between them —
 * definite, but not the same event as going live. Power-off borrows the heavy
 * impact because it is the other irreversible-feeling commitment, and it can
 * never be confused with transmit start: the corner key is untouchable while
 * the radio is live, and the two never fire in the same state.
 */
export const HAPTIC_EFFECTS: Record<HapticIntent, HapticEffect> = {
  transmitStart: 'impactHeavy',
  transmitEnd: 'impactLight',
  powerOn: 'impactMedium',
  powerOff: 'impactHeavy',
  paired: 'notificationSuccess',
};

export type PerformHaptic = (effect: HapticEffect) => Promise<unknown>;

export type Haptics = Record<HapticIntent, () => void>;

/**
 * Injectable for the same reason `createRadioNative` is: the degradation paths
 * — no native method, a rejecting one — are the whole point of this module and
 * have to be provable without a device.
 */
export function createHaptics(perform: PerformHaptic): Haptics {
  /**
   * Returns `void`, never a promise, so that no call site can await a buzz,
   * chain onto one, or be rejected by one. Both failure shapes are swallowed
   * here: `perform` throwing synchronously (the method is missing outright,
   * because the native binary predates this bundle) and the promise rejecting
   * (no haptic engine, or the OS refused). Feedback is decoration — an
   * interaction that broke because the phone could not buzz would be a far
   * worse bug than a silent one.
   */
  const fire = (intent: HapticIntent): void => {
    try {
      const played = perform(HAPTIC_EFFECTS[intent]);
      // `Promise.resolve` because a stubbed or older `perform` may hand back
      // something that is not a promise at all; attaching the handler
      // unconditionally is what keeps a rejection from ever reaching the
      // process as an unhandled one.
      void Promise.resolve(played).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // Deliberately empty: see above.
    }
  };

  return {
    transmitStart: () => fire('transmitStart'),
    transmitEnd: () => fire('transmitEnd'),
    powerOn: () => fire('powerOn'),
    powerOff: () => fire('powerOff'),
    paired: () => fire('paired'),
  };
}

/** What the screens import. */
export const haptics = createHaptics(effect => RadioNative.performHaptic(effect));
