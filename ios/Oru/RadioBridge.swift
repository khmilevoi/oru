import Foundation
import RadioKit

/// Spec section 6.1, on iOS. The twin of `com.oru.bridge.RadioBridgeCore`: every
/// decision the bridge makes lives here, and `NativeRadioModule.mm` does nothing
/// but marshal.
///
/// Section 6.1's `status: 'off'` is the state the radio is in before `start()`
/// and after `stop()`. `RadioEngine` has no `off` status -- `stopRadioLocked()`
/// resets to `.starting` and emits it -- so this class masks every engine
/// snapshot while the radio is stopped, exactly as the Android core does, and
/// exactly as `radio.native.mock.ts`'s `toOffState()` describes.
///
/// The button in the off state comes from `RadioAssembly.shared.ptt.buttonState`
/// rather than from the engine's own snapshot: `PttManager.init` loads it from
/// persistent storage, while `RadioEngine.state.pttButton` stays at its default
/// until the first `startRadio()`. That is the iOS counterpart of Android's
/// `PttBindingStore.load()`.
///
/// Threading: engine events arrive on the engine's queue while the module calls
/// in from the JS thread, so every mutable field is guarded by `lock`. Output
/// closures are invoked outside the lock -- they hop into React Native and must
/// not hold it while they do.
@objc(ORURadioBridge)
public final class RadioBridge: NSObject {

    @objc public static let shared = RadioBridge()

    @objc(setHandlersWithOwner:onStateChanged:onError:)
    public func setHandlers(
        owner: AnyObject,
        onStateChanged: @escaping (NSDictionary) -> Void,
        onError: @escaping (NSDictionary) -> Void
    ) {
        lock.lock()
        handlerOwner = owner
        self.onStateChanged = onStateChanged
        self.onError = onError
        lock.unlock()
    }

    /// Clears the handlers only if `owner` still owns them, and reports whether
    /// it did. A module torn down after a newer one attached must not mute it.
    @objc(clearHandlersWithOwner:)
    public func clearHandlers(owner: AnyObject) -> Bool {
        lock.lock()
        let owns = handlerOwner === owner
        if owns {
            handlerOwner = nil
            onStateChanged = nil
            onError = nil
        }
        lock.unlock()
        return owns
    }

    /// Copies the handler under the lock and calls it outside -- the same
    /// discipline `failPairing` uses.
    private func emit(state: NSDictionary) {
        lock.lock()
        let handler = onStateChanged
        lock.unlock()
        handler?(state)
    }

    private func emit(error payload: NSDictionary) {
        lock.lock()
        let handler = onError
        lock.unlock()
        handler?(payload)
    }

    /// Set by the Turbo Module once React Native can carry events.
    /// Guarded by `lock`: written from the JS thread, read from the engine
    /// queue. An unsynchronised closure property is an ARC race, and the window
    /// is teardown -- which is exactly when it happens.
    ///
    /// `owner` makes the handoff safe across a React Native reload. A stale
    /// module's `invalidate` must not silently mute the handlers a newer module
    /// has already installed on this singleton, which would leave JavaScript
    /// deaf until the app restarts.
    private var onStateChanged: ((NSDictionary) -> Void)?
    private var onError: ((NSDictionary) -> Void)?
    private weak var handlerOwner: AnyObject?

    private let engine = RadioAssembly.shared.engine
    private let observerId = "bridge"
    private let lock = NSLock()

    private var running = false
    private var failed = false
    private var attached = false
    private var lastState: RadioState?

    private override init() {
        super.init()
    }

    // MARK: - Lifetime

    /// Registered on the first call from JavaScript, not at construction:
    /// `addObserver` replays the current state immediately, and the Turbo
    /// Module's event emitter callback only exists once JS has the module.
    @objc public func attach() {
        lock.lock()
        let alreadyAttached = attached
        attached = true
        lock.unlock()
        guard !alreadyAttached else { return }

        engine.addObserver(observerId) { [weak self] event in
            guard let self else { return }
            switch event {
            case let .stateChanged(state):
                self.handle(state: state)
            case let .error(error):
                self.handle(error: error)
            }
        }
    }

