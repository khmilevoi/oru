import Foundation

/// §8's `audioMode` setting. `auto` runs the §7 policy; `voice` and `media` pin
/// the profile (a PTT press still raises the voice link inside a pinned
/// `media` — §7 says so by name).
///
/// The raw values are the contract strings `specs/NativeRadio.ts` publishes, so
/// a value read out of UserDefaults is directly the value that crosses the
/// bridge. `ModePolicy.AudioMode` is the same three cases without raw values;
/// the mapping lives here because `ModePolicy.swift` is merged P1 and is never
/// edited by this plan.
public enum AudioModeSetting: String, Equatable {
    case auto
    case voice
    case media

    public var policyMode: ModePolicy.AudioMode {
        switch self {
        case .auto: return .auto
        case .voice: return .voice
        case .media: return .media
        }
    }
}

/// The setting outlives radio restarts and app launches, exactly as the PTT
/// binding does (spec section 9.2).
public final class AudioModeStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// §8's default is `auto`, and so is the answer to anything unreadable —
    /// a setting nobody can parse must not leave the radio pinned.
    public func load() -> AudioModeSetting {
        guard
            let raw = defaults.string(forKey: RadioConfig.Session.audioModeDefaultsKey),
            let setting = AudioModeSetting(rawValue: raw)
        else {
            return .auto
        }
        return setting
    }

    public func save(_ setting: AudioModeSetting) {
        defaults.set(setting.rawValue, forKey: RadioConfig.Session.audioModeDefaultsKey)
    }
}
