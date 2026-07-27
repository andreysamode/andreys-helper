// Broker — WS server + window registry + snapshot aggregation + command router
// + cold-start launcher (Workstream W3, PLAN.md §5, §6, §9.3).
//
// Owns a single serial `stateQueue`; every registry mutation, routing decision
// and publish happens on it, so the broker needs no locks. WS connection
// callbacks hop onto that queue. Aggregated state is published out via
// `onStateChange` (consumed in-process by the UI, PLAN.md §6.2 "may be direct
// Swift, not WS"), and observed `working → done` transitions are published via
// `onTransition` (consumed by the daemon's completion watcher, W4).

import Foundation

public final class Broker {
    // MARK: Published outputs (called on stateQueue)

    /// Fired whenever the registry changes. Carries the merged UI tree plus the
    /// raw windows so the app can re-aggregate with the daemon's alert count.
    public var onStateChange: ((SessionTree, [RegisteredWindow]) -> Void)?
    /// Fired for every observed session `working → done` transition — the
    /// completion-watch source for the daemon (PLAN.md §6.5 completion trigger).
    public var onTransition: ((SessionId, SessionStatus, SessionStatus) -> Void)?

    /// Handles the `ah schedule <spec>` verb (PLAN.md §6.3). Wired by the app to
    /// the daemon; returns a JSON-shaped dictionary echoed to the CLI. Nil until
    /// wired (e.g. in fixtures/tests without a daemon).
    public var onSchedule: ((String) -> [String: Sendable])?
    /// Handles the `ah alert <text>` verb (PLAN.md §6.3): pushes a circle alert.
    public var onAlert: ((String) -> Void)?

    // MARK: State (stateQueue-confined)

    private let stateQueue = DispatchQueue(label: "orchestrator.broker.state")
    private let server: WebSocketServer
    private let token: String?
    private let cursorPath: String

    /// windowId → registered window.
    private var registry: [WindowId: RegisteredWindow] = [:]
    /// connection.id → windowId (once `hello` authenticated).
    private var connWindow: [String: WindowId] = [:]
    /// windowId → its live connection.
    private var connsByWindow: [WindowId: WSConnection] = [:]
    /// Monotonic counter stamped on a window the moment it reports gaining
    /// focus. Establishes "most recently focused" without trusting any client
    /// clock — no timestamp crosses the wire.
    private var focusTick: UInt64 = 0
    /// windowId → the `focusTick` at which it last gained focus. Entries are
    /// dropped with the window on disconnect.
    private var focusedAt: [WindowId: UInt64] = [:]
    /// The window most recently *published* as upfront. When no window claims
    /// focus at all the styling stays put rather than jumping.
    private var lastUpfrontWindowId: WindowId?
    /// windowId → callbacks waiting for that window to report OS focus, keyed by
    /// a token so a timed-out waiter can retire itself (see `whenFocused`).
    private var focusWaiters: [WindowId: [String: () -> Void]] = [:]
    /// sessionId → last seen status, for transition detection.
    private var lastStatus: [SessionId: SessionStatus] = [:]

