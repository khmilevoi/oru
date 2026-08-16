import Foundation
import NearbyConnections
import os

/// One outgoing transmission. Nearby wants an `InputStream`, so a bound pair is
/// created and Opus frames are written into the output end as they are encoded.
///
/// Writes never block the audio path: if the pipe has no space the frame is
/// dropped. Dropping a 20 ms frame of live speech is correct; stalling the
/// capture callback is not.
final class OutgoingAudioStream: AudioStreamSink {

    /// `hasSpaceAvailable` promises some space, not a whole frame's worth, so a
    /// write can be short. Whatever a call could not take is held here and sent
    /// with the next one: a half-written frame would desynchronise the reader's
    /// length prefix and end the entire transmission, not merely lose 20 ms.
    private static let maxPendingBytes =
        RadioConfig.Audio.maxEncodedFrameBytes * RadioConfig.Audio.jitterMaxFrames

    private let output: OutputStream
    private let queue: DispatchQueue
    private let log: Logger
    private var pending = Data()
    private var isClosed = false
    private var droppedFrames = 0

    init(output: OutputStream, queue: DispatchQueue, log: Logger) {
        self.output = output
        self.queue = queue
        self.log = log
        output.open()
    }

    func write(frame: Data) {
        queue.async { [self] in
            guard !isClosed else { return }
            let framed = AudioFraming.frame(frame)
            // The backlog is the backpressure signal: past the cap the pipe is
            // not draining, and a whole frame is dropped. Never a partial one.
            guard pending.count + framed.count <= Self.maxPendingBytes else {
                droppedFrames += 1
                return
            }
            pending.append(framed)
            flushLocked()
        }
    }

    private func flushLocked() {
        while !pending.isEmpty, output.hasSpaceAvailable {
            let written = pending.withUnsafeBytes { raw -> Int in
                guard let base = raw.bindMemory(to: UInt8.self).baseAddress else {
                    return 0
                }
                return output.write(base, maxLength: raw.count)
            }
            guard written > 0 else { return }
            pending.removeFirst(written)
        }
    }

    func close() {
        queue.async { [self] in
            guard !isClosed else { return }
            flushLocked()
            isClosed = true
            output.close()
            if droppedFrames > 0 {
                log.info("dropped \(self.droppedFrames, privacy: .public) audio frames")
            }
        }
    }
}

/// One incoming transmission. Read on its own thread with blocking reads — no
/// run loop is available on the queues the engine uses.
final class IncomingAudioStream {
    let id = UUID()
    let peerId: String
    private let stream: InputStream
    private let parser = AudioFrameParser()
    private let onFrame: (Data, String) -> Void
    private let onEnd: (String, UUID) -> Void
    private var thread: Thread?
    private var isCancelled = false

    init(
        peerId: String,
        stream: InputStream,
        onFrame: @escaping (Data, String) -> Void,
        onEnd: @escaping (String, UUID) -> Void
    ) {
        self.peerId = peerId
        self.stream = stream
        self.onFrame = onFrame
        self.onEnd = onEnd
    }

    func start() {
        let thread = Thread { [weak self] in self?.readLoop() }
        thread.name = "radio.incoming.\(peerId)"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
    }

    func cancel() {
        isCancelled = true
    }

    private func readLoop() {
        stream.open()
        var buffer = [UInt8](repeating: 0, count: 4_096)

        while !isCancelled {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            for frame in parser.append(Data(buffer[0..<read])) {
                onFrame(frame, peerId)
            }
            if parser.isDesynchronised { break }
        }

        stream.close()
        onEnd(peerId, id)
    }
}

/// Everything known about one endpoint. A peer only counts once its `hello`
/// has been seen and accepted (cross-platform wire contract).
private struct Peer {
    var isConnected = false
    var didHandshake = false
    var retryDelay: TimeInterval = RadioConfig.Reconnect.initialDelay
    var isVisible = false
}

public final class NearbyManager: RadioTransport {

    public weak var delegate: RadioTransportDelegate?

