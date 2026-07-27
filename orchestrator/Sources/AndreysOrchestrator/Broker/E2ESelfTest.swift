// End-to-end broker↔CLI reconciliation self-test (PLAN.md §8 W8 item 3).
//
// Boots the REAL broker, connects a mock extension client (the same NWConnection
// mock the W3 self-test uses) publishing a canned snapshot, then drives the REAL
// built `ah` binary (`node dist/ah.js …`, after `npm run build:cli`) against the
// broker via the `AH_PORT`/`AH_TOKEN` env the CLI supports, and asserts:
//   • `ah windows`  lists the mock window + repo,
//   • `ah sessions` lists its sessions,
//   • `ah reveal <id>` reaches the mock client and gets an ack,
//   • `ah alert <text>` is accepted by the broker/daemon.
//
// Invoked via `swift run AndreysOrchestrator --selftest-e2e`. Prints PASS/FAIL per check.
// Requires `node`/`npm` on PATH (driven through a login shell).

import Foundation

enum E2ESelfTest {
    static func run() -> Bool {
        var pass = true
        func check(_ label: String, _ ok: Bool) {
            print("  [\(ok ? "PASS" : "FAIL")] \(label)")
            if !ok { pass = false }
        }

        try? Bootstrap.ensure()
        guard let token = Bootstrap.loadToken() else {
            print("FAIL[e2e]: no token"); return false
        }

        // Repo root = parent of the package dir (`swift run` cwd is `orchestrator/`).
        let cwd = FileManager.default.currentDirectoryPath
        let repoRoot = (cwd as NSString).lastPathComponent == "orchestrator"
            ? (cwd as NSString).deletingLastPathComponent : cwd
        let ahJs = "\(repoRoot)/dist/ah.js"

        // 1) Build the CLI bundle.
        let build = shell("cd \(shq(repoRoot)) && npm run build:cli", timeout: 180)
        check("npm run build:cli succeeds", build.code == 0 && FileManager.default.fileExists(atPath: ahJs))
        if build.code != 0 {
            print(build.out.suffix(800))
            return false
        }

        // 2) Start the real broker on a test port.
        let port = Int.random(in: 47700...48600)
        let broker = Broker(port: port, token: token, cursorPath: "/usr/bin/true")
        let daemon = Daemon(store: JobStore(url: tmpJobsURL()))
        broker.onSchedule = { spec in ScheduleSpec.handle(spec, daemon: daemon) }
        var alertReceived: String?
        broker.onAlert = { text in alertReceived = text }
        do { try broker.start() } catch {
            check("broker starts", false); return false
        }
        check("broker starts", true)

        // 3) Connect a mock extension client with a canned snapshot.
        let repo = RepoRef(name: "core", trunkPath: "/tmp/e2e-core")
        let client = MockExtensionClient(port: UInt16(port), windowId: "e2e-win", repo: repo, token: token)
        var revealReached = false
        client.onCommand = { cmd in
            if cmd.verb == .reveal { revealReached = true }
            return ResultMessage(cmdId: cmd.cmdId, ok: true, data: AnyCodable(["verb": cmd.verb.rawValue]), error: nil)
        }
        client.connect()
        Thread.sleep(forTimeInterval: 0.4)
        client.sendSnapshot(
            worktrees: [WorktreeRef(path: "/tmp/e2e-core", name: "core", branch: "main",
                                    ahead: 0, behind: 0, isTrunk: true)],
            sessions: [SessionInfo(tabId: "tab-1", sessionId: "sess-1", cwd: "/tmp/e2e-core",
                                   title: "e2e session", status: .question, seen: false, col: 1, active: true)])
        Thread.sleep(forTimeInterval: 0.6)

        // Env the CLI reads (config.ts): AH_PORT + AH_TOKEN override config/token.
        let env = "AH_PORT=\(port) AH_TOKEN=\(shq(token))"
        func ah(_ verb: String) -> (code: Int32, out: String) {
            shell("cd \(shq(repoRoot)) && \(env) node \(shq(ahJs)) \(verb)", timeout: 30)
        }

        // 4) ah windows
        let windows = ah("windows")
        let winJSON = parse(windows.out)
        let winList = ((winJSON?["windows"]) as? [[String: Any]]) ?? []
        check("ah windows lists the mock window (repo=core)",
              windows.code == 0 && winList.contains { ($0["repo"] as? [String: Any])?["name"] as? String == "core" })

        // 5) ah sessions
        let sessions = ah("sessions")
        let sesJSON = parse(sessions.out)
        let sesList = ((sesJSON?["sessions"]) as? [[String: Any]]) ?? []
        check("ah sessions lists sess-1",
              sessions.code == 0 && sesList.contains { $0["sessionId"] as? String == "sess-1" })

        // 5b) ah sessions --repo filter applied broker-side
        let filtered = ah("sessions --repo core")
        let fList = ((parse(filtered.out)?["sessions"]) as? [[String: Any]]) ?? []
        let filteredEmpty = ah("sessions --repo nope")
        let fEmpty = ((parse(filteredEmpty.out)?["sessions"]) as? [[String: Any]]) ?? []
        check("ah sessions --repo filters broker-side", fList.count == 1 && fEmpty.isEmpty)

        // 6) ah reveal sess-1 → routed to the mock client + ack
        let reveal = ah("reveal sess-1")
        Thread.sleep(forTimeInterval: 0.3)
        check("ah reveal sess-1 routed to window and acked", reveal.code == 0 && revealReached)

        // 7) ah alert → broker/daemon
        let alert = ah("alert e2e-hello")
        Thread.sleep(forTimeInterval: 0.2)
        check("ah alert reaches the daemon", alert.code == 0 && alertReceived == "e2e-hello")

        // 8) unauthorized: wrong token is rejected
        let bad = shell("cd \(shq(repoRoot)) && AH_PORT=\(port) AH_TOKEN=WRONGTOKEN node \(shq(ahJs)) windows", timeout: 30)
        check("wrong token is rejected (nonzero exit)", bad.code != 0)

        client.close()
        broker.stop()
        return pass
    }

    // MARK: - Helpers

    private static func tmpJobsURL() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("orchestrator-e2e-jobs-\(UUID().uuidString).json")
    }

    /// Single-quote a string for safe embedding in a `bash -lc` command.
    private static func shq(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func parse(_ s: String) -> [String: Any]? {
        // The CLI prints JSON on stdout; take the last JSON object in the output.
        guard let start = s.firstIndex(of: "{"),
            let data = String(s[start...]).data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj
    }

    /// Run a command through a login shell so `node`/`npm` are on PATH.
    private static func shell(_ command: String, timeout: TimeInterval) -> (code: Int32, out: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = ["-lc", command]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch {
            return (-1, "spawn failed: \(error)")
        }
        // Bound the run so a hung CLI cannot stall the self-test.
        let deadline = Date().addingTimeInterval(timeout)
        let data = pipe.fileHandleForReading.readDataToEndOfFile()  // returns on process exit
        while process.isRunning && Date() < deadline { usleep(50_000) }
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}
