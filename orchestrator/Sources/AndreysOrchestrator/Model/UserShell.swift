// The user's real shell environment, resolved once per app run.
//
// Everything the AndreysOrchestrator spawns — the orchestrator's `claude` tabs (W5), the
// quota probe, the headless agentic runner — needs `claude` (and the toolchain
// it shells out to) on PATH. Two things conspire to hide the user's PATH:
//
//  1. A GUI app inherits launchd's minimal PATH (roughly
//     `/usr/bin:/bin:/usr/sbin:/sbin`), not the one the user's terminal has. And
//     SwiftTerm's default child environment omits PATH altogether
//     (`Terminal.getEnvironmentVariables` has it commented out), so a PTY child
//     starts with whatever its shell invents.
//
//  2. A *login* shell is not enough to rebuild it. `zsh -lc` reads `.zshenv`,
//     `.zprofile` and `.zlogin` but never `.zshrc` — and `.zshrc` is where a
//     typical zsh setup puts Homebrew, nvm, mise and pyenv on PATH. So
//     `command -v claude` fails under `zsh -lc` even though the identical lookup
//     succeeds in every terminal window the user has ever opened. (bash is the
//     lucky case: `bash -lc` does read `.bash_profile`.)
//
// So we ask the user's own shell — interactive *and* login (`-ilc`) — to print
// its PATH once, cache it, and hand it to everything we spawn.

import Foundation

enum UserShell {
    /// The user's shell. macOS has defaulted to zsh since Catalina.
    static let shellPath: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"

    /// How long the probe may take before we fall back to a guessed PATH. An rc
    /// file that runs mise/pyenv/nvm/mcfly init needs a moment; one that blocks
    /// forever must not wedge the app.
    static let probeTimeout: TimeInterval = 8

    /// PATH as the user's terminal sees it. Blocks on the first access until the
    /// probe finishes (bounded by `probeTimeout`); cached from then on. Call
    /// `prewarm()` at startup so the first real caller never waits.
    static var path: String { resolution.path }

    /// False when the probe failed or timed out and `path` is the guessed
    /// fallback — useful for diagnostics, not for control flow.
    static var probeSucceeded: Bool { resolution.probed }

    /// Resolve the PATH in the background so the UI never blocks on it.
    static func prewarm() {
        DispatchQueue.global(qos: .userInitiated).async { _ = resolution }
    }

    /// Absolute path of `name` as the user's shell would resolve it, or nil.
    static func resolve(_ name: String) -> String? {
        let fm = FileManager.default
        for dir in path.split(separator: ":", omittingEmptySubsequences: true) {
            let candidate = (String(dir) as NSString).appendingPathComponent(name)
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Environment for a PTY child, in SwiftTerm's `KEY=value` array form:
    /// terminal identity, the user's PATH, and the handful of identity variables
    /// SwiftTerm itself forwards.
    ///
    /// Deliberately a whitelist rather than the app's whole environment: when the
    /// AndreysOrchestrator is launched from a terminal that is itself inside a `claude`
    /// session, the inherited environment carries that session's variables
    /// (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, …) and passing them down would
    /// make a fresh orchestrator tab look like a nested one.
    static func terminalEnvironment(term: String = "xterm-256color") -> [String] {
        let inherited = ProcessInfo.processInfo.environment
        var env = [
            "TERM=\(term)",
            "COLORTERM=truecolor",
            // Without a UTF-8 locale, TUIs emit sequences that are not UTF-8 safe.
            "LANG=\(inherited["LANG"] ?? "en_US.UTF-8")",
            "PATH=\(path)",
            "SHELL=\(shellPath)",
        ]
        for key in ["LOGNAME", "USER", "HOME", "TMPDIR", "LC_ALL", "LC_CTYPE",
                    "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"] {
            if let value = inherited[key] { env.append("\(key)=\(value)") }
        }
        return env
    }

    /// `base` (the app's own environment by default) with the resolved PATH
    /// overlaid — for `Process`-based spawns, which already inherit everything
    /// else they need.
    static func withResolvedPath(
        _ base: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String: String] {
        var env = base
        env["PATH"] = path
        return env
    }

    // MARK: Probe

    private struct Resolution {
        let path: String
        let probed: Bool
    }

    private static let lock = NSLock()
    private static var cached: Resolution?

    private static var resolution: Resolution {
        // The lock is held across the probe on purpose: concurrent first callers
        // wait for the one probe instead of each spawning their own shell.
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        let result = probe() ?? Resolution(path: fallbackPath(), probed: false)
        cached = result
        return result
    }

    private static let marker = "__AH_PATH__"

    private static func probe() -> Resolution? {
        // An interactive shell also writes a prompt and any shell-integration
        // escapes, so the value is fenced by markers rather than assumed to be
        // the whole of stdout.
        let script = "printf '%s%s%s\\n' '\(marker)' \"$PATH\" '\(marker)'"
        guard let output = capture(shellPath, ["-ilc", script]),
            let value = fencedValue(in: output),
            !value.isEmpty
        else {
            NSLog("AndreysOrchestrator: PATH probe via \(shellPath) -ilc failed; using fallback PATH")
            return nil
        }
        return Resolution(path: value, probed: true)
    }

    private static func fencedValue(in output: String) -> String? {
        guard let start = output.range(of: marker),
            let end = output.range(of: marker, range: start.upperBound..<output.endIndex)
        else { return nil }
        return String(output[start.upperBound..<end.lowerBound])
    }

    private static func capture(_ executable: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let out = Pipe()
        process.standardOutput = out
        // stderr is noise here (prompts, "no job control in this shell", rc-file
        // warnings) and an interactive shell must never read our stdin.
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch {
            NSLog("AndreysOrchestrator: PATH probe could not spawn \(executable): \(error)")
            return nil
        }
        let watchdog = DispatchWorkItem {
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(
            deadline: .now() + probeTimeout, execute: watchdog)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        watchdog.cancel()
        return String(data: data, encoding: .utf8)
    }

    /// Best-effort PATH when the probe fails: the inherited PATH, prefixed with
    /// the install locations `claude` and its toolchain actually live in.
    private static func fallbackPath() -> String {
        let home = NSHomeDirectory()
        let likely = [
            "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
            "\(home)/.local/bin", "\(home)/.claude/local", "\(home)/.npm/bin",
            "\(home)/.bun/bin",
        ]
        let inherited = ProcessInfo.processInfo.environment["PATH"]
            ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let fm = FileManager.default
        var seen = Set<String>()
        var dirs: [String] = []
        for dir in likely.filter({ fm.fileExists(atPath: $0) })
            + inherited.split(separator: ":").map(String.init)
        where !dir.isEmpty && seen.insert(dir).inserted {
            dirs.append(dir)
        }
        return dirs.joined(separator: ":")
    }
}
