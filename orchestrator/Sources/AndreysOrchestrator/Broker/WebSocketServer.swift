// Localhost WebSocket server built on Network.framework's `NWListener` +
// `NWProtocolWebSocket` — no third-party dependency (PLAN.md §6.2, §8 W3).
//
// Binds to 127.0.0.1:<port>, accepts extension clients, and surfaces each as a
// `WSConnection` that emits decoded text messages and can send text back. The
// broker layers token auth, the window registry, and routing on top.

import Foundation
import Network

// MARK: - Upgrade-time token auth (PLAN.md §8 W8 item 1, §9.3)

/// Correlates a connection's upgrade-time token verdict (read from the HTTP
/// upgrade request by `TokenPeekFramer`) back to its `WSConnection`.
///
/// `NWProtocolWebSocket` does not expose the server-side HTTP upgrade request
/// (path/query/headers) to the application, and Swift's `NWProtocolFramer.Instance`
/// exposes no endpoint, so a framer that peeks the handshake cannot key its
/// finding to a specific `NWConnection`. We therefore hand the verdict across via
/// a per-listen-port FIFO: the framer reads the `Host:` header to find the right
/// arbiter and pushes a bool ("presented a valid token?"); each connection claims
/// the next verdict when it goes ready. Under the real threat model this is
/// sound: a cross-user process cannot read the 0600 token file (so its token is
/// absent/wrong → not trusted), and a same-user process could read the token file
/// anyway. FIFO ordering can only be perturbed by two connections racing their
/// handshakes on the same port within microseconds, which for the sequential,
/// loopback `ah` CLI does not occur.
final class AuthArbiter {
    private let expectedToken: String?
    private var verdicts: [Bool] = []
    private let lock = NSLock()

    init(expectedToken: String?) { self.expectedToken = expectedToken }

    /// Called by the framer with the token seen on the upgrade (nil if none).
    func recordUpgradeToken(_ token: String?) {
        lock.lock(); defer { lock.unlock() }
        verdicts.append(token != nil && token == expectedToken)
    }

    /// Claimed by a connection when it becomes ready; FIFO. Defaults to false
    /// (untrusted) if no verdict was recorded (e.g. a plain extension client).
    func claimVerdict() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return verdicts.isEmpty ? false : verdicts.removeFirst()
    }

    // Global registry keyed by listen port, so the framer (which only knows the
    // `Host:` header) can find the arbiter for its server.
    private static var registry: [UInt16: AuthArbiter] = [:]
    private static let registryLock = NSLock()

    static func register(port: UInt16, _ arbiter: AuthArbiter) {
        registryLock.lock(); defer { registryLock.unlock() }
        registry[port] = arbiter
    }
    static func unregister(port: UInt16) {
        registryLock.lock(); defer { registryLock.unlock() }
        registry[port] = nil
    }
    static func arbiter(forPort port: UInt16) -> AuthArbiter? {
        registryLock.lock(); defer { registryLock.unlock() }
        return registry[port]
    }
}

/// A pass-through `NWProtocolFramer` inserted BELOW `NWProtocolWebSocket`. It
/// peeks the HTTP upgrade request (the `ah` CLI sends its token as the
/// `x-ah-token` header AND as a `?token=` query param, PLAN.md §8 W8 item 1),
/// records the verdict on the matching `AuthArbiter`, and forwards every byte
/// unchanged so the WebSocket handshake and all subsequent frames are untouched.
final class TokenPeekFramer: NWProtocolFramerImplementation {
    static let definition = NWProtocolFramer.Definition(implementation: TokenPeekFramer.self)
    static var label: String { "AHTokenPeek" }

    private var peeked = false

    init(framer: NWProtocolFramer.Instance) {}
    func start(framer: NWProtocolFramer.Instance) -> NWProtocolFramer.StartResult { .ready }
    func wakeup(framer: NWProtocolFramer.Instance) {}
    func stop(framer: NWProtocolFramer.Instance) -> Bool { true }
    func cleanup(framer: NWProtocolFramer.Instance) {}

    func handleInput(framer: NWProtocolFramer.Instance) -> Int {
        while true {
            var available = 0
            _ = framer.parseInput(minimumIncompleteLength: 1, maximumLength: 65535) { buffer, _ in
                guard let buffer = buffer, !buffer.isEmpty else { return 0 }
                available = buffer.count
                if !self.peeked,
                    let request = String(bytes: buffer, encoding: .utf8),
                    request.hasPrefix("GET ") || request.contains("Host:")
                {
                    self.peeked = true
                    self.recordVerdict(from: request)
                }
                return 0  // never consume inside the parse closure
            }
            if available == 0 { return 0 }
            // Forward the bytes unchanged to the WebSocket protocol above.
            let msg = NWProtocolFramer.Message(definition: TokenPeekFramer.definition)
            if !framer.deliverInputNoCopy(length: available, message: msg, isComplete: true) {
                return 0
            }
        }
    }

    func handleOutput(
        framer: NWProtocolFramer.Instance, message: NWProtocolFramer.Message,
        messageLength: Int, isComplete: Bool
    ) {
        try? framer.writeOutputNoCopy(length: messageLength)
    }

