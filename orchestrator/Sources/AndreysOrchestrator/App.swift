// Entry point for the AndreysOrchestrator ("The Circle") — PLAN.md §2, §3, §8.
//
// Wires the three in-package workstreams together:
//   • W3 Broker  — WS server; feeds the aggregated tree + circle state.
//   • W4 Daemon  — scheduler; feeds the alert queue + pending-jobs strip and
//                  consumes the broker's completion-transition stream.
//   • W2 UI      — the circle + panes, hosted in a borderless floating NSPanel.
//
// Flags:
//   --selftest   run the W3 + W4 self-tests, print PASS/FAIL, exit (no GUI).
//   --fixtures   show the UI with canned data; no broker/daemon networking.

import AppKit

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let useFixtures: Bool
    private var model: AppModel!
    private var panelController: PanelController!
    private let settingsController = SettingsWindowController()
    private var broker: Broker?
    private var daemon: Daemon?
    private var quotaMonitor: QuotaMonitor?
    private var configWatcher: ConfigWatcher?
    private var latestWindows: [RegisteredWindow] = []

    init(useFixtures: Bool) {
        self.useFixtures = useFixtures
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // §6.4 — ensure config + token exist before anything else runs.
        do { try Bootstrap.ensure() } catch {
            NSLog("AndreysOrchestrator: bootstrap failed: \(error)")
        }

        // Reconcile launch-at-login with the persisted preference (no-op when
        // run un-bundled). PLAN.md Phase 3, item 3.
        LoginItem.reconcile(with: Bootstrap.loadConfig())

        let model = AppModel()
        self.model = model

        // Common intents (both fixtures + live): Settings window and Quit.
        model.openSettingsIntent = { [weak self] in self?.settingsController.show() }
        model.quitIntent = { NSApp.terminate(nil) }

        // Moon mode is an EXTENSION setting patched straight into config.json,
        // so it is read at launch and then watched — toggling it in the editor
        // re-skins the circle without a relaunch.
        model.moonMode = Bootstrap.loadConfig().moonMode ?? false
        let watcher = ConfigWatcher { [weak model] config in
            let on = config.moonMode ?? false
            // Turning moon mode off while the moon is blown up would otherwise
            // leave a 450pt frosted disc parked on the desktop.
            if !on { model?.exitMoonZoom() }
            model?.moonMode = on
        }
        self.configWatcher = watcher
        watcher.start()

        if useFixtures {
            wireFixtures(model)
        } else {
            wireLive(model)
        }

        let controller = PanelController(model: model)
        self.panelController = controller
        controller.show()

        // Deliberately no `NSApp.activate` here. This is an accessory HUD whose
        // panel is not key-capable outside the orchestrator stage, so activating
        // would leave the app frontmost with no window able to take keystrokes —
        // they would land nowhere until the user clicked another app. The
        // Settings window activates on its own when it is opened.
    }

    // MARK: Fixtures wiring (§8 W2)

    private func wireFixtures(_ model: AppModel) {
        model.revealIntent = { session in
            NSLog("AndreysOrchestrator[fixtures]: reveal \(session.sessionId ?? session.tabId)")
        }
        model.ackAlertIntent = { id in NSLog("AndreysOrchestrator[fixtures]: ack \(id)") }
        // Mark one window upfront so the fixtures exercise all three tab states:
        // win-core's active tab renders "upfront" (state 3), win-ah's active tab
        // renders "window-active" (state 2), the rest are inactive (state 1).
        model.applyBroker(
            tree: Aggregator.buildTree(windows: Fixtures.windows(), upfront: "win-core"),
            windows: Fixtures.windows())
        model.applyPending(Fixtures.pendingJobs())
        model.applyQuota(Fixtures.quota())
    }

    // MARK: Live wiring (§8 integration)

    private func wireLive(_ model: AppModel) {
        let config = Bootstrap.loadConfig()
        let broker = Broker(port: config.port)
        let daemon = Daemon()
        self.broker = broker
        self.daemon = daemon

        // Plan usage → the session-pane header bars. Independent of the broker and
        // daemon: it asks the `claude` CLI directly (see Model/Quota.swift).
        let quotaMonitor = QuotaMonitor()
        self.quotaMonitor = quotaMonitor
        quotaMonitor.onSnapshot = { [weak self] snapshot in
            self?.model.applyQuota(snapshot)
        }
        model.refreshQuotaIntent = { [weak quotaMonitor] in quotaMonitor?.refreshIfStale(60) }

        // Broker → UI (in-process, direct Swift — PLAN.md §6.2).
        broker.onStateChange = { [weak self] tree, windows in
            DispatchQueue.main.async {
                self?.latestWindows = windows
                self?.model.applyBroker(tree: tree, windows: windows)
            }
        }
        // Broker → Daemon (completion-transition stream, PLAN.md §6.5).
        broker.onTransition = { [weak daemon] sid, from, to in
            daemon?.handleTransition(sessionId: sid, from: from, to: to)
        }
        // `ah` CLI schedule/alert verbs → daemon (PLAN.md §6.3).
        broker.onSchedule = { [weak daemon] spec in
            guard let daemon else { return ["ok": false, "error": "daemon unavailable"] }
            return ScheduleSpec.handle(spec, daemon: daemon)
        }
        broker.onAlert = { [weak daemon] text in daemon?.pushAlert(text) }

        // Daemon → UI.
        daemon.onAlertsChanged = { [weak self] alerts in
            DispatchQueue.main.async { self?.model.applyAlerts(alerts) }
        }
        daemon.onPendingChanged = { [weak self] jobs in
            DispatchQueue.main.async { self?.model.applyPending(jobs) }
        }
        // Daemon dispatch action → broker routing (best-effort; W4→W3 bridge).
        daemon.onDispatch = { [weak self] verb, args in
            guard let self, let sid = args.sessionId,
                let win = self.latestWindows.first(where: { $0.sessions.contains { $0.sessionId == sid } })
            else {
                NSLog("AndreysOrchestrator: dispatch \(verb.rawValue) had no routable target")
                return
            }
            self.broker?.sendCommand(to: win.windowId, verb: verb, args: args) { _ in }
        }

        // UI intents → broker/daemon.
        model.revealIntent = { [weak self] session in
            guard let self else { return }
            // Address by sessionId when known, else the tabId (a just-spawned tab
            // has no sessionId yet); the extension resolves either (PLAN.md §6.1).
            let sid = session.sessionId ?? session.tabId
            guard let win = self.latestWindows.first(where: { w in
                w.sessions.contains { ($0.sessionId ?? $0.tabId) == sid }
            }) else { return }
            let reveal = { [weak self] in
                self?.broker?.sendCommand(
                    to: win.windowId, verb: .reveal, args: CommandArgs(sessionId: sid)) { _ in }
            }
            // Already the frontmost window (the pane's own hover never takes the
            // OS focus away from it): reveal straight away.
            if win.focused {
                reveal()
                return
            }
            // Two steps (PLAN.md §9.1): first foreground the target Cursor window
            // from behind this always-on-top panel by re-invoking the CLI on the
            // folder it has open, then tell the extension to reveal that tab.
            //
            // These are STRICTLY ordered. The CLI needs ~1.3s to bring the editor
            // forward, and a reveal that lands before that focuses a tab in a
            // background window: the webview host only passes keyboard focus into
            // the panel's content when the workbench document has focus at that
            // moment, so the tab surfaced with the caret dead — visible, but every
            // keystroke going elsewhere. `whenFocused` holds the reveal until the
            // window itself reports it is frontmost (or 3s, best-effort).
            //
            // Belt and braces: the panel is not key-capable outside the
            // orchestrator stage, but if anything (an open Settings window) left
            // us active, hand the keyboard back before raising the editor.
            if NSApp.isActive { NSApp.deactivate() }
            self.broker?.foreground(path: win.repo.trunkPath)
            self.broker?.whenFocused(win.windowId) { reveal() }
        }
        model.ackAlertIntent = { [weak daemon] id in daemon?.ackAlert(id: id) }

        do { try broker.start() } catch {
            NSLog("AndreysOrchestrator: broker failed to start: \(error)")
        }
        daemon.start()
        quotaMonitor.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    @objc func openSettings() { settingsController.show() }
}

