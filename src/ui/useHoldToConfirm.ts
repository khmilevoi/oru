import {useCallback, useEffect, useRef, useState} from 'react';
import {Animated, Easing} from 'react-native';

import {motion} from './theme';
import {reducedMotion} from './reducedMotion';

/**
 * The press-and-hold that guards the radio's shut-off, as a hook rather than as
 * something the key owns privately.
 *
 * It used to live inside `PowerKey`, which was right while the progress was
 * drawn inside the key. It is not right any more: the canvas now draws that
 * progress across the WHOLE SCREEN as an amber perimeter seal (`design/01
 * Radio.dc.html` frames 09-13), so the gesture's progress has to be visible to
 * the screen, not sealed inside a 56pt corner control. The screen owns the
 * hold; the key is handed the three things it needs to render and drive it.
 *
 * One `Animated.Value` for the whole thing, and one only. Every layer of the
 * seal is a width, a height or an opacity interpolated off THIS value, and
 * width/height force `useNativeDriver: false`; splitting any layer onto a
 * second, native-driven value is how two halves of one animation drift apart
 * mid-hold.
 */
export type HoldPhase =
  /** Nothing is happening. Nothing of the seal is on screen. */
  | 'idle'
  /** A finger is down and the value is running 0 -> 1, linearly. */
  | 'holding'
  /** 100% reached and committed: the closed loop is being held, then it fires. */
  | 'closing'
  /** Released early: the same value is running back to 0. */
  | 'aborting';

export type HoldToConfirm = {
  /** 0 -> 1 across the hold. The one value every layer hangs off. */
  progress: Animated.Value;
  phase: HoldPhase;
  onPressIn: () => void;
  onPressOut: () => void;
  /**
   * Drop the hold on the floor, wherever it got to, with no recede and no
   * commit. For the case a release will never come: the corner key stops
   * taking touches the moment a transmission starts, so a hold that was
   * running when one arrives would otherwise run its commit timer out and
   * power the radio off mid-transmission.
   */
  cancel: () => void;
};

/** What a key needs to render and drive a hold, and nothing more. */
export type HoldHandle = Pick<
  HoldToConfirm,
  'phase' | 'onPressIn' | 'onPressOut'
>;

export function useHoldToConfirm(onConfirm: () => void): HoldToConfirm {
  const still = reducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [phase, setPhase] = useState<HoldPhase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The handlers below are timer callbacks as much as they are event
   * handlers, so they read the phase and the reduced-motion flag through refs:
   * a `setTimeout` armed at press-in fires long after the render that armed it
   * and must not decide anything from that render's closed-over values.
   */
  const phaseNow = useRef<HoldPhase>('idle');
  const stillNow = useRef(still);
  stillNow.current = still;
  const confirmNow = useRef(onConfirm);
  confirmNow.current = onConfirm;

  const enter = useCallback((next: HoldPhase) => {
    phaseNow.current = next;
    setPhase(next);
  }, []);

  const disarm = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    disarm();
    progress.stopAnimation();
    progress.setValue(0);
    enter('idle');
  }, [disarm, enter, progress]);

  const onPressIn = useCallback(() => {
    // A second press-in with no release between them (a stray synthetic
    // event, a second finger) must not start a second timeline on the value.
    // A press DURING a recede is a different thing entirely and must be
    // honoured: the user changed their mind again, and 260ms is long enough
    // that swallowing the press would read as the key having gone dead.
    if (phaseNow.current === 'holding' || phaseNow.current === 'closing') return;

    disarm();
    progress.setValue(0);
    enter('holding');

    if (!stillNow.current) {
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.powerHoldMs,
        // LINEAR, deliberately. A hold meter that eases lies about how much of
        // the hold is left, and this one is the guard on an irreversible act.
        easing: Easing.linear,
        useNativeDriver: false,
      }).start();
    }

    timer.current = setTimeout(() => {
      timer.current = null;

      // Reduced motion has nothing to hold still FOR: there is no closed loop
      // to dwell on, because the perimeter was whole the entire time.
      if (stillNow.current) {
        cancel();
        confirmNow.current();
        return;
      }

      // Committed. `onPressOut` stops cancelling from here on: the user has
      // already held the full 1200ms, and taking the finger off during the
      // close must not undo it.
      progress.setValue(1);
      enter('closing');
      timer.current = setTimeout(() => {
        timer.current = null;
        cancel();
        confirmNow.current();
      }, motion.sealCloseMs);
    }, motion.powerHoldMs);
  }, [cancel, disarm, enter, progress]);

  const onPressOut = useCallback(() => {
    if (phaseNow.current !== 'holding') return;
    disarm();

    if (stillNow.current) {
      cancel();
      return;
    }

    enter('aborting');
    // The SAME value, run back the way it came -- never a snap to 0 and never
    // a colour flash. A recede is the only thing that reads as "nothing
    // happened"; anything sharper reads as a failure the user has to explain
    // to themselves. Starting an animation on a value replaces the one already
    // running on it, so the forward timing stops here.
    Animated.timing(progress, {
      toValue: 0,
      duration: motion.sealAbortMs,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(({finished}) => {
      // `finished` is false when a new press-in interrupted the recede, and
      // that press-in owns the phase now.
      if (finished && phaseNow.current === 'aborting') enter('idle');
    });
  }, [cancel, disarm, enter, progress]);

  useEffect(() => cancel, [cancel]);

  return {progress, phase, onPressIn, onPressOut, cancel};
}