    /// cmdId → pending command awaiting a `result`.
    private var pendingCommands: [String: (Result<ResultMessage, Error>) -> Void] = [:]
    /// Cold-start waiters keyed by normalized repo path.
    private var openWaiters: [String: [(Result<WindowId, Error>) -> Void]] = [:]

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        port: Int,
        token: String? = Bootstrap.loadToken(),
        cursorPath: String = "/usr/local/bin/cursor"
    ) {
        self.server = WebSocketServer(port: port, expectedToken: token)
        self.token = token
        self.cursorPath = cursorPath
    }

    // MARK: Lifecycle

    public func start() throws {
        server.onConnection = { [weak self] conn in
            self?.attach(conn)
        }
        try server.start()
    }

    public func stop() {
        server.stop()
    }

    private func attach(_ conn: WSConnection) {
        conn.onText = { [weak self, weak conn] text in
            guard let self, let conn else { return }
            self.stateQueue.async { self.handleText(text, from: conn) }
        }
        conn.onClose = { [weak self, weak conn] in
            guard let self, let conn else { return }
            self.stateQueue.async { self.handleClose(conn) }
        }
    }

    // MARK: Inbound message handling (stateQueue)

    /// Minimal envelope used to peek at `type` before decoding the full message.
    private struct Envelope: Codable { var type: MessageType }

    private func handleText(_ text: String, from conn: WSConnection) {
        guard let data = text.data(using: .utf8),
            let env = try? decoder.decode(Envelope.self, from: data)
        else { return }

        switch env.type {
        case .hello:
            guard let hello = try? decoder.decode(HelloMessage.self, from: data) else { return }
            handleHello(hello, from: conn)
        case .snapshot:
            guard let snap = try? decoder.decode(SnapshotMessage.self, from: data) else { return }
            handleSnapshot(snap, from: conn)
        case .result:
            guard let result = try? decoder.decode(ResultMessage.self, from: data) else { return }
            handleResult(result)
        case .command:
            // Inbound commands come from the `ah` CLI / trusted tool clients
            // (PLAN.md §6.3). The extension never sends these.
            handleBrokerCommand(data: data, from: conn)
        }
    }

    // MARK: Inbound CLI/tool commands (§6.3 broker query + routed verbs)

    /// The subset of an inbound command envelope the broker parses generically.
    /// `verb` is a free string because the CLI issues broker-level verbs
    /// (`windows`, `sessions`, …) that are NOT `CommandVerb` cases.
    private struct InboundEnvelope: Decodable { var cmdId: String; var verb: String }
    private struct ArgsWrapper<A: Decodable>: Decodable { var args: A? }
    private struct SessionsArgs: Decodable { var repo: String?; var status: String? }
    private struct OpenWindowArgs: Decodable { var repoPath: String? }
    private struct ScheduleArgs: Decodable { var spec: String? }
    private struct AlertArgs: Decodable { var text: String? }
    private struct RoutingHints: Decodable { var target: String?; var repo: String? }

    private func handleBrokerCommand(data: Data, from conn: WSConnection) {
        guard let env = try? decoder.decode(InboundEnvelope.self, from: data) else { return }
        // §9.3 — only connections that authenticated at the WS upgrade (trusted
        // CLI/tool clients) may drive broker commands. The extension path uses
        // `hello`; it never sends commands.
        guard conn.trustedCLI else {
            reply(to: conn, cmdId: env.cmdId, ok: false, error: "unauthorized (no valid token at upgrade)")
            return
        }

        switch env.verb {
        case "windows":
            reply(to: conn, cmdId: env.cmdId, ok: true, data: AnyCodable(windowsPayload()))
        case "sessions":
            let a = (try? decoder.decode(ArgsWrapper<SessionsArgs>.self, from: data))?.args
            reply(to: conn, cmdId: env.cmdId, ok: true,
                  data: AnyCodable(sessionsPayload(repo: a?.repo, status: a?.status)))
        case "openWindow":
            let a = (try? decoder.decode(ArgsWrapper<OpenWindowArgs>.self, from: data))?.args
            guard let path = a?.repoPath, !path.isEmpty else {
                reply(to: conn, cmdId: env.cmdId, ok: false, error: "openWindow requires repoPath"); return
            }
            openWindow(path: path) { result in
                switch result {
                case .success(let windowId):
                    self.reply(to: conn, cmdId: env.cmdId, ok: true,
                               data: AnyCodable(["windowId": windowId, "repoPath": path] as [String: Sendable]))
                case .failure(let error):
                    self.reply(to: conn, cmdId: env.cmdId, ok: false, error: "\(error)")
                }
            }
        case "schedule":
            let a = (try? decoder.decode(ArgsWrapper<ScheduleArgs>.self, from: data))?.args
            guard let spec = a?.spec, let onSchedule else {
                reply(to: conn, cmdId: env.cmdId, ok: false, error: "schedule unavailable"); return
            }
            reply(to: conn, cmdId: env.cmdId, ok: true, data: AnyCodable(onSchedule(spec)))
        case "alert":
            let a = (try? decoder.decode(ArgsWrapper<AlertArgs>.self, from: data))?.args
            guard let text = a?.text, let onAlert else {
                reply(to: conn, cmdId: env.cmdId, ok: false, error: "alert unavailable"); return
            }
            onAlert(text)
            reply(to: conn, cmdId: env.cmdId, ok: true, data: AnyCodable(["text": text] as [String: Sendable]))
        default:
            // Routed verbs (reveal/interrupt/sendPrompt/spawnSession/createWorktree/
            // rename/listWorktrees) forward to the owning window (PLAN.md §6.2).
            guard let verb = CommandVerb(rawValue: env.verb) else {
                reply(to: conn, cmdId: env.cmdId, ok: false, error: "unknown verb '\(env.verb)'"); return
            }
            routeAndRelay(verb: verb, data: data, cliCmdId: env.cmdId, to: conn)
        }
    }

    /// Resolve the target window for a routed verb and relay its `result` back to
    /// the CLI under the CLI's original `cmdId`.
    private func routeAndRelay(verb: CommandVerb, data: Data, cliCmdId: String, to conn: WSConnection) {
        let args = (try? decoder.decode(ArgsWrapper<CommandArgs>.self, from: data))?.args ?? CommandArgs()
        let hints = (try? decoder.decode(ArgsWrapper<RoutingHints>.self, from: data))?.args

        let targetWindow: WindowId?
        if let sid = args.sessionId {
            targetWindow = registry.values.first { $0.sessions.contains { $0.sessionId == sid } }?.windowId
        } else if let key = hints?.target ?? hints?.repo {
            targetWindow = registry[key]?.windowId ?? windowId(forRepo: key)
        } else if let wt = args.worktreePath {
            targetWindow = registry.values.first {
                $0.worktrees.contains { normalize($0.path) == normalize(wt) }
                    || normalize($0.repo.trunkPath) == normalize(wt)
            }?.windowId
        } else if let root = args.repoRoot {
            targetWindow = windowId(forRepo: root)
        } else {
            targetWindow = nil
        }

        guard let windowId = targetWindow else {
            reply(to: conn, cmdId: cliCmdId, ok: false, error: "no window for verb '\(verb.rawValue)'")
            return
        }
        sendCommand(to: windowId, verb: verb, args: args) { result in
            switch result {
            case .success(let r):
                self.reply(to: conn, cmdId: cliCmdId, ok: r.ok, data: r.data, error: r.error)
            case .failure(let error):
                self.reply(to: conn, cmdId: cliCmdId, ok: false, error: "\(error)")
            }
        }
    }

    /// Send a `result` envelope back to a CLI connection (matched by `cmdId`).
    private func reply(
        to conn: WSConnection, cmdId: String, ok: Bool,
        data: AnyCodable? = nil, error: String? = nil
    ) {
        let msg = ResultMessage(cmdId: cmdId, ok: ok, data: data, error: error)
        guard let encoded = try? encoder.encode(msg),
            let text = String(data: encoded, encoding: .utf8)
        else { return }
        conn.send(text)
    }

    /// `windows` payload: one entry per connected window (PLAN.md §6.3), shaped
    /// for the CLI's `windows`/`resolve-branch` consumers.
    private func windowsPayload() -> [[String: Sendable]] {
        let upfront = upfrontWindowId
        return registry.values
            .sorted { ($0.repo.name, $0.windowId) < ($1.repo.name, $1.windowId) }
            .map { w in
                [
                    "windowId": w.windowId,
                    "host": w.host.rawValue,
                    // Focus state, so `ah windows` can explain the pane styling.
                    "focused": w.focused,
                    "upfront": w.windowId == upfront,
                    "repo": ["name": w.repo.name, "trunkPath": w.repo.trunkPath] as [String: Sendable],
                    "worktrees": w.worktrees.map { wt in
                        [
                            "path": wt.path, "name": wt.name, "branch": wt.branch,
                            "ahead": wt.ahead, "behind": wt.behind, "isTrunk": wt.isTrunk,
                        ] as [String: Sendable]
                    } as [Sendable],
                    "sessions": w.sessions.map { sessionDict($0, repo: w.repo.name, windowId: w.windowId) } as [Sendable],
                ] as [String: Sendable]
            }
    }

    /// `sessions` payload: live sessions across all windows, filtered broker-side
    /// by `--repo` / `--status` (PLAN.md §6.3).
    private func sessionsPayload(repo: String?, status: String?) -> [[String: Sendable]] {
        var out: [[String: Sendable]] = []
        for w in registry.values.sorted(by: {
            ($0.repo.name, $0.windowId) < ($1.repo.name, $1.windowId)
        }) {
            if let repo, repo != w.repo.name, normalize(repo) != normalize(w.repo.trunkPath) { continue }
            for s in w.sessions {
                if let status, status != s.status.rawValue { continue }
                out.append(sessionDict(s, repo: w.repo.name, windowId: w.windowId))
            }
        }
        return out
    }

    private func sessionDict(_ s: SessionInfo, repo: String, windowId: WindowId) -> [String: Sendable] {
        var dict: [String: Sendable] = [
            "tabId": s.tabId,
            "title": s.title,
            "cwd": s.cwd,
            "status": s.status.rawValue,
            "seen": s.seen,
            "repo": repo,
            "windowId": windowId,
        ]
        // `sessionId` may be absent on a freshly-spawned tab (PLAN.md §6.1); the
        // CLI treats it as optional, so omit rather than emit null.
        if let sid = s.sessionId { dict["sessionId"] = sid }
        return dict
    }

    private func handleHello(_ hello: HelloMessage, from conn: WSConnection) {
        // Token auth — reject a wrong/absent token by closing the socket
        // (PLAN.md §9.3).
        guard let token, hello.token == token else {
            NSLog("AndreysOrchestrator: broker rejected hello (bad token)")
            conn.close()
            return
        }
        connWindow[conn.id] = hello.windowId
        connsByWindow[hello.windowId] = conn
        // New/re-announced window; preserve any prior snapshot payload on reconnect.
        var existing = registry[hello.windowId]
            ?? RegisteredWindow(windowId: hello.windowId, host: hello.host, repo: hello.repo)
        existing.host = hello.host
        existing.repo = hello.repo
        // The previous connection died at an unknown point, so any `focused` it
        // left behind is unverifiable. Clear it and let the snapshot that
        // follows this hello re-assert — a window that really is focused then
        // takes a fresh, newest focus tick.
        existing.focused = false
        registry[hello.windowId] = existing

        // Resolve any cold-start waiter for this repo path.
        let key = normalize(hello.repo.trunkPath)
        if let waiters = openWaiters[key] {
            openWaiters[key] = nil
            for w in waiters { w(.success(hello.windowId)) }
        }
        publish()
    }

    private func handleSnapshot(_ snap: SnapshotMessage, from conn: WSConnection) {
        guard let windowId = connWindow[conn.id] ?? (registry[snap.windowId] != nil ? snap.windowId : nil)
        else { return }
        guard var window = registry[windowId] else { return }

        // Detect working → done transitions before overwriting state.
        for session in snap.sessions {
            guard let sid = session.sessionId else { continue }
            let prev = lastStatus[sid]
            if prev == .working && session.status == .done {
                onTransition?(sid, .working, .done)
            }
            lastStatus[sid] = session.status
        }

        window.worktrees = snap.worktrees
        window.sessions = snap.sessions
        // `focused` is absent on an extension older than the field; treat as
        // "not focused" rather than letting it disturb the current answer.
        let focused = snap.focused == true
        if focused && !window.focused {
            focusTick += 1
            focusedAt[windowId] = focusTick
        }
        window.focused = focused
        registry[windowId] = window
        if focused { drainFocusWaiters(windowId) }
        publish()
    }

    private func handleResult(_ result: ResultMessage) {
        guard let completion = pendingCommands.removeValue(forKey: result.cmdId) else { return }
        completion(.success(result))
    }

    private func handleClose(_ conn: WSConnection) {
        guard let windowId = connWindow.removeValue(forKey: conn.id) else { return }
        if connsByWindow[windowId]?.id == conn.id {
            // The window can never report focus again — release its waiters now
            // rather than stranding them until their timeout.
            drainFocusWaiters(windowId)
            connsByWindow[windowId] = nil
            // Drop the window from the dashboard; a reconnect re-announces it.
            registry[windowId] = nil
            // …and with it any claim it had on being upfront, so a dead window
            // can never keep the styling.
            focusedAt[windowId] = nil
            publish()
        }
    }

    /// The frontmost editor window, derived fresh on every publish.
    ///
    /// A window that *currently* claims focus wins. If several do — Electron can
    /// briefly have two windows reporting focus across a switch — the one that
    /// acquired it most recently wins. When none claims focus, i.e. the user
    /// switched to another app entirely, whichever window was last shown as
    /// upfront keeps the styling so it doesn't jump while they're away.
    ///
    /// This is deliberately derived rather than latched on the first
    /// `focused == true`. A latch can only ever be revoked by some *other*
    /// window announcing focus, so a window that failed to publish its own
    /// focus gain left a different repo's window styled as upfront
    /// indefinitely, with no path back.
    private var upfrontWindowId: WindowId? {
        // Ties broken by windowId so the answer never depends on Dictionary
        // iteration order.
        let ranked = registry.values.sorted {
            (focusedAt[$0.windowId] ?? 0, $0.windowId)
                > (focusedAt[$1.windowId] ?? 0, $1.windowId)
        }
        if let claiming = ranked.first(where: { $0.focused }) {
            return claiming.windowId
        }
        if let last = lastUpfrontWindowId, registry[last] != nil {
            return last
        }
        return ranked.first { focusedAt[$0.windowId] != nil }?.windowId
    }

    private func publish() {
        let upfront = upfrontWindowId
        lastUpfrontWindowId = upfront
        // Stable order: `registry.values` is unordered and `sorted(by:)` is not
        // a stable sort, so two windows on the same repo would otherwise swap
        // places between publishes and visibly reshuffle the pane.
        let windows = registry.values.sorted {
            ($0.repo.name, $0.windowId) < ($1.repo.name, $1.windowId)
        }
        onStateChange?(Aggregator.buildTree(windows: windows, upfront: upfront), windows)
    }

    // MARK: Command routing (§6.2)

    public enum BrokerError: Error, CustomStringConvertible {
        case noWindowForRepo(String)
        case unknownWindow(WindowId)
        case timeout
        case coldStartFailed(String)

        public var description: String {
            switch self {
            case .noWindowForRepo(let r): return "no connected window for repo \(r)"
            case .unknownWindow(let w): return "unknown window \(w)"
            case .timeout: return "timed out awaiting result"
            case .coldStartFailed(let m): return "cold-start failed: \(m)"
            }
        }
    }

    /// Route a command to a specific window and await its `result` (PLAN.md §6.2).
    public func sendCommand(
        to windowId: WindowId,
        verb: CommandVerb,
        args: CommandArgs,
        timeout: TimeInterval = 15,
        completion: @escaping (Result<ResultMessage, Error>) -> Void
    ) {
        stateQueue.async {
            guard let conn = self.connsByWindow[windowId] else {
                completion(.failure(BrokerError.unknownWindow(windowId)))
                return
            }
            self.dispatch(verb: verb, args: args, over: conn, timeout: timeout, completion: completion)
        }
    }

    /// Route a command by repo name, cold-starting a window if none is connected
    /// (PLAN.md §6.2 routing, §2 cold repo).
    public func sendCommand(
        toRepo repo: String,
        verb: CommandVerb,
        args: CommandArgs,
        coldStartPath: String? = nil,
        timeout: TimeInterval = 15,
        completion: @escaping (Result<ResultMessage, Error>) -> Void
    ) {
        stateQueue.async {
            if let windowId = self.windowId(forRepo: repo) {
                self.sendCommand(to: windowId, verb: verb, args: args, timeout: timeout, completion: completion)
                return
            }
            // Cold-start: no connected window for this repo.
            guard let path = coldStartPath else {
                completion(.failure(BrokerError.noWindowForRepo(repo)))
                return
            }
            self.openWindow(path: path, timeout: timeout) { result in
                switch result {
                case .success(let windowId):
                    self.sendCommand(to: windowId, verb: verb, args: args, timeout: timeout, completion: completion)
                case .failure(let error):
                    completion(.failure(error))
                }
            }
        }
    }

    private func dispatch(
        verb: CommandVerb, args: CommandArgs, over conn: WSConnection,
        timeout: TimeInterval, completion: @escaping (Result<ResultMessage, Error>) -> Void
    ) {
        let cmdId = UUID().uuidString
        let message = CommandMessage(cmdId: cmdId, verb: verb, args: args)
        guard let data = try? encoder.encode(message),
            let text = String(data: data, encoding: .utf8)
        else {
            completion(.failure(BrokerError.timeout))
            return
        }
        pendingCommands[cmdId] = completion
        conn.send(text)
        stateQueue.asyncAfter(deadline: .now() + timeout) {
            if let pending = self.pendingCommands.removeValue(forKey: cmdId) {
                pending(.failure(BrokerError.timeout))
            }
        }
    }

    private func windowId(forRepo repo: String) -> WindowId? {
        registry.values.first { $0.repo.name == repo || normalize($0.repo.trunkPath) == normalize(repo) }?.windowId
    }

    // MARK: Cold-start (§2 cold repo)

    /// Launch `cursor <path>` and resolve once that window's extension sends its
    /// `hello` (PLAN.md §2, §9.1). Surfaces a timeout error if it never connects.
    public func openWindow(
        path: String,
        timeout: TimeInterval = 30,
        completion: @escaping (Result<WindowId, Error>) -> Void
    ) {
        stateQueue.async {
            // Already connected for this path?
            if let existing = self.registry.values.first(where: { self.normalize($0.repo.trunkPath) == self.normalize(path) }) {
                completion(.success(existing.windowId))
                return
            }
            let key = self.normalize(path)
            self.openWaiters[key, default: []].append(completion)
            self.launchCursor(path: path) { launchError in
                if let launchError {
                    self.stateQueue.async {
                        if let waiters = self.openWaiters[key] {
                            self.openWaiters[key] = nil
                            for w in waiters { w(.failure(launchError)) }
                        }
                    }
                }
            }
            self.stateQueue.asyncAfter(deadline: .now() + timeout) {
                if let waiters = self.openWaiters[key] {
                    self.openWaiters[key] = nil
                    for w in waiters { w(.failure(BrokerError.timeout)) }
                }
            }
        }
    }

    /// Bring the already-open window for `path` to the front (PLAN.md §9.1
    /// click-to-focus). Re-invoking the CLI on a folder that's already open
    /// raises and focuses its window; if it isn't open this opens it — harmless
    /// either way. Best-effort and fire-and-forget (no reply, never throws).
    public func foreground(path: String) {
        stateQueue.async { self.launchCursor(path: path) { _ in } }
    }

    /// Run `completion` once `windowId` reports being the focused OS window —
    /// immediately if it already is, otherwise on the next snapshot that says so,
    /// and after `timeout` regardless (best-effort rather than never).
    ///
    /// This is the sequencing half of click-to-focus: `foreground(path:)` takes
    /// ~1.3s to actually bring the editor forward, and anything sent before that
    /// lands in a background window. A webview revealed there gets no keyboard
    /// focus — VS Code's webview host only hands focus to the panel content if
    /// `document.hasFocus()` at load time — which is exactly the "the tab comes
    /// up but typing goes nowhere" failure. Waiting for the window's own
    /// `focused` report makes the reveal land in a foreground window, the same
    /// condition an in-editor click already satisfies.
    public func whenFocused(
        _ windowId: WindowId, timeout: TimeInterval = 3, _ completion: @escaping () -> Void
    ) {
        stateQueue.async {
            if self.registry[windowId]?.focused == true {
                completion()
                return
            }
            let key = UUID().uuidString
            self.focusWaiters[windowId, default: [:]][key] = completion
            self.stateQueue.asyncAfter(deadline: .now() + timeout) {
                guard let waiter = self.focusWaiters[windowId]?.removeValue(forKey: key)
                else { return }  // already fired by a focus report
                if self.focusWaiters[windowId]?.isEmpty == true {
                    self.focusWaiters[windowId] = nil
                }
                waiter()
            }
        }
    }

    /// Fire and clear every waiter for `windowId` (stateQueue).
    private func drainFocusWaiters(_ windowId: WindowId) {
        guard let waiters = focusWaiters.removeValue(forKey: windowId) else { return }
        for waiter in waiters.values { waiter() }
    }

    /// Shell out to the cursor CLI. Overridable indirection point kept simple:
    /// runs the configured `cursorPath`. Errors are surfaced via the callback.
    private func launchCursor(path: String, completion: @escaping (Error?) -> Void) {
        guard FileManager.default.isExecutableFile(atPath: cursorPath) else {
            completion(BrokerError.coldStartFailed("cursor CLI not found at \(cursorPath)"))
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cursorPath)
        process.arguments = [path]
        do {
            try process.run()
            completion(nil)
        } catch {
            completion(BrokerError.coldStartFailed(error.localizedDescription))
        }
    }

    private func normalize(_ path: String) -> String {
        (path as NSString).standardizingPath
    }

    // MARK: Test/inspection hooks

    /// Snapshot of the current registry (for the self-test). Runs on stateQueue.
    public func snapshotRegistry(_ completion: @escaping ([RegisteredWindow]) -> Void) {
        stateQueue.async { completion(Array(self.registry.values)) }
    }
}
