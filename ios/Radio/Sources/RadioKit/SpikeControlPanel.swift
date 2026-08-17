#if DEBUG
import AVFoundation
import SwiftUI
import UIKit

/// Phase 0, debug builds only: a native SwiftUI twin of the UDP command
/// vocabulary in `SpikeCommandServer` — the same five spike hooks, but driven
/// by touch instead of `nc` datagrams. Presented over the stock React Native
/// template screen from `AppDelegate` (`SpikeControlPanelPresenter.attach`);
/// the server stays up alongside it.
///
/// State is push-wired: the model registers an engine observer exactly the way
/// `RadioSpike.bootstrap()` does, and every `stateChanged` snapshot is hopped
/// onto the main queue for SwiftUI. No polling.

// MARK: - Model

final class SpikeControlModel: ObservableObject {

    enum PairingOutcome: Equatable {
        case saved(String)
        case failed(String)
    }

    @Published private(set) var state = RadioState()
    /// Set while `pttPairing.phase == .learning`: when the 30 s window
    /// (`RadioConfig.Ptt.learningTimeout`) slams shut.
    @Published private(set) var learningDeadline: Date?
    /// Sticks around after the session ends so the result stays visible.
    @Published private(set) var outcome: PairingOutcome?
    @Published var pttPressed = false
    /// Compact current audio route ("→ Speaker / ← iPhone mic"), refreshed on
    /// every engine state push and on AVAudioSession route notifications.
    @Published private(set) var routeLine = SpikeControlModel.currentRouteLine()

    private var routeObserver: NSObjectProtocol?

    init() {
        // Same subscription surface as RadioSpike's "spike" observer; the
        // engine replays the current snapshot on registration, so the panel is
        // in sync from first render.
        RadioAssembly.shared.engine.addObserver("spike-panel") { [weak self] event in
            DispatchQueue.main.async { self?.handle(event) }
        }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] _ in
            self?.routeLine = Self.currentRouteLine()
        }
    }

    deinit {
        if let routeObserver {
            NotificationCenter.default.removeObserver(routeObserver)
        }
    }

    private static func currentRouteLine() -> String {
        AudioRouteFormatter.compact(AVAudioSession.sharedInstance().currentRoute)
    }

    private func handle(_ event: RadioEvent) {
        switch event {
        case let .stateChanged(newState):
            let previousPhase = state.pttPairing?.phase
            state = newState
            routeLine = Self.currentRouteLine()
            switch newState.pttPairing?.phase {
            case .scanning:
                outcome = nil
                learningDeadline = nil
            case .learning:
                if previousPhase != .learning {
                    learningDeadline = Date()
                        .addingTimeInterval(RadioConfig.Ptt.learningTimeout)
                }
            case .saved:
                learningDeadline = nil
            case nil:
                learningDeadline = nil
                if previousPhase == .saved {
                    outcome = .saved(newState.pttButton.name ?? "PTT button")
                }
            }
        case let .error(error):
            if error.code == "pairing_failed" || error.code == "ptt_failed" {
                learningDeadline = nil
                outcome = .failed(error.message)
            }
        }
    }

    /// Strongest signal first, the same ordering the driver emits.
    var candidates: [PttCandidate] {
        (state.pttPairing?.candidates ?? []).sorted { $0.rssi > $1.rssi }
    }

    // MARK: Spike hooks
    // All five run on the main queue — the same place SpikeCommandServer
    // dispatches them to; SwiftUI actions already arrive there.

    func pttDown() { RadioSpike.startTransmit() }
    func pttUp() { RadioSpike.stopTransmit() }

    func scan() {
        outcome = nil
        RadioSpike.configurePtt()
    }

    func pick(_ deviceId: String) { RadioSpike.selectPttCandidate(deviceId) }

    func forget() {
        outcome = nil
        RadioSpike.forgetPtt()
    }
}

// MARK: - View

struct SpikeControlPanel: View {

