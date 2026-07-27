// Orchestrator host — tabbed embedded SwiftTerm `claude` sessions in the neutral
// workspace (Workstream W5, PLAN.md §2, §3, §5, §7).
//
// Each tab is its OWN pseudo-terminal + `claude` process with its own
// conversation; tabs run fully independently (§2, §3). The controller tracks
// per-tab running/idle state and drives `AppModel.hasRunningOrchestrator` so
// state-3 stays open while ANY tab is running and collapses when the last tab is
// closed (§3 show/hide rules).
//
// `claude` is launched through a login shell with the user's real PATH in the
// child environment (see Model/UserShell.swift — neither launchd's PATH nor a
// non-interactive login shell can be trusted to find it), and a missing `claude`
// degrades to a graceful in-terminal message (never a crash).

import AppKit
import Foundation
import SwiftTerm

/// One orchestrator tab: a live PTY + `claude` process and its terminal view.
final class OrchestratorTab: Identifiable {
    let id: Int
    var title: String
    let terminal: LocalProcessTerminalView
    /// True while the tab's child process is alive (drives the §3 keep-open rule).
    fileprivate(set) var running: Bool = false

    init(id: Int, title: String) {
        self.id = id
        self.title = title
        self.terminal = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 320, height: 480))
    }
}

/// Owns the orchestrator tabs and their lifecycle. Like `AppModel`, it is used
/// on the main thread only; producers on other threads (the SwiftTerm process
/// delegate) hop to main before mutating published state.
final class Orchestrator: ObservableObject, LocalProcessTerminalViewDelegate {
    @Published private(set) var tabs: [OrchestratorTab] = []
    @Published var activeTabId: Int?

    /// Fired whenever the aggregate running-state changes (any tab running).
    /// The app wires this to `AppModel.hasRunningOrchestrator` (§3).
    var onRunningChanged: ((Bool) -> Void)?

    private let workspace: String
    private let shellPath: String
    private var nextNumber = 1
    private var seeded = false

    init(config: OrchestratorConfig = Bootstrap.loadConfig().orchestrator) {
        self.workspace = (config.workspace as NSString).expandingTildeInPath
        self.shellPath = UserShell.shellPath
        // Resolve the user's PATH now, off the main thread, so opening the first
        // tab never waits on their rc files.
        UserShell.prewarm()
    }

    var anyRunning: Bool { tabs.contains { $0.running } }

    // MARK: Tab lifecycle

    /// Ensure the pane has at least one tab (called when state-3 first opens).
    func ensureStarted() {
        if tabs.isEmpty { addTab() }
    }

    /// Add a fresh orchestrator (a new `claude` in the same neutral workspace, §3).
    @discardableResult
    func addTab() -> OrchestratorTab {
        seedWorkspaceIfNeeded()
        let tab = OrchestratorTab(id: nextNumber, title: "orch \(nextNumber)")
        nextNumber += 1
        tab.terminal.processDelegate = self
        tabs.append(tab)
        activeTabId = tab.id
        launch(tab)
        return tab
    }

    /// Close a tab (independently closable, §3). Closing the last tab collapses
    /// state-3 back to the session pane via `onRunningChanged`-driven state plus
    /// the shell's own "no tabs" handling.
    func closeTab(_ id: Int) {
        guard let idx = tabs.firstIndex(where: { $0.id == id }) else { return }
        let tab = tabs[idx]
        tab.terminal.processDelegate = nil
        tab.terminal.terminate()
        tabs.remove(at: idx)
        if activeTabId == id { activeTabId = tabs.last?.id }
        recomputeRunning()
    }

    func activate(_ id: Int) {
        guard tabs.contains(where: { $0.id == id }) else { return }
        activeTabId = id
    }

    var activeTab: OrchestratorTab? {
        tabs.first { $0.id == activeTabId }
    }

    /// True once the last tab has been closed — the shell collapses state-3 (§3).
    var isEmpty: Bool { tabs.isEmpty }

    // MARK: Screenshot / file drag-in (§3)

    /// Insert a dropped file's path into the active tab's `claude` (so a user can
    /// drag a screenshot in). Best-effort.
    func insertPath(_ path: String, into id: Int? = nil) {
        let target = id.flatMap { tid in tabs.first { $0.id == tid } } ?? activeTab
        guard let tab = target else { return }
        // Quote to survive spaces; leading space avoids gluing onto prior input.
        let quoted = path.contains(" ") ? "'\(path.replacingOccurrences(of: "'", with: "'\\''"))'" : path
        tab.terminal.send(txt: quoted + " ")
    }

    // MARK: Process launch

    private func launch(_ tab: OrchestratorTab) {
        // Run `claude` via a login shell so profile-managed setup still applies,
        // but hand the child the PATH the user's terminal actually has: SwiftTerm's
        // default child environment has no PATH at all, and `zsh -lc` never reads
        // `.zshrc`, where most zsh setups put `claude` on PATH. A missing binary
        // still degrades to an in-terminal message and a shell prompt rather than
        // a crash (PLAN.md §8 W5 guard).
        let script = """
        command -v claude >/dev/null 2>&1 && exec claude \
        || { printf '\\n\\033[33m[claude CLI not found on PATH]\\033[0m Install Claude Code, then open a new orchestrator tab.\\n\\n'; exec "$0" -l; }
        """
        tab.running = true
        recomputeRunning()
        tab.terminal.startProcess(
            executable: shellPath,
            args: ["-lc", script],
            environment: UserShell.terminalEnvironment(),
            currentDirectory: workspace)
    }

    private func recomputeRunning() {
        onRunningChanged?(anyRunning)
    }

    // MARK: Workspace seeding (§7 — copy the operating manual in)

    private func seedWorkspaceIfNeeded() {
        guard !seeded else { return }
        seeded = true
        let fm = FileManager.default
        try? fm.createDirectory(atPath: workspace, withIntermediateDirectories: true)
        let dest = (workspace as NSString).appendingPathComponent("CLAUDE.md")
        guard !fm.fileExists(atPath: dest) else { return }
        // W7 authors `orchestrator/orchestrator-workspace/CLAUDE.md`; it may be absent
        // at build time — copy it if present, otherwise no-op (PLAN.md §8 W5).
        for candidate in manualSourceCandidates() where fm.fileExists(atPath: candidate) {
            try? fm.copyItem(atPath: candidate, toPath: dest)
            break
        }
    }

    private func manualSourceCandidates() -> [String] {
        var paths: [String] = []
        let cwd = fm_cwd()
        paths.append((cwd as NSString).appendingPathComponent("orchestrator-workspace/CLAUDE.md"))
        // When run from the repo root or the orchestrator dir.
        paths.append((cwd as NSString).appendingPathComponent("orchestrator/orchestrator-workspace/CLAUDE.md"))
        if let resource = Bundle.main.resourcePath {
            paths.append((resource as NSString).appendingPathComponent("orchestrator-workspace/CLAUDE.md"))
        }
        return paths
    }

    private func fm_cwd() -> String { FileManager.default.currentDirectoryPath }

    // MARK: LocalProcessTerminalViewDelegate

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let tab = self.tabs.first(where: { $0.terminal === source }) {
                tab.running = false
                self.recomputeRunning()
            }
        }
    }

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
}
