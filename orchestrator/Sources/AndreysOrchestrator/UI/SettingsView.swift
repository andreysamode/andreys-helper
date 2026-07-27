// Onboarding / first-run settings (PLAN.md Phase 3, item 6).
//
// A minimal-but-real SwiftUI window, reachable from the circle's right-click menu
// (and shown automatically on first run), that lets the user:
//   • edit `repoScanDirs` (add via an open panel / remove rows),
//   • toggle launch-at-login (item 3),
//   • install the `ah` CLI onto PATH (item 5).
// All changes persist through `Bootstrap.saveConfig`.

import AppKit
import SwiftUI

// MARK: - Backing model (loads/saves config)

final class SettingsModel: ObservableObject {
    @Published var repoScanDirs: [String]
    @Published var launchAtLogin: Bool
    @Published var launchAtLoginAvailable: Bool
    @Published var installStatus: String = ""

    init() {
        let config = Bootstrap.loadConfig()
        self.repoScanDirs = config.repoScanDirs
        self.launchAtLoginAvailable = LoginItem.isBundled
        self.launchAtLogin = LoginItem.isBundled ? LoginItem.isEnabled : (config.launchAtLogin ?? false)
    }

    func save() {
        var config = Bootstrap.loadConfig()
        config.repoScanDirs = repoScanDirs
        config.launchAtLogin = launchAtLogin
        Bootstrap.saveConfig(config)
    }

    func addDir() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        if panel.runModal() == .OK {
            for url in panel.urls where !repoScanDirs.contains(url.path) {
                repoScanDirs.append(url.path)
            }
            save()
        }
    }

    func removeDir(_ path: String) {
        repoScanDirs.removeAll { $0 == path }
        save()
    }

    func setLaunchAtLogin(_ on: Bool) {
        launchAtLogin = on
        if launchAtLoginAvailable {
            let ok = LoginItem.setEnabled(on)
            if !ok { launchAtLogin = LoginItem.isEnabled }  // reflect reality
        }
        save()
    }

    func installAh() {
        let result = AhInstaller.install()
        if result.ok {
            installStatus = "Installed → \(result.location)"
                + (result.pathHint.map { " (\($0))" } ?? "")
        } else {
            installStatus = result.message
        }
    }
}

// MARK: - View

struct SettingsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("AndreysOrchestrator Settings")
                .font(.title2).bold()

            // Repo scan dirs -------------------------------------------------
            VStack(alignment: .leading, spacing: 6) {
                Text("Repo scan directories")
                    .font(.headline)
                Text("Scanned for cold repos (no open window) in addition to live windows.")
                    .font(.caption).foregroundColor(.secondary)

                List {
                    ForEach(model.repoScanDirs, id: \.self) { dir in
                        HStack {
                            Text(dir).font(.system(size: 12)).lineLimit(1).truncationMode(.head)
                            Spacer()
                            Button(role: .destructive) { model.removeDir(dir) } label: {
                                Image(systemName: "minus.circle")
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                    if model.repoScanDirs.isEmpty {
                        Text("No directories configured")
                            .font(.system(size: 12)).foregroundColor(.secondary)
                    }
                }
                .frame(height: 120)
                .border(Color.secondary.opacity(0.2))

                Button { model.addDir() } label: {
                    Label("Add Directory…", systemImage: "plus")
                }
            }

            Divider()

            // Launch at login ------------------------------------------------
            VStack(alignment: .leading, spacing: 4) {
                Toggle("Launch at login", isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }))
                    .disabled(!model.launchAtLoginAvailable)
                if !model.launchAtLoginAvailable {
                    Text("Available only when running the packaged AndreysOrchestrator.app.")
                        .font(.caption).foregroundColor(.secondary)
                }
            }

            Divider()

            // Install ah -----------------------------------------------------
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Button { model.installAh() } label: {
                        Label("Install `ah` CLI", systemImage: "terminal")
                    }
                    Spacer()
                }
                Text("Symlinks the bundled `ah` onto your PATH (/usr/local/bin).")
                    .font(.caption).foregroundColor(.secondary)
                if !model.installStatus.isEmpty {
                    Text(model.installStatus)
                        .font(.system(size: 11)).foregroundColor(.secondary)
                        .textSelection(.enabled)
                }
            }

            Spacer()
        }
        .padding(20)
        .frame(width: 420, height: 520)
    }
}

// MARK: - Window controller (accessory-app friendly)

final class SettingsWindowController: NSObject {
    private var window: NSWindow?
    private let model = SettingsModel()

    func show() {
        if window == nil {
            let win = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 420, height: 520),
                styleMask: [.titled, .closable, .miniaturizable],
                backing: .buffered, defer: false)
            win.title = "AndreysOrchestrator Settings"
            win.isReleasedWhenClosed = false
            win.contentView = NSHostingView(rootView: SettingsView(model: model))
            win.center()
            window = win
        }
        // Accessory apps must activate to bring a standard window forward.
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}