    @objc public func detach() {
        lock.lock()
        let wasAttached = attached
        attached = false
        lock.unlock()
        guard wasAttached else { return }

        engine.removeObserver(observerId)
        failPairing(code: "bridge_detached", message: "The radio bridge was torn down")
    }

    // MARK: - Section 6.1

    @objc public func start() {
        lock.lock()
        running = true
        failed = false
        lastState = nil
        let state = projectLocked()
        lock.unlock()

        // Published before the promise resolves: `radio.model.ts` never writes
        // its mirror from a call's return value.
        emit(state: state)
        engine.startRadio()
        // Same reason as Android: startRadioLocked() no-ops while already
        // started and failLocked() does not clear `isStarted`, so a section 13
        // restart can be a no-op. getState hops the engine queue and therefore
        // reports the post-start truth.
        engine.getState { [weak self] state in
            self?.handle(state: state)
        }
    }

    @objc public func stop() {
        lock.lock()
        running = false
        failed = false
        lastState = nil
        let state = projectLocked()
        lock.unlock()

        failPairing(code: "pairing_cancelled", message: "Pairing cancelled: the radio stopped")
        emit(state: state)
        engine.stopRadio()
    }

    @objc public func pressPtt() {
        engine.startTransmit()
    }

    @objc public func releasePtt() {
        engine.stopTransmit()
    }

    @objc public func snapshot() -> NSDictionary {
        lock.lock()
        defer { lock.unlock() }
        return projectLocked()
    }

    /// The engine already resolves this one itself, so unlike Android there is
    /// no `saved`-phase watching here. It also works with the radio stopped:
    /// `PttManager` outlives `startRadio()`/`stopRadio()` on iOS, where on
    /// Android the drivers live inside the foreground service. The difference is
    /// recorded in `docs/stage3-bridge-acceptance.md`.
    @objc public func configurePtt(
        _ resolve: @escaping (NSDictionary) -> Void,
        reject: @escaping (NSString, NSString) -> Void
    ) {
        lock.lock()
        let superseded = pendingReject
        pairingSession += 1
        let session = pairingSession
        pendingReject = reject
        lock.unlock()

        // `beginPairing` on Android fails a still-pending session before arming
        // a new one. Without this the earlier promise would simply never settle.
        superseded?(
            "pairing_superseded" as NSString,
            "A new pairing session replaced this one" as NSString
        )

        engine.configurePtt { [weak self] result in
            guard let self else { return }

            // Claim the right to settle. `failPairing` may already have
            // rejected this session -- from `stop()`, from `detach()`, or from
            // any section 13 error event arriving mid-pairing -- and a newer
            // session may have superseded it. In either case this completion is
            // late and must be dropped rather than settling the promise twice.
            self.lock.lock()
            let claimed = self.pairingSession == session && self.pendingReject != nil
            if claimed {
                self.pendingReject = nil
            }
            self.lock.unlock()

            guard claimed else { return }

            switch result {
            case let .success(configuration):
                resolve(configuration.asDictionary as NSDictionary)
            case let .failure(error):
                reject(error.code as NSString, error.message as NSString)
            }
        }
    }

    @objc public func selectPttCandidate(_ deviceId: String) {
        engine.selectPttCandidate(deviceId: deviceId)
    }

    @objc public func forgetPtt() {
        engine.forgetPtt()
    }

    /// §8. Stores the setting natively (through the engine, which owns the
    /// UserDefaults write) and applies it. `specs/NativeRadio.ts` requires an
    /// `onStateChanged` emission before the promise resolves, so the new value
    /// is projected here and now — the same trick `start()` uses for `running`
    /// — and the engine's own snapshot supersedes it when it arrives.
    ///
    /// An unparseable value changes nothing but is still answered with a state
    /// emission, so a confused JavaScript mirror re-syncs to the truth.
    @objc public func setAudioMode(_ mode: String) {
        let setting = AudioModeSetting(rawValue: mode)

        lock.lock()
        pendingAudioMode = setting
        let projected = projectLocked()
        lock.unlock()

        emit(state: projected)
        guard let setting else { return }
        engine.setAudioMode(setting)
    }

