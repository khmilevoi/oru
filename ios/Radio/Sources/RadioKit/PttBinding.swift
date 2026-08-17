import Foundation

/// Spec section 9.2, field for field. The `hid` case exists so a binding written
/// by the Android engine parses here; iOS cannot drive background PTT from HID.
public enum PttBinding: Equatable {
    case ble(
        deviceId: String,
        serviceUuid: String,
        characteristicUuid: String,
        pressedValue: String,
        releasedValue: String
    )
    case hid(keyCode: Int)

    public var asDictionary: [String: Any] {
        switch self {
        case let .ble(deviceId, serviceUuid, characteristicUuid, pressed, released):
            return [
                "type": "ble",
                "deviceId": deviceId,
                "serviceUuid": serviceUuid,
                "characteristicUuid": characteristicUuid,
                "pressedValue": pressed,
                "releasedValue": released
            ]
        case let .hid(keyCode):
            return ["type": "hid", "keyCode": keyCode]
        }
    }

    public static func from(dictionary: [String: Any]) -> PttBinding? {
        switch dictionary["type"] as? String {
        case "ble":
            guard
                let deviceId = dictionary["deviceId"] as? String,
                let serviceUuid = dictionary["serviceUuid"] as? String,
                let characteristicUuid = dictionary["characteristicUuid"] as? String,
                let pressed = dictionary["pressedValue"] as? String,
                let released = dictionary["releasedValue"] as? String
            else {
                return nil
            }
            return .ble(
                deviceId: deviceId,
                serviceUuid: serviceUuid,
                characteristicUuid: characteristicUuid,
                pressedValue: pressed,
                releasedValue: released
            )
        case "hid":
            guard let keyCode = dictionary["keyCode"] as? Int else { return nil }
            return .hid(keyCode: keyCode)
        default:
            return nil
        }
    }
}

/// What the learning flow produces (spec section 6.1 `PttConfiguration`).
public struct PttConfiguration: Equatable {
    public let name: String
    public let binding: PttBinding

    public init(name: String, binding: PttBinding) {
        self.name = name
        self.binding = binding
    }

    public var asDictionary: [String: Any] {
        ["name": name, "binding": binding.asDictionary]
    }

    public static func from(dictionary: [String: Any]) -> PttConfiguration? {
        guard
            let name = dictionary["name"] as? String,
            let bindingDictionary = dictionary["binding"] as? [String: Any],
            let binding = PttBinding.from(dictionary: bindingDictionary)
        else {
            return nil
        }
        return PttConfiguration(name: name, binding: binding)
    }
}

/// Characteristic values travel as lowercase hex with no separators.
public enum PttHex {
    public static func string(from data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    public static func data(from string: String) -> Data? {
        let characters = Array(string.lowercased())
        guard characters.count % 2 == 0 else { return nil }
        var bytes = Data(capacity: characters.count / 2)
        for index in stride(from: 0, to: characters.count, by: 2) {
            guard let byte = UInt8(String(characters[index...index + 1]), radix: 16) else {
                return nil
            }
            bytes.append(byte)
        }
        return bytes
    }

    /// True for hex strings that decode to only zero bytes ("00", "0000", ...).
    public static func isAllZero(_ hex: String) -> Bool {
        !hex.isEmpty && hex.allSatisfy { $0 == "0" }
    }
}

/// The completion rule of the learning flow (spec section 9.3), mirrored
/// rule-for-rule by the Android engine's `PttLearningStateMachine`.
///
/// Order of appearance alone is not enough to tell which of the two captured
/// values is the press. Telink-style buttons (PTT-Z01) push their *current*
/// state — the idle all-zero bytes — the moment the CCCD subscription lands, so
/// the first value seen is usually `00`, not the press; latching it as
/// pressedValue inverted every binding (transmit on release). So: when exactly
/// one of the two values is all-zero bytes, the nonzero value is pressedValue
/// and the zero value is releasedValue, regardless of arrival order. When
/// neither (or both) is all-zero there is nothing better to go on — some
/// buttons use two nonzero codes — so order of appearance decides.
public enum PttLearnedValues {
    public static func ordered(
        first: String,
        second: String
    ) -> (pressed: String, released: String) {
        if PttHex.isAllZero(first), !PttHex.isAllZero(second) {
            return (pressed: second, released: first)
        }
        return (pressed: first, released: second)
    }
}

/// The binding outlives radio restarts and app launches (spec section 9.2).
public final class PttBindingStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> PttConfiguration? {
        guard
            let data = defaults.data(forKey: RadioConfig.Ptt.bindingDefaultsKey),
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any]
        else {
            return nil
        }
        return PttConfiguration.from(dictionary: dictionary)
    }

    public func save(_ configuration: PttConfiguration) {
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: configuration.asDictionary
            )
        else {
            return
        }
        defaults.set(data, forKey: RadioConfig.Ptt.bindingDefaultsKey)
    }

    public func clear() {
        defaults.removeObject(forKey: RadioConfig.Ptt.bindingDefaultsKey)
    }
}
