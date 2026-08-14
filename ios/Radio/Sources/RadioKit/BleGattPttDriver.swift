import CoreBluetooth
import Foundation
import os

protocol BleGattPttDriverDelegate: AnyObject {
    func driverDidPress(_ driver: BleGattPttDriver)
    func driverDidRelease(_ driver: BleGattPttDriver)
    func driver(_ driver: BleGattPttDriver, connectionDidChange isConnected: Bool)
    func driver(_ driver: BleGattPttDriver, didFail error: RadioError)
}

/// The GATT push-to-talk button (spec section 9.1). Background-capable: the
/// central is created with a restore identifier, so iOS relaunches the app on a
/// characteristic change with the screen locked.
public final class BleGattPttDriver: NSObject {

    private enum Mode {
        case idle
        case bound(PttBinding)
        case scanning
        case learning
    }

    weak var delegate: BleGattPttDriverDelegate?

    /// Every device seen during a learning scan, republished as the list grows.
    var onCandidates: (([PttCandidate]) -> Void)?

    /// A device has been chosen and the session moved on to capturing a press.
    var onLearningStarted: (() -> Void)?

    private let queue: DispatchQueue
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "ptt.ble"
    )

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var mode: Mode = .idle
    private var candidates: [String: PttCandidate] = [:]
    private var discovered: [String: CBPeripheral] = [:]
    private var learningCompletion: ((Result<PttConfiguration, RadioError>) -> Void)?
    private var learnedPressed: (characteristic: CBCharacteristic, value: String)?
    private var learningDeadline: DispatchWorkItem?
    private var autoSelectFallback: DispatchWorkItem?
    private var isPressed = false

    public init(queue: DispatchQueue) {
        self.queue = queue
        super.init()
    }

    private func ensureCentral() {
        guard central == nil else { return }
        central = CBCentralManager(
            delegate: self,
            queue: queue,
            options: [
                CBCentralManagerOptionRestoreIdentifierKey:
                    RadioConfig.Ptt.centralRestoreIdentifier
            ]
        )
    }

    // MARK: - Bound mode

    func bind(to binding: PttBinding) {
        ensureCentral()
        guard case let .ble(deviceId, _, _, _, _) = binding else {
            delegate?.driver(self, didFail: .pttFailed("iOS supports GATT buttons only"))
            return
        }
        mode = .bound(binding)
        guard central?.state == .poweredOn else { return }
        connectBound(deviceId: deviceId)
    }

    func unbind() {
        cancelTimers()
        if let peripheral {
            central?.cancelPeripheralConnection(peripheral)
        }
        peripheral = nil
        mode = .idle
        isPressed = false
        delegate?.driver(self, connectionDidChange: false)
    }

    private func connectBound(deviceId: String) {
        guard let uuid = UUID(uuidString: deviceId), let central else { return }
        if let known = central.retrievePeripherals(withIdentifiers: [uuid]).first {
            peripheral = known
            known.delegate = self
            // No timeout: iOS keeps this pending and connects the moment the
            // button is back in range, which is the reconnect requirement.
            central.connect(known, options: nil)
        } else {
            central.scanForPeripherals(withServices: nil, options: nil)
        }
    }

    // MARK: - Learning (spec section 9.3)

    func beginLearning(completion: @escaping (Result<PttConfiguration, RadioError>) -> Void) {
        ensureCentral()
        cancelTimers()
        learningCompletion = completion
        learnedPressed = nil
        candidates.removeAll()
        discovered.removeAll()
        mode = .scanning

        let deadline = DispatchWorkItem { [weak self] in
            self?.finishLearning(
                .failure(.pairingFailed("no button press was captured in time"))
            )
        }
        learningDeadline = deadline
        queue.asyncAfter(
            deadline: .now() + RadioConfig.Ptt.learningTimeout,
            execute: deadline
        )

        // Safety net only: the product path is `selectCandidate(deviceId:)`
        // from the UI. This exists so a build with no UI can still pair.
        let fallback = DispatchWorkItem { [weak self] in self?.pickStrongestCandidate() }
        autoSelectFallback = fallback
        queue.asyncAfter(
            deadline: .now() + RadioConfig.Ptt.autoSelectFallback,
            execute: fallback
        )

        guard central?.state == .poweredOn else { return }
        central?.scanForPeripherals(withServices: nil, options: nil)
    }

    /// The user's pick, published to the engine as `pttPairing.candidates`.
    public func selectCandidate(deviceId: String) {
        queue.async { [self] in
            guard case .scanning = mode, let target = discovered[deviceId] else { return }
            autoSelectFallback?.cancel()
            connectForLearning(target)
        }
    }

    private func pickStrongestCandidate() {
        guard case .scanning = mode else { return }
        let strongest = candidates.values.max { $0.rssi < $1.rssi }
        guard
            let strongest,
            let target = discovered[strongest.deviceId]
        else {
            finishLearning(.failure(.pairingFailed("no Bluetooth devices found")))
            return
        }
        connectForLearning(target)
    }

    private func connectForLearning(_ target: CBPeripheral) {
        mode = .learning
        autoSelectFallback?.cancel()
        central?.stopScan()
        peripheral = target
        target.delegate = self
        central?.connect(target, options: nil)
        onLearningStarted?()
        log.info("learning from \(target.name ?? "unnamed", privacy: .public)")
    }

    private func finishLearning(_ result: Result<PttConfiguration, RadioError>) {
        cancelTimers()
        central?.stopScan()
        let completion = learningCompletion
        learningCompletion = nil
        learnedPressed = nil
        if case .success = result {
            // The manager rebinds immediately; nothing to unwind here.
        } else if case .learning = mode, let peripheral {
            central?.cancelPeripheralConnection(peripheral)
            mode = .idle
        } else {
            mode = .idle
        }
        completion?(result)
    }

    private func cancelTimers() {
        learningDeadline?.cancel()
        learningDeadline = nil
        autoSelectFallback?.cancel()
        autoSelectFallback = nil
    }

    fileprivate func handleValue(_ data: Data, from characteristic: CBCharacteristic) {
        let hex = PttHex.string(from: data)

        switch mode {
        case .learning:
            guard let pressed = learnedPressed else {
                learnedPressed = (characteristic, hex)
                log.info("captured pressed value \(hex, privacy: .public)")
                return
            }
            guard
                pressed.characteristic.uuid == characteristic.uuid,
                pressed.value != hex
            else {
                return
            }
            guard
                let serviceUuid = characteristic.service?.uuid.uuidString,
                let deviceId = peripheral?.identifier.uuidString
            else {
                finishLearning(.failure(.pairingFailed("incomplete GATT description")))
                return
            }
            let configuration = PttConfiguration(
                name: peripheral?.name ?? "PTT button",
                binding: .ble(
                    deviceId: deviceId,
                    serviceUuid: serviceUuid,
                    characteristicUuid: characteristic.uuid.uuidString,
                    pressedValue: pressed.value,
                    releasedValue: hex
                )
            )
            mode = .bound(configuration.binding)
            finishLearning(.success(configuration))

        case let .bound(binding):
            guard
                case let .ble(_, _, characteristicUuid, pressedValue, releasedValue) = binding,
                characteristic.uuid.uuidString.caseInsensitiveCompare(characteristicUuid)
                    == .orderedSame
            else {
                return
            }
            if hex == pressedValue, !isPressed {
                isPressed = true
                delegate?.driverDidPress(self)
            } else if hex == releasedValue, isPressed {
                isPressed = false
                delegate?.driverDidRelease(self)
            }

        case .idle, .scanning:
            break
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension BleGattPttDriver: CBCentralManagerDelegate {

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            delegate?.driver(self, connectionDidChange: false)
            return
        }
        switch mode {
        case let .bound(binding):
            if case let .ble(deviceId, _, _, _, _) = binding {
                connectBound(deviceId: deviceId)
            }
        case .scanning:
            central.scanForPeripherals(withServices: nil, options: nil)
        case .idle, .learning:
            break
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        willRestoreState state: [String: Any]
    ) {
        let restored = state[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]
        guard let peripheral = restored?.first else { return }
        self.peripheral = peripheral
        peripheral.delegate = self
        log.info("restored \(peripheral.identifier.uuidString, privacy: .public)")
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let deviceId = peripheral.identifier.uuidString

        if case let .bound(binding) = mode,
           case let .ble(boundId, _, _, _, _) = binding,
           boundId == deviceId {
            central.stopScan()
            self.peripheral = peripheral
            peripheral.delegate = self
            central.connect(peripheral, options: nil)
            return
        }

        guard case .scanning = mode else { return }
        let name = peripheral.name
            ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? "Unnamed device"
        discovered[deviceId] = peripheral
        candidates[deviceId] = PttCandidate(
            deviceId: deviceId,
            name: name,
            rssi: RSSI.intValue
        )
        onCandidates?(Array(candidates.values).sorted { $0.rssi > $1.rssi })
    }

    public func centralManager(
        _ central: CBCentralManager,
        didConnect peripheral: CBPeripheral
    ) {
        peripheral.discoverServices(nil)
        if case .bound = mode {
            delegate?.driver(self, connectionDidChange: true)
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        if case .learning = mode {
            finishLearning(.failure(.pairingFailed("could not connect to the button")))
        } else {
            central.connect(peripheral, options: nil)
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        isPressed = false
        delegate?.driver(self, connectionDidChange: false)
        guard case .bound = mode else { return }
        // Pending indefinitely: this is the button half of "reconnects
        // automatically after signal loss" (spec section 2).
        central.connect(peripheral, options: nil)
    }
}

// MARK: - CBPeripheralDelegate

extension BleGattPttDriver: CBPeripheralDelegate {

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        for characteristic in service.characteristics ?? [] {
            let notifies = characteristic.properties.contains(.notify)
                || characteristic.properties.contains(.indicate)
            guard notifies else { continue }

            if case let .bound(binding) = mode,
               case let .ble(_, _, characteristicUuid, _, _) = binding {
                guard
                    characteristic.uuid.uuidString.caseInsensitiveCompare(characteristicUuid)
                        == .orderedSame
                else {
                    continue
                }
            }
            // In learning mode every notifying characteristic is subscribed to;
            // the one the button actually uses reveals itself on the first press.
            peripheral.setNotifyValue(true, for: characteristic)
        }
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let value = characteristic.value else { return }
        handleValue(value, from: characteristic)
    }
}
