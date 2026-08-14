import Foundation

/// The reliable BYTES control protocol of spec section 7. The JSON shape is a
/// cross-platform contract: the Android engine and the TypeScript codec parse the
/// exact same three objects.
public enum ControlMessage: Equatable {
    case hello(version: Int)
    case txStart(streamId: String)
    case txStop(streamId: String)

    private enum Wire {
        static let type = "type"
        static let version = "version"
        static let streamId = "streamId"
        static let hello = "hello"
        static let txStart = "tx-start"
        static let txStop = "tx-stop"
    }

    public func encoded() -> Data {
        let object: [String: Any]
        switch self {
        case let .hello(version):
            object = [Wire.type: Wire.hello, Wire.version: version]
        case let .txStart(streamId):
            object = [Wire.type: Wire.txStart, Wire.streamId: streamId]
        case let .txStop(streamId):
            object = [Wire.type: Wire.txStop, Wire.streamId: streamId]
        }
        // The three shapes above are always serialisable, so the failure branch is
        // unreachable; an empty payload is decoded as nil by the peer either way.
        return (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }

    public static func decode(_ data: Data) -> ControlMessage? {
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let json = object as? [String: Any],
            let type = json[Wire.type] as? String
        else {
            return nil
        }

        switch type {
        case Wire.hello:
            guard let version = json[Wire.version] as? Int else { return nil }
            return .hello(version: version)
        case Wire.txStart:
            guard let streamId = json[Wire.streamId] as? String else { return nil }
            return .txStart(streamId: streamId)
        case Wire.txStop:
            guard let streamId = json[Wire.streamId] as? String else { return nil }
            return .txStop(streamId: streamId)
        default:
            return nil
        }
    }
}
