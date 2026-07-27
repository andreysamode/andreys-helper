// Headless agentic job runner (PLAN.md §6.5, §8 W4).
//
// An agentic job runs `claude -p <instruction>` in a scratch cwd and its stdout
// becomes the result. The protocol is injectable so tests substitute a fake
// runner (no real `claude` process, deterministic output).

import Foundation

public protocol AgenticRunner {
    /// Run `instruction` headlessly in `cwd`; deliver captured stdout (or error).
    func run(
        instruction: String,
        cwd: String,
        completion: @escaping (Result<String, Error>) -> Void)
}

/// Production runner: shells out to `claude -p <instruction>` and captures stdout.
public final class ProcessAgenticRunner: AgenticRunner {
    private let claudePath: String
    private let queue = DispatchQueue(label: "orchestrator.daemon.agentic")

    public init(claudePath: String = "/usr/local/bin/claude") {
        self.claudePath = claudePath
    }

    public func run(
        instruction: String, cwd: String,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        queue.async {
            let fm = FileManager.default
            try? fm.createDirectory(atPath: cwd, withIntermediateDirectories: true)
            let process = Process()
            let claudeURL = URL(fileURLWithPath: self.claudePath)
            // Fall back to a PATH lookup via /usr/bin/env if the absolute path
            // is missing, so a Homebrew/npm-global install still resolves. That
            // lookup needs the user's PATH, not the one a GUI app inherits, hence
            // the resolved environment (see UserShell.swift).
            if fm.isExecutableFile(atPath: self.claudePath) {
                process.executableURL = claudeURL
                process.arguments = ["-p", instruction]
            } else {
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = ["claude", "-p", instruction]
            }
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
            process.environment = UserShell.withResolvedPath()
            let out = Pipe()
            process.standardOutput = out
            process.standardError = Pipe()
            do {
                try process.run()
                let data = out.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                let text = String(data: data, encoding: .utf8) ?? ""
                completion(.success(text.trimmingCharacters(in: .whitespacesAndNewlines)))
            } catch {
                completion(.failure(error))
            }
        }
    }
}