    private func recordVerdict(from request: String) {
        var token: String?
        var hostPort: UInt16?
        for rawLine in request.split(separator: "\r\n", omittingEmptySubsequences: true) {
            let line = String(rawLine)
            let lower = line.lowercased()
            if lower.hasPrefix("get ") {
                if let r = line.range(of: "token=") {
                    token = String(line[r.upperBound...].prefix { $0 != " " && $0 != "&" })
                }
            } else if lower.hasPrefix("x-ah-token:") {
                let v = line.dropFirst("x-ah-token:".count).trimmingCharacters(in: .whitespaces)
                if !v.isEmpty { token = v }  // header wins over query
            } else if lower.hasPrefix("host:") {
                let v = line.dropFirst("host:".count).trimmingCharacters(in: .whitespaces)
                if let colon = v.lastIndex(of: ":") {
                    hostPort = UInt16(v[v.index(after: colon)...])
                }
            }
        }
        guard let port = hostPort, let arbiter = AuthArbiter.arbiter(forPort: port) else { return }
        arbiter.recordUpgradeToken(token)
    }
}

/// A single accepted WebSocket connection. Delivers inbound text frames via
/// `onText` and lets the broker push text frames back.
public final class WSConnection {
    public let id = UUID().uuidString
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let arbiter: AuthArbiter?

    /// Inbound decoded UTF-8 text frame.
    public var onText: ((String) -> Void)?
    /// Fired once when the connection is torn down (cancelled or failed).
    public var onClose: (() -> Void)?
    /// Internal close hook for the server's retention bookkeeping, kept separate
    /// from the public `onClose` the broker owns.
    var onCloseInternal: (() -> Void)?

    /// True if this connection presented a valid token at the WS upgrade — i.e.
    /// a trusted CLI/tool client (PLAN.md §8 W8). Untrusted connections (the
    /// extension) must still authenticate via a `hello` token before any effect.
    public private(set) var trustedCLI = false

    private var closed = false

    init(_ connection: NWConnection, queue: DispatchQueue, arbiter: AuthArbiter?) {
        self.connection = connection
        self.queue = queue
        self.arbiter = arbiter
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                // Claim this connection's upgrade-token verdict (see AuthArbiter).
                self.trustedCLI = self.arbiter?.claimVerdict() ?? false
                self.receiveNext()
            case .failed, .cancelled:
                self.fireClose()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receiveNext() {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if let data, !data.isEmpty,
                let context,
                let meta = context.protocolMetadata(
                    definition: NWProtocolWebSocket.definition)
                    as? NWProtocolWebSocket.Metadata
            {
                if meta.opcode == .text || meta.opcode == .binary {
                    if let text = String(data: data, encoding: .utf8) {
                        self.onText?(text)
                    }
                } else if meta.opcode == .close {
                    self.close()
                    return
                }
            }
            if error != nil {
                self.fireClose()
                return
            }
            self.receiveNext()
        }
    }

    /// Send a UTF-8 text frame.
    public func send(_ text: String) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(
            identifier: "text", metadata: [meta])
        connection.send(
            content: text.data(using: .utf8),
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { _ in })
    }

    public func close() {
        connection.cancel()
        fireClose()
    }

    private func fireClose() {
        guard !closed else { return }
        closed = true
        onClose?()
        onCloseInternal?()
    }
}

/// The `NWListener`-backed accept loop. Owns the listening socket and hands each
/// accepted connection to `onConnection`.
public final class WebSocketServer {
    private let port: UInt16
    private let queue = DispatchQueue(label: "orchestrator.broker.ws")
    private var listener: NWListener?
    /// Verdict arbiter for upgrade-time token auth (PLAN.md §8 W8).
    private let arbiter: AuthArbiter
    /// Retains accepted connections for their lifetime; released on close. Without
    /// this the wrapper would deallocate as soon as `newConnectionHandler`
    /// returns, tearing down the socket before the handshake completes.
    private var active: [String: WSConnection] = [:]

    /// Called on the server queue for every accepted, started connection.
    public var onConnection: ((WSConnection) -> Void)?

    /// `expectedToken` is the shared secret (§6.4). A connection presenting it at
    /// the WS upgrade (header `x-ah-token` or `?token=`) is marked a trusted CLI.
    public init(port: Int, expectedToken: String? = nil) {
        self.port = UInt16(port)
        self.arbiter = AuthArbiter(expectedToken: expectedToken)
    }

    public func start() throws {
        AuthArbiter.register(port: port, arbiter)

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        // WebSocket on top; the token-peek framer sits just below it so it can
        // read the raw HTTP upgrade request before WS consumes the handshake.
        let peekOptions = NWProtocolFramer.Options(definition: TokenPeekFramer.definition)
        params.defaultProtocolStack.applicationProtocols.insert(peekOptions, at: 0)
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        // Bind to the IPv4 loopback address explicitly, not the wildcard. Passing
        // only `on: port` leaves the listener on 0.0.0.0, which (a) exposes the
        // broker to the LAN and (b) makes the macOS Application Firewall prompt
        // "accept incoming network connections?" on every launch. A loopback-only
        // listener is never subject to that prompt. Every client connects to
        // 127.0.0.1 (src/broker/client.ts, cli/brokerClient.ts), so nothing is lost.
        params.requiredLocalEndpoint = .hostPort(
            host: .ipv4(.loopback),
            port: NWEndpoint.Port(rawValue: port)!
        )
        let listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] nwConn in
            guard let self else { return }
            let conn = WSConnection(nwConn, queue: self.queue, arbiter: self.arbiter)
            self.active[conn.id] = conn
            conn.onCloseInternal = { [weak self, weak conn] in
                guard let self, let conn else { return }
                self.queue.async { self.active[conn.id] = nil }
            }
            self.onConnection?(conn)
            conn.start()
        }
        listener.stateUpdateHandler = { state in
            if case .failed(let err) = state {
                NSLog("AndreysOrchestrator: WS listener failed: \(err)")
            }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    public func stop() {
        AuthArbiter.unregister(port: port)
        listener?.cancel()
        listener = nil
    }
}
