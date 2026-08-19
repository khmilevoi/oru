/**
 * Spec section 13, applied to the work the app starts and does not await.
 *
 * `radio.native.ts` already makes the Turbo Module boundary total: `invoke`
 * and `invokeVoid` return `NativeRadioError` values and never reject, so the
 * models above them read failure as data. `void somePromise()` throws that
 * away. It does not silence a rejection -- it *promotes* one, into React
 * Native's `Uncaught (in promise, id: N)` console error, which is a crash
 * report the app generated about itself.
 *
 * And the last rejection cannot be guarded at the boundary at all: Reatom's
 * `wrap()` rejects with an `AbortError` when the context is reset (a Fast
 * Refresh, a `context.reset()`) while it is in flight, *after* the call it
 * wrapped has already returned its failure as a value. Only the caller can
 * absorb that one.
 *
 * So bootstrap detaches instead of voiding: the promise is still not awaited,
 * but its rejection lands where every other failure in this codebase lands --
 * in the return value.
 */
export function detach<T>(promise: Promise<T>): Promise<T | Error> {
  return promise.catch((cause: unknown) =>
    // `AccessibilityInfo.isReduceMotionEnabled()` rejects with `null` on
    // Android, so a rejection reason is not reliably an `Error`; callers of
    // this helper are entitled to assume `instanceof Error` narrows it.
    cause instanceof Error ? cause : new Error(String(cause), {cause}),
  );
}