    @StateObject private var model = SpikeControlModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    stateHeader
                    pttButton
                    pairingSection
                }
                .padding()
            }
            .navigationTitle("Radio Spike")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    // MARK: Header

    private var stateHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                statusBadge
                Label("\(model.state.nearbyCount)", systemImage: "person.2.fill")
                    .font(.subheadline.monospacedDigit())
                Spacer()
                indicator("TX", active: model.state.transmitting, color: .red)
                indicator("RX", active: model.state.receiving, color: .green)
            }
            buttonStateLine
            routeStateLine
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var statusBadge: some View {
        let color: Color = switch model.state.status {
        case .ready: .green
        case .starting: .yellow
        case .error: .red
        }
        return Label(model.state.status.rawValue, systemImage: "dot.radiowaves.left.and.right")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(color)
    }

    private func indicator(_ title: String, active: Bool, color: Color) -> some View {
        Text(title)
            .font(.caption.weight(.bold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(active ? color : Color(.systemGray5))
            .foregroundStyle(active ? .white : .secondary)
            .clipShape(Capsule())
    }

    private var buttonStateLine: some View {
        let button = model.state.pttButton
        let text: String = if !button.configured {
            "Button: not configured"
        } else {
            "Button: \(button.name ?? "unnamed") — "
                + (button.connected ? "connected" : "disconnected")
        }
        return HStack(spacing: 6) {
            Image(systemName: button.configured
                ? (button.connected ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash")
                : "questionmark.circle")
                .foregroundStyle(button.connected ? .green : .secondary)
            Text(text).font(.footnote)
        }
    }

    private var routeStateLine: some View {
        HStack(spacing: 6) {
            Image(systemName: "speaker.wave.2")
                .foregroundStyle(.secondary)
            Text(model.routeLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    // MARK: PTT

    private var pttButton: some View {
        Text(model.pttPressed ? "TRANSMITTING" : "HOLD TO TALK")
            .font(.title2.weight(.heavy))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 160)
            .background(model.pttPressed ? Color.red : Color.accentColor)
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !model.pttPressed else { return }
                        model.pttPressed = true
                        model.pttDown()
                    }
                    .onEnded { _ in
                        model.pttPressed = false
                        model.pttUp()
                    }
            )
    }

    // MARK: Pairing

    private var pairingSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("PTT Button Pairing").font(.headline)
                Spacer()
                Button("Scan") { model.scan() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.state.pttPairing != nil)
                Button("Forget", role: .destructive) { model.forget() }
                    .buttonStyle(.bordered)
                    .disabled(!model.state.pttButton.configured)
            }

            if let pairing = model.state.pttPairing {
                pairingBody(pairing)
            }

            if let outcome = model.outcome {
                outcomeLine(outcome)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func pairingBody(_ pairing: PttPairingState) -> some View {
        switch pairing.phase {
        case .scanning:
            HStack(spacing: 8) {
                ProgressView()
                Text("Scanning… tap your button below")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            candidateList
        case .learning:
            VStack(alignment: .leading, spacing: 4) {
                Text("PRESS THE BUTTON NOW")
                    .font(.title3.weight(.heavy))
                    .foregroundStyle(.orange)
                HStack(spacing: 4) {
                    Text("Press it twice within")
                    if let deadline = model.learningDeadline {
                        Text(timerInterval: Date()...deadline, countsDown: true)
                            .monospacedDigit()
                            .fontWeight(.bold)
                    } else {
                        Text("\(Int(RadioConfig.Ptt.learningTimeout)) s")
                    }
                }
                .font(.subheadline)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Color.orange.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        case .saved:
            Label("Saved", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.subheadline.weight(.semibold))
        }
    }

    private var candidateList: some View {
        VStack(spacing: 6) {
            ForEach(model.candidates, id: \.deviceId) { candidate in
                candidateRow(candidate)
            }
        }
    }

    private func candidateRow(_ candidate: PttCandidate) -> some View {
        let named = candidate.name != "Unnamed device"
        let isPttHardware = candidate.name.localizedCaseInsensitiveContains("PTT")
        return Button {
            model.pick(candidate.deviceId)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(named ? candidate.name : String(candidate.deviceId.prefix(8)))
                        .font(.subheadline.weight(named ? .semibold : .regular))
                        .foregroundStyle(named ? .primary : .secondary)
                    if named {
                        Text(String(candidate.deviceId.prefix(8)))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text("\(candidate.rssi) dBm")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(8)
            .background(isPttHardware ? Color.green.opacity(0.15) : Color(.tertiarySystemBackground))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(isPttHardware ? Color.green : .clear, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    private func outcomeLine(_ outcome: SpikeControlModel.PairingOutcome) -> some View {
        switch outcome {
        case let .saved(name):
            Label("Saved: \(name)", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.subheadline.weight(.semibold))
        case let .failed(message):
            Label("Failed: \(message)", systemImage: "xmark.octagon.fill")
                .foregroundStyle(.red)
                .font(.subheadline.weight(.semibold))
        }
    }
}

// MARK: - Presentation

/// Shows the panel in its own window above the app's — the RN root view
/// finishes loading asynchronously and would cover any child view controller
/// attached to it earlier, so the panel cannot live inside that hierarchy.
public enum SpikeControlPanelPresenter {

    private static var overlay: UIWindow?

    public static func attach(over window: UIWindow) {
        let panel: UIWindow
        if let scene = window.windowScene {
            panel = UIWindow(windowScene: scene)
        } else {
            panel = UIWindow(frame: UIScreen.main.bounds)
        }
        panel.rootViewController = UIHostingController(rootView: SpikeControlPanel())
        panel.windowLevel = .alert
        panel.makeKeyAndVisible()
        overlay = panel
    }
}
#endif
