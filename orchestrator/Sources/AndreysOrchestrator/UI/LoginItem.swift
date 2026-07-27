// Launch-at-login (PLAN.md Phase 3, item 3).
//
// Wraps `SMAppService.mainApp` (macOS 13+) to register/unregister the app as a
// login item. Registration only makes sense for a real, launchable `.app`
// bundle; when the binary is run un-bundled (`swift run`, a bare executable in
// `.build/`) `SMAppService` has nothing to register, so every entry point here
// no-ops gracefully instead of crashing.

import Foundation
import ServiceManagement

public enum LoginItem {
    /// True only when we are running from a proper `.app` bundle whose executable
    /// lives under `Contents/MacOS`. `swift run` binaries live in `.build/…` and
    /// have no surrounding bundle, so login-item registration is unavailable.
    public static var isBundled: Bool {
        guard let bundleId = Bundle.main.bundleIdentifier, !bundleId.isEmpty else {
            return false
        }
        return Bundle.main.bundleURL.pathExtension == "app"
    }

    /// Whether the app is currently registered as a login item. Returns false
    /// (rather than throwing) when unavailable.
    public static var isEnabled: Bool {
        guard isBundled else { return false }
        return SMAppService.mainApp.status == .enabled
    }

    /// Register/unregister the main app as a login item. No-ops (returns false)
    /// when run un-bundled. Returns whether the requested state was achieved.
    @discardableResult
    public static func setEnabled(_ enabled: Bool) -> Bool {
        guard isBundled else {
            NSLog("AndreysOrchestrator: launch-at-login unavailable (not running from a .app bundle) — skipping")
            return false
        }
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled {
                    try SMAppService.mainApp.register()
                }
            } else {
                if SMAppService.mainApp.status == .enabled {
                    try SMAppService.mainApp.unregister()
                }
            }
            return SMAppService.mainApp.status == (enabled ? .enabled : .notRegistered)
        } catch {
            NSLog("AndreysOrchestrator: launch-at-login \(enabled ? "register" : "unregister") failed: \(error)")
            return false
        }
    }

    /// On launch, reconcile the OS login-item state with the persisted user
    /// preference (best-effort; no-op when un-bundled).
    public static func reconcile(with config: Config) {
        guard isBundled, let want = config.launchAtLogin else { return }
        if want != isEnabled { setEnabled(want) }
    }
}
