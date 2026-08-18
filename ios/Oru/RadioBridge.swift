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

    /// Set by the Turbo Module once React Native can carry events.
    @objc public var onStateChanged: ((NSDictionary) -> Void)?
    @objc public var onError: ((NSDictionary) -> Void)?

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
        onStateChanged?(state)
        engine.startRadio()
    }

    @objc public func stop() {
        lock.lock()
        running = false
        failed = false
        lastState = nil
        let state = projectLocked()
        lock.unlock()

        failPairing(code: "pairing_cancelled", message: "Pairing cancelled: the radio stopped")
        onStateChanged?(state)
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

    // MARK: - Engine events

    private var pendingReject: ((NSString, NSString) -> Void)?

    /// Distinguishes one `configurePtt` session from the next, so a late
    /// completion from a superseded session cannot settle the current one's
    /// promise. The Android core gets this from its single `pairing` field.
    private var pairingSession = 0

    private func handle(state: RadioState) {
        lock.lock()
        lastState = state
        let projected = projectLocked()
        lock.unlock()

        onStateChanged?(projected)
    }

    private func handle(error: RadioError) {
        onError?(["code": error.code, "message": error.message] as NSDictionary)
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
        return state.asDictionary as NSDictionary
    }

    /// `radio.native.mock.ts`'s `toOffState()` + `preservedButton()`: the button
    /// survives a power cycle (section 9.2 stores it natively) but is never
    /// reported connected while nothing is running.
    private func offDictionary(status: String) -> NSDictionary {
        var button = RadioAssembly.shared.ptt.buttonState
        button.connected = false

        return [
            "status": status,
            "nearbyCount": 0,
            "transmitting": false,
            "receiving": false,
            "pttButton": button.asDictionary
        ] as NSDictionary
    }
}