    private let queue: DispatchQueue
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "nearby"
    )

    private var connectionManager: ConnectionManager?
    private var advertiser: Advertiser?
    private var discoverer: Discoverer?

    private var peers: [EndpointID: Peer] = [:]
    private var incoming: [EndpointID: IncomingAudioStream] = [:]
    private var outgoing: OutgoingAudioStream?
    private var outgoingTokens: [CancellationToken] = []

    public init(queue: DispatchQueue) {
        self.queue = queue
    }

    public var connectedPeerCount: Int {
        queue.sync { handshakenPeerIds().count }
    }

    // MARK: - RadioTransport

    public func start() throws {
        let manager = ConnectionManager(
            serviceID: RadioConfig.serviceId,
            strategy: .cluster
        )
        manager.delegate = self

        let advertiser = Advertiser(connectionManager: manager)
        advertiser.delegate = self
        let discoverer = Discoverer(connectionManager: manager)
        discoverer.delegate = self

        // Read on the transport queue by every delegate callback, so written
        // there too — `start()` runs on the engine queue.
        queue.sync {
            self.connectionManager = manager
            self.advertiser = advertiser
            self.discoverer = discoverer
        }

        let endpointInfo = Data(ProcessInfo.processInfo.hostName.utf8)
        advertiser.startAdvertising(using: endpointInfo) { [weak self] error in
            guard let self, let error else { return }
            self.report(.transportFailed("advertising: \(error)"))
        }
        discoverer.startDiscovery { [weak self] error in
            guard let self, let error else { return }
            self.report(.transportFailed("discovery: \(error)"))
        }
        log.info("nearby started on \(RadioConfig.serviceId, privacy: .public)")
    }

    public func stop() {
        var stoppingAdvertiser: Advertiser?
        var stoppingDiscoverer: Discoverer?
        queue.sync {
            endAudioStreamLocked()
            for (endpointID, _) in peers {
                connectionManager?.disconnect(from: endpointID)
                incoming[endpointID]?.cancel()
            }
            peers.removeAll()
            incoming.removeAll()
            stoppingAdvertiser = advertiser
            stoppingDiscoverer = discoverer
            advertiser = nil
            discoverer = nil
            connectionManager = nil
        }
        stoppingAdvertiser?.stopAdvertising { _ in }
        stoppingDiscoverer?.stopDiscovery { _ in }
        log.info("nearby stopped")
    }

    public func broadcastControl(_ message: ControlMessage) {
        queue.async { [self] in
            let targets = handshakenPeerIds()
            guard !targets.isEmpty, let manager = connectionManager else { return }
            _ = manager.send(message.encoded(), to: targets) { _ in }
        }
    }

    public func beginAudioStream(streamId: String) -> AudioStreamSink? {
        queue.sync { [self] () -> AudioStreamSink? in
            endAudioStreamLocked()
            let targets = handshakenPeerIds()
            guard !targets.isEmpty, let manager = connectionManager else { return nil }

            // One STREAM per transmission, fanned out to every peer (spec section 7).
            var input: InputStream?
            var output: OutputStream?
            Stream.getBoundStreams(
                withBufferSize: 64 * 1_024,
                inputStream: &input,
                outputStream: &output
            )
            guard let input, let output else {
                // Recoverable, so state and not an error (spec section 13):
                // reporting it would put the radio in `.error` for good and
                // refuse every later press. `nil` already tells the engine.
                log.error("could not open an audio stream")
                return nil
            }

            outgoingTokens = [manager.startStream(input, to: targets) { _ in }]
            let sink = OutgoingAudioStream(output: output, queue: queue, log: log)
            outgoing = sink
            log.info("outgoing stream \(streamId, privacy: .public) to \(targets.count)")
            return sink
        }
    }

    public func endAudioStream() {
        queue.async { [self] in endAudioStreamLocked() }
    }

    // MARK: - Internals

    private func endAudioStreamLocked() {
        outgoing?.close()
        outgoing = nil
        for token in outgoingTokens {
            token.cancel()
        }
        outgoingTokens.removeAll()
    }

    private func handshakenPeerIds() -> [EndpointID] {
        peers.filter { $0.value.isConnected && $0.value.didHandshake }.map(\.key)
    }

    private func publishPeerCountLocked() {
        let count = handshakenPeerIds().count
        delegate?.transport(self, peerCountDidChange: count)
    }

    private func report(_ error: RadioError) {
        log.error("\(error.message, privacy: .public)")
        delegate?.transport(self, didFail: error)
    }

    /// Discovery never stops, so a lost peer comes back on its own; this only
    /// paces the connection requests after a failure.
    private func scheduleRetryLocked(_ endpointID: EndpointID) {
        var peer = peers[endpointID] ?? Peer()
        let delay = peer.retryDelay
        peer.retryDelay = min(
            peer.retryDelay * RadioConfig.Reconnect.multiplier,
            RadioConfig.Reconnect.maxDelay
        )
        peers[endpointID] = peer

        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let peer = self.peers[endpointID] else { return }
            guard peer.isVisible, !peer.isConnected else { return }
            self.requestConnectionLocked(endpointID)
        }
    }

    private func requestConnectionLocked(_ endpointID: EndpointID) {
        let endpointInfo = Data(ProcessInfo.processInfo.hostName.utf8)
        discoverer?.requestConnection(
            to: endpointID,
            using: endpointInfo
        ) { [weak self] error in
            guard let self, error != nil else { return }
            self.queue.async { self.scheduleRetryLocked(endpointID) }
        }
    }
}

// MARK: - AdvertiserDelegate

extension NearbyManager: AdvertiserDelegate {

