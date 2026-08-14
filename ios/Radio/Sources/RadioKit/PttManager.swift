import Foundation
import os

/// Owns the button: persistence, the driver, and the press semantics the engine
/// consumes (spec section 9). Strictly hold-to-talk — a press starts the
/// transmission, a release ends it, and nothing else is inferred.
public final class PttManager: PttSource {

    public weak var delegate: PttSourceDelegate?
    public private(set) var buttonState = PttButtonState()

    private let queue: DispatchQueue
    private let store: PttBindingStore
    private let driver: BleGattPttDriver
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "ptt"
    )

    private var configuration: PttConfiguration?
    private var pairing: PttPairingState?

    public init(queue: DispatchQueue, defaults: UserDefaults = .standard) {
        self.queue = queue
        self.store = PttBindingStore(defaults: defaults)
        self.driver = BleGattPttDriver(queue: queue)
        self.driver.delegate = self

        configuration = store.load()
        buttonState = PttButtonState(
            configured: configuration != nil,
            connected: false,
            name: configuration?.name
        )

        driver.onCandidates = { [weak self] candidates in
            guard let self, let pairing = self.pairing, pairing.phase == .scanning else {
                return
            }
            self.publish(PttPairingState(phase: .scanning, candidates: candidates))
        }
        driver.onLearningStarted = { [weak self] in
            guard let self else { return }
            self.publish(
                PttPairingState(phase: .learning, candidates: self.pairing?.candidates ?? [])
            )
        }
    }

    public func start() {
        queue.async { [self] in
            guard let configuration else { return }
            driver.bind(to: configuration.binding)
            log.info("binding to \(configuration.name, privacy: .public)")
        }
    }

    public func stop() {
        queue.async { [self] in driver.unbind() }
    }

    public func beginLearning(
        completion: @escaping (Result<PttConfiguration, RadioError>) -> Void
    ) {
        queue.async { [self] in
            publish(PttPairingState(phase: .scanning))
            driver.beginLearning { [weak self] result in
                guard let self else { return }
                if case let .success(configuration) = result {
                    self.configuration = configuration
                    self.store.save(configuration)
                    self.publish(
                        PttPairingState(
                            phase: .saved,
                            candidates: self.pairing?.candidates ?? []
                        )
                    )
                    self.updateState(configured: true, connected: true, name: configuration.name)
                    self.log.info("learned \(configuration.name, privacy: .public)")
                }
                // The engine clears `pttPairing` once the promise resolves; the
                // `.saved` snapshot above is delivered first.
                self.pairing = nil
                completion(result)
            }
        }
    }

    public func selectCandidate(deviceId: String) {
        queue.async { [self] in driver.selectCandidate(deviceId: deviceId) }
    }

    public func forget() {
        queue.async { [self] in
            driver.unbind()
            store.clear()
            configuration = nil
            updateState(configured: false, connected: false, name: nil)
        }
    }

    private func publish(_ state: PttPairingState?) {
        guard pairing != state else { return }
        pairing = state
        delegate?.pttSource(self, pairingStateDidChange: state)
    }

    private func updateState(configured: Bool, connected: Bool, name: String?) {
        let next = PttButtonState(configured: configured, connected: connected, name: name)
        guard next != buttonState else { return }
        buttonState = next
        delegate?.pttSource(self, buttonStateDidChange: next)
    }
}

// MARK: - BleGattPttDriverDelegate

extension PttManager: BleGattPttDriverDelegate {

    func driverDidPress(_ driver: BleGattPttDriver) {
        delegate?.pttSourceDidPress(self)
    }

    func driverDidRelease(_ driver: BleGattPttDriver) {
        delegate?.pttSourceDidRelease(self)
    }

    func driver(_ driver: BleGattPttDriver, connectionDidChange isConnected: Bool) {
        updateState(
            configured: configuration != nil,
            connected: isConnected,
            name: configuration?.name
        )
    }

    func driver(_ driver: BleGattPttDriver, didFail error: RadioError) {
        log.error("\(error.message, privacy: .public)")
    }
}
