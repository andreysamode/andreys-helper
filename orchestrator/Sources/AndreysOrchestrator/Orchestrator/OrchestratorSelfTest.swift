// Bounded, headless check for the W5 orchestrator host (PLAN.md §8 W5 verify).
//
// Spawns one orchestrator tab in a temp workspace, spins the run loop briefly,
// and asserts: the workspace is created (+ CLAUDE.md seeded if the manual is
// present), a child process spawns and is running, running-state is reported via
// `onRunningChanged`, screenshot path insertion does not crash, and closing the
// last tab empties the host + reports not-running. Runs on the main thread and
// terminates on its own. `claude` may or may not be installed — either way a
// process (claude, or the fallback login shell) must be alive.
//
// It also checks the child environment the tab is launched with: a tab whose PATH
// cannot see `claude` shows the "not found on PATH" message instead of a session,
// so the resolved PATH is compared against what the user's own interactive login
// shell resolves.

import AppKit
import Foundation

enum OrchestratorSelfTest {
    static func run() -> Bool {
        var pass = true
        func check(_ label: String, _ ok: Bool) {
            print("  [\(ok ? "PASS" : "FAIL")] \(label)")
            if !ok { pass = false }
        }

        // Child environment (the "[claude CLI not found on PATH]" class of bug).
        let env = UserShell.terminalEnvironment()
        let envPath = env.first { $0.hasPrefix("PATH=") }?.dropFirst("PATH=".count) ?? ""
        check("child environment carries a PATH", !envPath.isEmpty)
        check("resolved PATH is the user's, not launchd's", UserShell.probeSucceeded)
        // Ground truth: what the user's shell itself resolves, interactively.
        let shellSees = interactiveLookup("claude")
        check(
            "PATH resolves `claude` iff the user's shell does"
                + (shellSees == nil ? " (not installed — skipped)" : " (\(shellSees!))"),
            (UserShell.resolve("claude") != nil) == (shellSees != nil))

        let workspace = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("orchestrator-orch-\(UUID().uuidString)")
        let orch = Orchestrator(config: OrchestratorConfig(workspace: workspace, hideByDefault: true))

        var lastRunning: Bool?
        orch.onRunningChanged = { lastRunning = $0 }

        orch.addTab()
        check("tab created", orch.tabs.count == 1 && orch.activeTabId == orch.tabs.first?.id)
        check("workspace seeded (dir exists)", FileManager.default.fileExists(atPath: workspace))
        check("running-state reported true on launch", lastRunning == true)

        // Let the child process settle.
        spinRunLoop(seconds: 2.0)
        check("a child process is alive after launch", orch.anyRunning)

        // The tab launched `claude`, not the not-found fallback — asserted against
        // what actually landed on the terminal.
        if shellSees != nil, let tab = orch.tabs.first {
            let screen = String(
                data: tab.terminal.getTerminal().getBufferAsData(), encoding: .utf8) ?? ""
            check("tab did not print the not-found fallback", !screen.contains("not found on PATH"))
        }

        // Screenshot drag-in path insertion must not crash.
        orch.insertPath("/tmp/some screenshot.png")
        check("insertPath did not crash", true)

        // A second independent tab.
        orch.addTab()
        check("second tab is independent", orch.tabs.count == 2)

        // Close all tabs → host empties, running reported false.
        for id in orch.tabs.map(\.id) { orch.closeTab(id) }
        spinRunLoop(seconds: 0.5)
        check("closing all tabs empties the host", orch.isEmpty)
        check("running reported false after last close", lastRunning == false && !orch.anyRunning)

        return pass
    }

    /// `command -v <name>` in an interactive login shell — the same lookup the
    /// user gets in a terminal window, resolved independently of `UserShell`.
    private static func interactiveLookup(_ name: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: UserShell.shellPath)
        process.arguments = ["-ilc", "command -v \(name) 2>/dev/null"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = (String(data: data, encoding: .utf8) ?? "")
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .last { $0.hasPrefix("/") }
        return text
    }

    private static func spinRunLoop(seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
    }
}