    public func advertiser(
        _ advertiser: Advertiser,
        didReceiveConnectionRequestFrom endpointID: EndpointID,
        with context: Data,
        connectionRequestHandler: @escaping (Bool) -> Void
    ) {
        // Spec section 7: connections are accepted automatically, no peer picker.
        connectionRequestHandler(true)
    }
}

// MARK: - DiscovererDelegate

extension NearbyManager: DiscovererDelegate {

    public func discoverer(
        _ discoverer: Discoverer,
        didFind endpointID: EndpointID,
        with context: Data
    ) {
        queue.async { [self] in
            var peer = peers[endpointID] ?? Peer()
            peer.isVisible = true
            peers[endpointID] = peer
            guard !peer.isConnected else { return }
            requestConnectionLocked(endpointID)
        }
    }

    public func discoverer(_ discoverer: Discoverer, didLose endpointID: EndpointID) {
        queue.async { [self] in
            guard var peer = peers[endpointID] else { return }
            peer.isVisible = false
            peers[endpointID] = peer
        }
    }
}

// MARK: - ConnectionManagerDelegate

extension NearbyManager: ConnectionManagerDelegate {

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didReceive verificationCode: String,
        from endpointID: EndpointID,
        verificationHandler: @escaping (Bool) -> Void
    ) {
        // No out-of-band verification: the air is open by design (spec section 7).
        verificationHandler(true)
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didChangeTo state: ConnectionState,
        for endpointID: EndpointID
    ) {
        queue.async { [self] in
            var peer = peers[endpointID] ?? Peer()
            switch state {
            case .connected:
                peer.isConnected = true
                peer.didHandshake = false
                peer.retryDelay = RadioConfig.Reconnect.initialDelay
                peers[endpointID] = peer
                _ = connectionManager.send(
                    ControlMessage.hello(version: RadioConfig.protocolVersion).encoded(),
                    to: [endpointID]
                ) { _ in }
                log.info("connected \(endpointID, privacy: .public)")
            case .disconnected, .rejected:
                peer.isConnected = false
                peer.didHandshake = false
                peers[endpointID] = peer
                incoming[endpointID]?.cancel()
                incoming.removeValue(forKey: endpointID)
                delegate?.transport(self, didStopIncomingAudio: endpointID)
                publishPeerCountLocked()
                scheduleRetryLocked(endpointID)
                log.info("disconnected \(endpointID, privacy: .public)")
            default:
                peers[endpointID] = peer
            }
        }
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didReceive data: Data,
        withID payloadID: PayloadID,
        from endpointID: EndpointID
    ) {
        queue.async { [self] in
            guard let message = ControlMessage.decode(data) else { return }
            switch message {
            case let .hello(version):
                guard version == RadioConfig.protocolVersion else {
                    log.error("hello version \(version) rejected")
                    connectionManager.disconnect(from: endpointID)
                    peers.removeValue(forKey: endpointID)
                    publishPeerCountLocked()
                    return
                }
                var peer = peers[endpointID] ?? Peer()
                peer.didHandshake = true
                peers[endpointID] = peer
                publishPeerCountLocked()
            case let .txStart(streamId):
                log.info("peer tx-start \(streamId, privacy: .public)")
            case .txStop:
                incoming[endpointID]?.cancel()
            }
        }
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didReceive stream: InputStream,
        withID payloadID: PayloadID,
        from endpointID: EndpointID,
        cancellationToken token: CancellationToken
    ) {
        queue.async { [self] in
            guard peers[endpointID]?.didHandshake == true else {
                token.cancel()
                return
            }
            incoming[endpointID]?.cancel()

            let reader = IncomingAudioStream(
                peerId: endpointID,
                stream: stream,
                onFrame: { [weak self] frame, peerId in
                    guard let self else { return }
                    self.queue.async {
                        self.delegate?.transport(
                            self,
                            didReceiveAudioFrame: frame,
                            from: peerId
                        )
                    }
                },
                onEnd: { [weak self] peerId, id in
                    guard let self else { return }
                    self.queue.async {
                        // A superseded reader (replaced by a later stream for the
                        // same peer before it finished) must end silently: only
                        // the reader still registered for this peer may remove
                        // itself and report the peer as stopped.
                        guard self.incoming[peerId]?.id == id else { return }
                        self.incoming.removeValue(forKey: peerId)
                        self.delegate?.transport(self, didStopIncomingAudio: peerId)
                    }
                }
            )
            incoming[endpointID] = reader
            delegate?.transport(self, didStartIncomingAudio: endpointID)
            reader.start()
        }
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didStartReceivingResourceWithID payloadID: PayloadID,
        from endpointID: EndpointID,
        at localURL: URL,
        withName name: String,
        cancellationToken token: CancellationToken
    ) {
        // The radio never sends FILE payloads.
        token.cancel()
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didReceiveTransferUpdate update: TransferUpdate,
        from endpointID: EndpointID,
        forPayload payloadID: PayloadID
    ) {
        // Realtime audio needs no transfer progress.
    }
}
