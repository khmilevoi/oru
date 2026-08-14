import AVFoundation
import Foundation
import PushToTalk
import os

/// The system PushToTalk channel (spec section 10.2). PushToTalk is not the
/// transport — the app still encodes and streams audio itself over Nearby. What
/// the framework provides is the right to run the microphone and the speaker
/// while the app is suspended and the screen is locked.
public final class BackgroundManager: NSObject, BackgroundSession {

    public weak var delegate: BackgroundSessionDelegate?

    private var manager: PTChannelManager?
    private let channelUUID = RadioConfig.Background.channelUUID
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "background"
    )

    public override init() {
        super.init()
    }

    private var channelName: String {
        NSLocalizedString(
            "ptt.channel.name",
            bundle: .module,
            comment: "Name of the push-to-talk channel in system UI"
        )
    }

    private var participantName: String {
        NSLocalizedString(
            "ptt.participant.nearby",
            bundle: .module,
            comment: "Name shown while a nearby device is speaking"
        )
    }

    private var descriptor: PTChannelDescriptor {
        PTChannelDescriptor(name: channelName, image: nil)
    }

    // MARK: - BackgroundSession

    public func activate() {
        Task { [weak self] in
            guard let self else { return }
            do {
                let manager = try await PTChannelManager.channelManager(
                    delegate: self,
                    restorationDelegate: self
                )
                self.manager = manager
                manager.requestJoinChannel(
                    channelUUID: self.channelUUID,
                    descriptor: self.descriptor
                )
            } catch {
                self.delegate?.backgroundSession(
                    self,
                    didFail: .backgroundFailed("channel manager: \(error)")
                )
            }
        }
    }

    public func deactivate() {
        manager?.leaveChannel(channelUUID: channelUUID)
    }

    public func requestBeginTransmitting() {
        guard let manager else {
            delegate?.backgroundSession(
                self,
                didFail: .backgroundFailed("no push-to-talk channel yet")
            )
            return
        }
        manager.requestBeginTransmitting(channelUUID: channelUUID)
    }

    public func stopTransmitting() {
        manager?.stopTransmitting(channelUUID: channelUUID)
    }

    public func setReceiving(_ receiving: Bool) {
        let participant = receiving
            ? PTParticipant(name: participantName, image: nil)
            : nil
        manager?.setActiveRemoteParticipant(
            participant,
            channelUUID: channelUUID,
            completionHandler: nil
        )
    }
}

// MARK: - PTChannelManagerDelegate

extension BackgroundManager: PTChannelManagerDelegate {

    public func channelManager(
        _ channelManager: PTChannelManager,
        didJoinChannel channelUUID: UUID,
        reason: PTChannelJoinReason
    ) {
        log.info("joined the push-to-talk channel")
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        didLeaveChannel channelUUID: UUID,
        reason: PTChannelLeaveReason
    ) {
        log.info("left the push-to-talk channel")
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        channelUUID: UUID,
        didBeginTransmittingFrom source: PTChannelTransmitRequestSource
    ) {
        // Covers both our own request and the system talk button on the lock screen.
        delegate?.backgroundSessionDidRequestTransmitStart(self)
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        channelUUID: UUID,
        didEndTransmittingFrom source: PTChannelTransmitRequestSource
    ) {
        delegate?.backgroundSessionDidRequestTransmitStop(self)
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        didActivate audioSession: AVAudioSession
    ) {
        log.info("system activated the audio session")
        delegate?.backgroundSessionDidActivateAudio(self)
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        didDeactivate audioSession: AVAudioSession
    ) {
        log.info("system deactivated the audio session")
        delegate?.backgroundSessionDidDeactivateAudio(self)
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        failedToJoinChannel channelUUID: UUID,
        error: Error
    ) {
        delegate?.backgroundSession(self, didFail: .backgroundFailed("join: \(error)"))
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        failedToBeginTransmittingInChannel channelUUID: UUID,
        error: Error
    ) {
        delegate?.backgroundSession(
            self,
            didFail: .backgroundFailed("begin transmitting: \(error)")
        )
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        receivedEphemeralPushToken pushToken: Data
    ) {
        // The MVP has no server, so no push token is ever registered anywhere.
    }

    public func incomingPushResult(
        channelManager: PTChannelManager,
        channelUUID: UUID,
        pushPayload: [String: Any]
    ) -> PTPushResult {
        // Unreachable without a server; leaving is the only harmless answer.
        .leaveChannel
    }
}

// MARK: - PTChannelRestorationDelegate

extension BackgroundManager: PTChannelRestorationDelegate {

    public func channelDescriptor(restoredChannelUUID channelUUID: UUID) -> PTChannelDescriptor {
        descriptor
    }
}
