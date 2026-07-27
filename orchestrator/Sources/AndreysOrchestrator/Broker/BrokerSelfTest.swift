// Broker self-test (PLAN.md §8 W3 "mock + assertions"). Runs a real broker with
// fake extension clients (NWConnection WS clients) and asserts: N clients
// register, aggregation matches §4 precedence, a command routes to the correct
// client and its result surfaces, and cold-start resolves when a window connects.
//
// Invoked via the binary's `--selftest` path (no XCTest needed — the toolchain
// here has command-line tools only). Prints PASS/FAIL per check.

import Foundation
import Network

// MARK: - Mock extension client

/// A minimal NWConnection WebSocket client that impersonates a window's
/// extension: sends `hello` + `snapshot`, and auto-replies to `command`s.
final class MockExtensionClient {
    private let conn: NWConnection
    private let queue = DispatchQueue(label: "orchestrator.test.client")
    private let token: String
    let windowId: String
    private let repo: RepoRef

    /// Auto-reply payload for any received command.
    var onCommand: ((CommandMessage) -> ResultMessage)?

    init(port: UInt16, windowId: String, repo: RepoRef, token: String) {
        self.windowId = windowId
        self.repo = repo
        self.token = token
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        // A URL endpoint (not host/port) is required so NWProtocolWebSocket sends
        // the HTTP upgrade with a Host/path — otherwise the handshake stalls.
        self.conn = NWConnection(
            to: .url(URL(string: "ws://127.0.0.1:\(port)/")!),
            using: params)
    }

    func connect(sendHello: Bool = true) {
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .ready = state {
                if sendHello { self.sendHello() }
                self.receive()
            }
        }
        conn.start(queue: queue)
    }

    func sendHello() {
        let hello = HelloMessage(windowId: windowId, host: .cursor, repo: repo, token: token)
        send(hello)
    }

    func sendHello(badToken: Bool) {
        let hello = HelloMessage(windowId: windowId, host: .cursor, repo: repo, token: badToken ? "WRONG" : token)
        send(hello)
    }

    func sendSnapshot(
        worktrees: [WorktreeRef], sessions: [SessionInfo], focused: Bool = false
    ) {
        send(
            SnapshotMessage(
                windowId: windowId, worktrees: worktrees, sessions: sessions,
                focused: focused))
    }

    private func receive() {
        conn.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, let cmd = try? JSONDecoder().decode(CommandMessage.self, from: data) {
                if let reply = self.onCommand?(cmd) {
                    self.send(reply)
                }
            }
            if error == nil { self.receive() }
        }
    }

    private func send<T: Encodable>(_ message: T) {
        guard let data = try? JSONEncoder().encode(message) else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "text", metadata: [meta])
        conn.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
    }

    func close() { conn.cancel() }
}

// MARK: - Self-test driver

enum BrokerSelfTest {
    static func run() -> Bool {
        try? Bootstrap.ensure()
        guard let token = Bootstrap.loadToken() else {
            print("FAIL[broker]: no token"); return false
        }
        let port: UInt16 = 47699
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[broker]: \(name)")
            if !cond { pass = false }
        }

        // 0) Pure §4 precedence check (no networking).
        do {
            let w = RegisteredWindow(
                windowId: "w", host: .cursor,
                repo: RepoRef(name: "r", trunkPath: "/r"),
                sessions: [
                    session("a", .working),
                    session("b", .question),      // needs-input present
                    session("c", .done, seen: false),
                ])
            let s = Aggregator.aggregate(windows: [w], alertCount: 0)
            check("needs-input beats done-unseen & working", s.category == .needsInput && s.count == 1)
            let sAlert = Aggregator.aggregate(windows: [w], alertCount: 3)
            check("alert beats everything, count = alertCount", sAlert.category == .alert && sAlert.count == 3)
            let working = RegisteredWindow(
                windowId: "w2", host: .cursor, repo: RepoRef(name: "r2", trunkPath: "/r2"),
                sessions: [session("x", .working), session("y", .done, seen: true)])
            let sw = Aggregator.aggregate(windows: [working], alertCount: 0)
            check("working carries its count (drives dashes, not a number)", sw.category == .working && sw.count == 1)
        }

        let broker = Broker(port: Int(port), token: token, cursorPath: "/usr/bin/true")
        do { try broker.start() } catch {
            check("broker starts", false); return pass
        }
        check("broker starts", true)

        // 1) Two clients connect + register, wrong-token client rejected.
        let repoA = RepoRef(name: "core", trunkPath: "/tmp/core")
        let repoB = RepoRef(name: "andreys-helper", trunkPath: "/tmp/ah")
        let clientA = MockExtensionClient(port: port, windowId: "winA", repo: repoA, token: token)
        let clientB = MockExtensionClient(port: port, windowId: "winB", repo: repoB, token: token)
        let bad = MockExtensionClient(port: port, windowId: "winBad", repo: repoA, token: token)

        clientA.connect()
        clientB.connect()
        bad.connect(sendHello: false)
        bad.sendHello(badToken: true)  // will connect then send bad token
        Thread.sleep(forTimeInterval: 0.6)

        clientA.sendSnapshot(
            worktrees: [WorktreeRef(path: "/tmp/core", name: "core", branch: "main", ahead: 0, behind: 0, isTrunk: true)],
            sessions: [session2("t1", "s1", "/tmp/core", .question)])
        clientB.sendSnapshot(
            worktrees: [WorktreeRef(path: "/tmp/ah", name: "ah", branch: "main", ahead: 0, behind: 0, isTrunk: true)],
            sessions: [session2("t2", "s2", "/tmp/ah", .working)])
        Thread.sleep(forTimeInterval: 0.5)

