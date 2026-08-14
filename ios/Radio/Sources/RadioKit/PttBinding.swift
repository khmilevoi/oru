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
