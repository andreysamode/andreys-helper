// First-run config + token bootstrap (PLAN.md §6.4).
//
// On launch the app ensures `~/.andreys-helper/config.json` exists (written with
// the §6.4 defaults if absent) and `~/.andreys-helper/token` exists (a random
// token, file mode 0600, if absent). Both are shared by the app, the extension,
// and the `ah` CLI. Called from `App.swift`.

import Foundation

public enum Bootstrap {
    /// The `~/.andreys-helper` directory.
    public static var baseDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".andreys-helper", isDirectory: true)
    }

    public static var configURL: URL {
        baseDir.appendingPathComponent("config.json", isDirectory: false)
    }

    public static var tokenURL: URL {
        baseDir.appendingPathComponent("token", isDirectory: false)
    }

    /// Create the config + token files if they are absent. Idempotent.
    public static func ensure() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: baseDir, withIntermediateDirectories: true)

        if !fm.fileExists(atPath: configURL.path) {
            try writeConfig(Config.defaults)
        }

        if !fm.fileExists(atPath: tokenURL.path) {
            try writeToken(randomToken())
        }
    }

    /// Read the current config, or the §6.4 defaults if it cannot be read.
    public static func loadConfig() -> Config {
        guard let data = try? Data(contentsOf: configURL),
            let config = try? JSONDecoder().decode(Config.self, from: data)
        else {
            return Config.defaults
        }
        return config
    }

    /// Read the shared token, or nil if absent.
    public static func loadToken() -> String? {
        guard let data = try? Data(contentsOf: tokenURL),
            let token = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        return token.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Persist an updated config (e.g. remembered circle position, PLAN.md §3
    /// multi-monitor). Best-effort; logs on failure.
    public static func saveConfig(_ config: Config) {
        do { try writeConfig(config) } catch {
            NSLog("AndreysOrchestrator: failed to save config: \(error)")
        }
    }

    // MARK: - Writers

    private static func writeConfig(_ config: Config) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: configURL, options: .atomic)
    }

    private static func writeToken(_ token: String) throws {
        try token.write(to: tokenURL, atomically: true, encoding: .utf8)
        // Restrict to owner read/write (0600) — the broker rejects `hello`
        // without the matching token (PLAN.md §9.3).
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
    }

    /// A URL-safe random token (32 bytes of randomness, base64url, unpadded).
    /// `SystemRandomNumberGenerator` is cryptographically secure on Apple platforms.
    private static func randomToken() -> String {
        var rng = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: 0...255, using: &rng) }
        return Data(bytes)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