        var registry: [RegisteredWindow] = []
        let sem = DispatchSemaphore(value: 0)
        broker.snapshotRegistry { registry = $0; sem.signal() }
        _ = sem.wait(timeout: .now() + 2)
        check("two authenticated clients registered (bad-token rejected)", registry.count == 2)
        let agg = Aggregator.aggregate(windows: registry, alertCount: 0)
        check("aggregation across windows → needs-input (question wins over working)", agg.category == .needsInput && agg.count == 1)

        // 1b) Upfront arbitration. The bug this guards: the broker used to latch
        //     the FIRST window to report `focused == true` and ignore every
        //     `false`, so the latch could only be revoked by another window
        //     announcing focus. A window that said "I no longer have focus" kept
        //     the upfront styling while a different repo's window — the one
        //     actually claiming focus — did not get it.
        //     Asserted through the real publish path, so this is what the UI sees.
        let treeLock = NSLock()
        var latestTree = SessionTree()
        broker.onStateChange = { tree, _ in
            treeLock.lock()
            latestTree = tree
            treeLock.unlock()
        }
        let upfrontWt = [WorktreeRef(path: "/tmp/x", name: "x", branch: "main", ahead: 0, behind: 0, isTrunk: true)]
        func upfrontRepo() -> String? {
            treeLock.lock()
            defer { treeLock.unlock() }
            return latestTree.windows.first { $0.isUpfront }?.repoName
        }
        func focus(_ client: MockExtensionClient, _ focused: Bool) {
            client.sendSnapshot(worktrees: upfrontWt, sessions: [], focused: focused)
            Thread.sleep(forTimeInterval: 0.25)
        }

        focus(clientB, true)   // andreys-helper takes focus
        focus(clientA, true)   // core takes focus
        check("the window claiming focus is upfront", upfrontRepo() == "core")
        focus(clientA, false)  // core loses focus; andreys-helper still claims it
        check(
            "a window that gave up focus yields to the one still claiming it",
            upfrontRepo() == "andreys-helper")
        focus(clientB, false)  // user switched to another app entirely
        check(
            "with nobody focused the last-focused window stays upfront",
            upfrontRepo() == "andreys-helper")
        focus(clientA, true)
        clientA.close()        // the upfront window disconnects
        Thread.sleep(forTimeInterval: 0.4)
        check(
            "a disconnected upfront window hands off, not to nil",
            upfrontRepo() == "andreys-helper")
        broker.onStateChange = nil

        // 2) Command routes to the correct client and result surfaces.
        clientB.onCommand = { cmd in
            ResultMessage(cmdId: cmd.cmdId, ok: true, data: AnyCodable(["verb": cmd.verb.rawValue]), error: nil)
        }
        let routeSem = DispatchSemaphore(value: 0)
        var routed = false
        broker.sendCommand(toRepo: "andreys-helper", verb: .reveal, args: CommandArgs(sessionId: "s2")) { result in
            if case .success(let r) = result, r.ok { routed = true }
            routeSem.signal()
        }
        _ = routeSem.wait(timeout: .now() + 3)
        check("command routes by repo and result surfaces", routed)

        // 2b) whenFocused gates work on the target window actually being frontmost
        //     — the ordering click-to-focus depends on: a reveal delivered before
        //     the editor comes forward surfaces the tab without the keyboard.
        let firedLock = NSLock()
        var fired = false
        func didFire() -> Bool {
            firedLock.lock(); defer { firedLock.unlock() }; return fired
        }
        broker.whenFocused(clientB.windowId, timeout: 5) {
            firedLock.lock(); fired = true; firedLock.unlock()
        }
        Thread.sleep(forTimeInterval: 0.3)
        check("whenFocused holds while the window is still in the background", !didFire())
        focus(clientB, true)  // the window comes forward and says so
        check("whenFocused fires once the window reports focus", didFire())

        // A window that never reports focus still gets a best-effort run.
        var lateFired = false
        broker.whenFocused("no-such-window", timeout: 0.4) {
            firedLock.lock(); lateFired = true; firedLock.unlock()
        }
        Thread.sleep(forTimeInterval: 0.9)
        firedLock.lock()
        let timedOut = lateFired
        firedLock.unlock()
        check("whenFocused falls back after its timeout", timedOut)

        // 3) Cold-start: openWindow launches (fake cursor = /usr/bin/true), then a
        //    matching client connects → resolves.
        let coldRepoPath = "/tmp/coldrepo"
        let coldSem = DispatchSemaphore(value: 0)
        var coldResolved = false
        broker.openWindow(path: coldRepoPath, timeout: 4) { result in
            if case .success = result { coldResolved = true }
            coldSem.signal()
        }
        // Simulate the freshly-launched window connecting a moment later.
        let coldClient = MockExtensionClient(
            port: port, windowId: "winCold",
            repo: RepoRef(name: "coldrepo", trunkPath: coldRepoPath), token: token)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) { coldClient.connect() }
        _ = coldSem.wait(timeout: .now() + 6)
        check("cold-start resolves when window connects", coldResolved)

        clientA.close(); clientB.close(); bad.close(); coldClient.close()
        broker.stop()
        return pass
    }

    private static func session(_ id: String, _ status: SessionStatus, seen: Bool = false) -> SessionInfo {
        SessionInfo(tabId: id, sessionId: id, cwd: "/x", title: id, status: status, seen: seen, col: 1, active: false)
    }
    private static func session2(_ tab: String, _ sid: String, _ cwd: String, _ status: SessionStatus) -> SessionInfo {
        SessionInfo(tabId: tab, sessionId: sid, cwd: cwd, title: tab, status: status, seen: false, col: 1, active: false)
    }
}
