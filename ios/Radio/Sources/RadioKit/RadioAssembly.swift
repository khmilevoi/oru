import Foundation

/// The one place production objects are wired together. Everything above the
/// engine — the Turbo Module in wave 3, the spike hooks below — goes through
/// `RadioAssembly.shared.engine` and never constructs a port itself.
public final class RadioAssembly {

    public static let shared = RadioAssembly()

    public let engine: RadioEngine
    public let ptt: PttManager

    private init() {
        let engineQueue = DispatchQueue(label: "com.oru.radio.engine")
        let transport = NearbyManager(
            queue: DispatchQueue(label: "com.oru.radio.transport")
        )
        let audio = AudioEngine(queue: DispatchQueue(label: "com.oru.radio.audio"))
        let ptt = PttManager(queue: DispatchQueue(label: "com.oru.radio.ptt"))
        // §5: every session observer re-posts onto this queue, which is the
        // engine's — that shared serial queue is what closes the data race the
        // previous session manager had on its own state.
        let background = AlwaysHotBackgroundManager(queue: engineQueue)

        self.ptt = ptt
        engine = RadioEngine(
            transport: transport,
            audio: audio,
            ptt: ptt,
            background: background,
            clock: DispatchRadioClock(queue: engineQueue),
            queue: engineQueue
        )
    }
}