    /// Set the moment `setAudioMode` is called, cleared when the engine's own
    /// snapshot agrees. Guarded by `lock` like every other mutable field here.
    private var pendingAudioMode: AudioModeSetting?

    // MARK: - Amended §12.2 (2026-08-19): the in-app language override

    /// A plain store, unlike `setAudioMode` above: there is no engine to apply
    /// a locale to and no `onStateChanged` echo — JavaScript owns activating
    /// the catalog. Stored here rather than in RadioKit because the locale is
    /// an app concern with no engine counterpart. Nil means no override was
    /// ever chosen: the app follows the system locale.
    private static let appLocaleKey = "com.oru.appLocale"

    @objc public func appLocale() -> NSString? {
        UserDefaults.standard.string(forKey: Self.appLocaleKey) as NSString?
    }

    @objc public func setAppLocale(_ locale: String) {
        UserDefaults.standard.set(locale, forKey: Self.appLocaleKey)
    }

    // MARK: - Engine events

    private var pendingReject: ((NSString, NSString) -> Void)?

    /// Distinguishes one `configurePtt` session from the next, so a late
    /// completion from a superseded session cannot settle the current one's
    /// promise. The Android core gets this from its single `pairing` field.
    private var pairingSession = 0

    private func handle(state: RadioState) {
        lock.lock()
        lastState = state
        if state.audioMode == pendingAudioMode {
            pendingAudioMode = nil
        }
        let projected = projectLocked()
        lock.unlock()

        emit(state: projected)
    }

    private func handle(error: RadioError) {
        emit(error: ["code": error.code, "message": error.message] as NSDictionary)
        // Section 13's error stream is the only failure channel the contract
        // has, and a pairing session cannot outlive the radio that hosts it.
        failPairing(code: error.code, message: error.message)
    }

    private func failPairing(code: String, message: String) {
        lock.lock()
        let reject = pendingReject
        pendingReject = nil
        lock.unlock()

        reject?(code as NSString, message as NSString)
    }

    // MARK: - Projection

    /// The same store the engine writes, read directly so the off state can
    /// report the real setting without hopping the engine queue under `lock`.
    private let audioModeStore = AudioModeStore()

    /// Caller holds `lock`.
    private func projectLocked() -> NSDictionary {
        if failed {
            return offDictionary(status: "error")
        }
        if !running {
            return offDictionary(status: "off")
        }
        guard let state = lastState else {
            return offDictionary(status: "starting")
        }

        var dictionary = state.asDictionary
        if let pendingAudioMode {
            dictionary["audioMode"] = pendingAudioMode.rawValue
        }
        return dictionary as NSDictionary
    }

    /// `radio.native.mock.ts`'s `toOffState()` + `preservedButton()`: the button
    /// survives a power cycle (section 9.2 stores it natively) but is never
    /// reported connected while nothing is running.
    ///
    /// The route reported with the radio off is the honest one: with no session
    /// there is no route, and §9's first row is the loudspeaker in VOICE. The
    /// setting, by contrast, is real — it is read from the same store the
    /// engine writes, so the settings screen shows the truth before the radio
    /// has ever started.
    private func offDictionary(status: String) -> NSDictionary {
        // `buttonState` does a `queue.sync` onto PttManager's own queue while we
        // hold `lock`. Analysed and safe: that queue is `com.oru.radio.ptt`,
        // distinct from the engine's `com.oru.radio.engine`, and nothing running
        // on it ever blocks on the engine queue or on this lock -- every
        // PttSourceDelegate hop is `queue.async`. There is no cycle to deadlock.
        var button = RadioAssembly.shared.ptt.buttonState
        button.connected = false

        return [
            "status": status,
            "nearbyCount": 0,
            "transmitting": false,
            "receiving": false,
            "pttButton": button.asDictionary,
            "audioRoute": AudioRoute().asDictionary,
            "audioMode": (pendingAudioMode ?? audioModeStore.load()).rawValue
        ] as NSDictionary
    }
}
