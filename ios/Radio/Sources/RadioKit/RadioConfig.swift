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
        /// Transmit-path software makeup gain, applied to the 16 kHz PCM just
        /// before the Opus encoder (hardware finding 2026-08-17: iPhone
        /// capture is quiet on the Android side). 2.0 ≈ +6 dB; 1.0 restores
        /// today's bit-exact path.
        public static let captureGain: Float = 2.0
        /// How often the transmit path writes a `tx level` heartbeat line.
        public static let txMeterSeconds: TimeInterval = 2
        /// How often the keep-alive tap writes an `idle level` line, so the
        /// idle mic floor and the transmit level can be compared.
        public static let idleMeterSeconds: TimeInterval = 30
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

    /// How the app earns the right to run while locked (spec section 10.2):
    /// one continuously active `.playAndRecord` session under the `audio`
    /// UIBackgroundMode, kept warm by `AlwaysHotBackgroundManager` and
    /// `AudioEngine`'s keep-alive tap. There is no second mode — the system
    /// PushToTalk framework was dropped on 2026-08-18 because its entitlement
    /// requires a paid Apple Developer account.
    public enum Background {
        /// How often the always-hot heartbeat appends a line to heartbeat.log.
        public static let heartbeatSeconds: TimeInterval = 10
    }

    public enum Spike {
        /// Debug builds only: the UDP port `SpikeCommandServer` listens on for
        /// Phase 0 commands from a Mac on the same Wi-Fi (iOS has no adb).
        public static let commandPort: UInt16 = 47999
    }

    public enum Logging {
        public static let subsystem = "com.oru.radio"
    }
}
