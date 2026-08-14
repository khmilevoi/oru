import Foundation

/// Every tunable of the radio in one place, so field tests can retune the codec
/// without touching logic (spec section 8).
public enum RadioConfig {

    /// Nearby Connections service id. MUST be byte-identical to the Android engine's.
    public static let serviceId = "com.oru.radio"

    /// Version carried in the `hello` control message (spec section 7).
    public static let protocolVersion = 1

    public enum Audio {
        public static let sampleRate: Double = 16_000
        public static let channelCount: UInt32 = 1
        public static let frameDurationMs: Int = 20
        /// 16 000 Hz * 20 ms.
        public static let samplesPerFrame: Int = 320
        public static let bitrate: Int32 = 24_000
        /// Spec section 8 asks for a 2-3 frame cushion; 3 frames is 60 ms.
        public static let jitterTargetFrames: Int = 3
        /// Beyond half a second of backlog the oldest frames are dropped.
        public static let jitterMaxFrames: Int = 25
        /// Opus hard maximum for one packet.
        public static let maxEncodedFrameBytes: Int = 1_275
    }

    public enum Transmit {
        /// Stuck-button protection (spec sections 5 and 9.4).
        public static let safetyCapSeconds: TimeInterval = 120
    }

    public enum Reconnect {
        public static let initialDelay: TimeInterval = 1
        public static let multiplier: Double = 2
        public static let maxDelay: TimeInterval = 30
    }

    public enum Ptt {
        public static let learningTimeout: TimeInterval = 30
        /// Safety net only: how long the pairing session waits for the user's
        /// pick before falling back to the strongest signal. The product path is
        /// `selectPttCandidate` from the UI; this exists so Phase 0 can pair
        /// with no UI at all.
        public static let autoSelectFallback: TimeInterval = 15
        public static let bindingDefaultsKey = "radio.ptt.binding"
        public static let centralRestoreIdentifier = "com.oru.radio.ptt.central"
    }

    public enum Background {
        /// Stable PushToTalk channel identity, the same across launches.
        public static let channelUUID = UUID(
            uuidString: "6F5C1C2E-7C1B-4B7A-9F1A-2C3D4E5F6A7B"
        )!
    }

    public enum Logging {
        public static let subsystem = "com.oru.radio"
    }
}