// MARK: - Menu (⌘Q)

private func makeMainMenu() -> NSMenu {
    let mainMenu = NSMenu()
    let appItem = NSMenuItem()
    mainMenu.addItem(appItem)
    let appMenu = NSMenu()
    appItem.submenu = appMenu
    appMenu.addItem(
        withTitle: "Settings…",
        action: #selector(AppDelegate.openSettings),
        keyEquivalent: ",")
    appMenu.addItem(.separator())
    appMenu.addItem(
        withTitle: "Quit AndreysOrchestrator",
        action: #selector(NSApplication.terminate(_:)),
        keyEquivalent: "q")
    return mainMenu
}

// MARK: - main

@main
enum OrchestratorMain {
    private static var delegate: AppDelegate!

    static func main() {
        let args = Set(CommandLine.arguments.dropFirst())

        // --selftest: run W3 + W4 assertions headlessly and exit.
        if args.contains("--selftest") {
            let brokerPass = BrokerSelfTest.run()
            let daemonPass = DaemonSelfTest.run()
            let ok = brokerPass && daemonPass
            print("SELFTEST \(ok ? "PASS" : "FAIL") (broker=\(brokerPass) daemon=\(daemonPass))")
            exit(ok ? 0 : 1)
        }

        // --selftest-e2e: drive the real `ah` binary against the real broker (W8).
        if args.contains("--selftest-e2e") {
            print("E2E SELFTEST (broker ↔ ah CLI)")
            let ok = E2ESelfTest.run()
            print("SELFTEST-E2E \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-alerts: fire → ack → re-derive CircleState (PLAN.md §4, Phase 3).
        if args.contains("--selftest-alerts") {
            let ok = AlertsSelfTest.run()
            print("SELFTEST-ALERTS \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --install-ah: symlink the `ah` CLI onto PATH, print the location, exit.
        if args.contains("--install-ah") {
            do { try Bootstrap.ensure() } catch { NSLog("bootstrap: \(error)") }
            let result = AhInstaller.install()
            print("INSTALL-AH \(result.ok ? "OK" : "FAIL"): \(result.message)")
            if let hint = result.pathHint { print("  hint: \(hint)") }
            exit(result.ok ? 0 : 1)
        }

        // --selftest-reveal: the pane's highlight through a cross-window click.
        if args.contains("--selftest-reveal") {
            let ok = RevealSelfTest.run()
            print("SELFTEST-REVEAL \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-drag: headless check that dragging the circle up from a low
        // corner with the pane open reaches the top (no trap).
        if args.contains("--selftest-drag") {
            let ok = PanelController.dragSelfTest()
            print("SELFTEST-DRAG \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-corner: the circle parks FLUSH in a screen corner, so a
        // flicked pointer that stops at the edge is already hovering it.
        if args.contains("--selftest-corner") {
            let ok = PanelController.cornerParkSelfTest()
            print("SELFTEST-CORNER \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-hover: the pointer regions the pane opens/closes on.
        if args.contains("--selftest-hover") {
            let ok = PanelController.hoverRegionSelfTest()
            print("SELFTEST-HOVER \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-frozen: the panel holds its size while the window server is
        // not honoring geometry (Show Desktop), instead of drawing a big surface
        // into a small rect and letting it be scaled.
        if args.contains("--selftest-frozen") {
            let ok = PanelController.geometryFreezeSelfTest()
            print("SELFTEST-FROZEN \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-moonzoom: click-to-enlarge the moon keeps every pixel on
        // screen and gives the circle its parked spot back.
        if args.contains("--selftest-moonzoom") {
            print("MOON ZOOM SELFTEST (click-to-enlarge)")
            let ok = PanelController.moonZoomSelfTest()
            print("SELFTEST-MOONZOOM \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-moonart: the painted centre glyphs sit where the artwork puts
        // them, and a lone one is centred on the disc.
        if args.contains("--selftest-moonart") {
            print("MOON ART SELFTEST (painted centre glyphs)")
            let ok = MoonArtSelfTest.run()
            print("SELFTEST-MOONART \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-key: the panel may only take the keyboard in the
        // orchestrator stage (a key non-activating panel eats the editor's keys).
        if args.contains("--selftest-key") {
            let ok = PanelController.keyPolicySelfTest()
            print("SELFTEST-KEY \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-quota: parser assertions + a live `get_usage` probe.
        if args.contains("--selftest-quota") {
            print("QUOTA SELFTEST (plan usage bars)")
            let ok = QuotaSelfTest.run()
            print("SELFTEST-QUOTA \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --selftest-orch: headless check of the W5 orchestrator host.
        if args.contains("--selftest-orch") {
            print("ORCH SELFTEST (embedded terminal host)")
            let ok = OrchestratorSelfTest.run()
            print("SELFTEST-ORCH \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        // --render-circle <path>: contact sheet of every circle state, both
        // skins, to a PNG. The panel does not composite into `screencapture`,
        // so this is how a change to `CircleView` gets looked at.
        if args.contains("--render-circle") {
            // `args` is a Set (every other flag is a bare presence check), so the
            // path is read back off the ordered argument list.
            let argv = CommandLine.arguments
            guard let i = argv.firstIndex(of: "--render-circle"), i + 1 < argv.count else {
                print("usage: --render-circle <path.png> [scale]")
                exit(2)
            }
            // Optional trailing scale, for when the detail being judged is a
            // couple of design points across.
            let scale: CGFloat = {
                guard i + 2 < argv.count, let v = Double(argv[i + 2]) else { return 6 }
                return CGFloat(v)
            }()
            let ok = MainActor.assumeIsolated {
                CircleRender.run(path: argv[i + 1], scale: scale)
            }
            print("RENDER-CIRCLE \(ok ? "PASS" : "FAIL")")
            exit(ok ? 0 : 1)
        }

        let delegate = AppDelegate(useFixtures: args.contains("--fixtures"))
        OrchestratorMain.delegate = delegate

        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.accessory)  // floating utility, no dock icon.
        app.mainMenu = makeMainMenu()
        app.run()
    }
}
