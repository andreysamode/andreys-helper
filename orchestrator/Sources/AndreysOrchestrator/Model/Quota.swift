// Plan usage quotas — the header bars (`cur` / `all` / `fab`).
//
// Source of truth is Claude Code's own `/usage` data. There is no local cache of
// it on disk (the CLI fetches `/api/oauth/usage` live), and hitting that endpoint
// ourselves would mean reading the OAuth token out of the Keychain and owning
// refresh — so instead we ask the CLI, through its SDK control channel:
//
//   claude -p --input-format stream-json --output-format stream-json --verbose
//   ← {"type":"control_request","request":{"subtype":"get_usage"}}
//   → {"type":"control_response", …, "rate_limits":{ …, "limits":[ … ]}}
//
// This is a control request, NOT a turn: no model call, no cost, and no
// transcript is written (the session ends before it has any messages). It costs
// ~1.4s of process startup, so the monitor polls on a slow timer and opportunistically
// on pane-open rather than continuously.
//
// The `limits` array is what the /usage dialog renders, one entry per window:
//   {kind:"session",       percent:38, resets_at:"…", scope:null}
//   {kind:"weekly_all",    percent:28, resets_at:"…", scope:null}
//   {kind:"weekly_scoped", percent:0,  resets_at:null, scope:{model:{display_name:"Fable"}}}
// The scoped window's model is whatever the plan meters separately, so its label
// is derived from the response rather than hardcoded ("Fable" → `fab`).

import Foundation

/// One usage window, ready to render as a header bar.
public struct QuotaBar: Identifiable, Equatable {
    /// Stable per window so SwiftUI keeps bar identity across refreshes.
    public let id: String
    /// Three-letter bar caption (`cur`, `all`, `fab`).
    public let label: String
    /// Full name for the hover tooltip ("Current session").
    public let title: String
    /// Percent of the window consumed, clamped to 0…100.
    public let percent: Int
    /// When this window rolls over; nil when the window hasn't started.
    public let resetsAt: Date?
}

public struct QuotaSnapshot: Equatable {
    public let bars: [QuotaBar]
    public let fetchedAt: Date

    public init(bars: [QuotaBar], fetchedAt: Date = Date()) {
        self.bars = bars
        self.fetchedAt = fetchedAt
    }
}

/// One-shot probe of the CLI's `get_usage` control request.
enum QuotaProbe {
    enum Outcome {
        case ok(QuotaSnapshot)
        /// Plan limits don't apply to this install (API key, Bedrock/Vertex, or a
        /// token without the profile scope) — polling should stop, not retry.
        case notApplicable
        case failed(String)
    }

    /// Neutral working directory, so the probe never runs inside one of the
    /// user's repos (where a stray `CLAUDE.md`/settings could change its startup).
    private static var probeDir: String {
        (("~/.andreys-helper/quota-probe") as NSString).expandingTildeInPath
    }

    /// Runs the probe on a background queue and calls back on `queue`.
    /// Blocking work only happens on the caller-supplied worker queue.
    static func fetch(
        timeout: TimeInterval = 25,
        on queue: DispatchQueue = .global(qos: .utility),
        completion: @escaping (Outcome) -> Void
    ) {
        queue.async { completion(fetchSync(timeout: timeout)) }
    }

    static func fetchSync(timeout: TimeInterval = 25) -> Outcome {
        try? FileManager.default.createDirectory(
            atPath: probeDir, withIntermediateDirectories: true)

        // Launched through a login shell for the same reason the orchestrator is,
        // and with the same resolved PATH (a GUI app's inherited PATH has no
        // Homebrew/npm/nvm in it, and a non-interactive `zsh -lc` does not rebuild
        // one — see UserShell.swift); a missing binary exits 127 rather than
        // throwing. `--strict-mcp-config` with an empty config keeps the user's
        // MCP servers out of a probe that never runs a turn.
        let script = """
        command -v claude >/dev/null 2>&1 || exit 127
        exec claude -p --input-format stream-json --output-format stream-json \
        --verbose --strict-mcp-config --mcp-config '{"mcpServers":{}}'
        """

        let process = Process()
        process.executableURL = URL(fileURLWithPath: UserShell.shellPath)
        process.arguments = ["-lc", script]
        process.currentDirectoryURL = URL(fileURLWithPath: probeDir)
        process.environment = UserShell.withResolvedPath()

        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        // Drained asynchronously and capped: an undrained stderr pipe can fill and
        // wedge the child, and we only ever want the head of it for diagnostics.
        let errLock = NSLock()
        var errText = ""
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            errLock.lock()
            if errText.count < 2000 { errText += s }
            errLock.unlock()
        }

        do { try process.run() } catch {
            return .failed("spawn failed: \(error)")
        }

        // Watchdog: the child is killed on timeout, which EOFs stdout and unblocks
        // the read loop below.
        let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: watchdog)

        let request = #"{"type":"control_request","request_id":"quota-1","request":{"subtype":"get_usage"}}"# + "\n"
        stdin.fileHandleForWriting.write(Data(request.utf8))
        // stdin stays OPEN: closing it ends the session, and the CLI may exit
        // before answering the control request.

        var outcome: Outcome = .failed("no control_response")
        var buffer = Data()
        let reader = stdout.fileHandleForReading
        readLoop: while true {
            let chunk = reader.availableData
            if chunk.isEmpty { break } // EOF — process exited or was killed
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[buffer.startIndex..<newline])
                buffer.removeSubrange(buffer.startIndex...newline)
                // Login-shell noise and the CLI's own stream events are skipped;
                // only the control_response parses.
                if let parsed = parse(line) {
                    outcome = parsed
                    break readLoop
                }
            }
        }

        watchdog.cancel()
        stderr.fileHandleForReading.readabilityHandler = nil
        if process.isRunning { process.terminate() }
        process.waitUntilExit()

        if case .failed(let reason) = outcome {
            errLock.lock(); let err = errText.trimmingCharacters(in: .whitespacesAndNewlines); errLock.unlock()
            let detail = process.terminationStatus == 127 ? "claude CLI not on PATH" : err
            return .failed(detail.isEmpty ? reason : "\(reason): \(detail)")
        }
        return outcome
    }

    // MARK: Parsing

    /// Decodes one stdout line; nil when it isn't the control response we asked for.
    /// Dictionary access rather than `Codable`: the payload is large, mostly
    /// irrelevant to us, and its shape is documented as experimental.
    /// Internal (not private) so `QuotaSelfTest` can exercise it without a CLI.
    static func parse(_ line: Data) -> Outcome? {
        guard let root = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            root["type"] as? String == "control_response",
            let response = root["response"] as? [String: Any]
        else { return nil }

        if response["subtype"] as? String == "error" {
            return .failed((response["error"] as? String) ?? "control request failed")
        }
        guard let payload = response["response"] as? [String: Any] else { return nil }

        if let available = payload["rate_limits_available"] as? Bool, !available {
            return .notApplicable
        }
        guard let rateLimits = payload["rate_limits"] as? [String: Any],
            let limits = rateLimits["limits"] as? [[String: Any]]
        else { return .notApplicable }

        let bars = limits.compactMap(bar(from:))
        return bars.isEmpty ? .notApplicable : .ok(QuotaSnapshot(bars: bars))
    }

    private static func bar(from limit: [String: Any]) -> QuotaBar? {
        guard let kind = limit["kind"] as? String else { return nil }
        let raw = (limit["percent"] as? NSNumber)?.doubleValue ?? 0
        let percent = Int(max(0, min(100, raw)).rounded())
        let resetsAt = (limit["resets_at"] as? String).flatMap(parseISO)

        switch kind {
        case "session":
            return QuotaBar(
                id: kind, label: "cur", title: "Current session",
                percent: percent, resetsAt: resetsAt)
        case "weekly_all":
            return QuotaBar(
                id: kind, label: "all", title: "Current week (all models)",
                percent: percent, resetsAt: resetsAt)
        case "weekly_scoped":
            // Metered separately for one model; the plan decides which one.
            let scope = limit["scope"] as? [String: Any]
            let model = (scope?["model"] as? [String: Any])?["display_name"] as? String
            guard let model, !model.isEmpty else { return nil }
            return QuotaBar(
                id: "\(kind):\(model)", label: abbreviate(model),
                title: "Current week (\(model) only)",
                percent: percent, resetsAt: resetsAt)
        default:
            return nil // unknown window kinds are ignored, not guessed at
        }
    }

    /// "Fable" → "fab", "Sonnet" → "son" — a fixed-width caption so every bar in
    /// the row is the same size.
    private static func abbreviate(_ model: String) -> String {
        String(model.lowercased().prefix(3))
    }

    /// The endpoint sends 6-digit fractional seconds ("…:00.963405+00:00"), which
    /// `ISO8601DateFormatter` rejects in either of its stock configurations, so
    /// fall back to parsing with the fraction stripped.
    private static func parseISO(_ s: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: s) { return d }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let d = plain.date(from: s) { return d }

        guard let dot = s.firstIndex(of: "."),
            let zone = s[dot...].firstIndex(where: { $0 == "+" || $0 == "-" || $0 == "Z" })
        else { return nil }
        return plain.date(from: String(s[s.startIndex..<dot]) + String(s[zone...]))
    }
}

/// Polls `QuotaProbe` and publishes snapshots. Slow timer by default; the shell
/// asks for an opportunistic refresh when a pane opens, which is rate-limited by
/// snapshot age so hovering repeatedly can't spawn a probe per hover.
final class QuotaMonitor {
    /// Called on the main queue whenever a fresh snapshot lands.
    var onSnapshot: ((QuotaSnapshot) -> Void)?

    private let interval: TimeInterval
    private let queue = DispatchQueue(label: "quota-monitor", qos: .utility)
    private var timer: DispatchSourceTimer?
    /// All mutable state below is touched only on `queue`.
    private var inFlight = false
    private var lastFetch: Date?
    /// Set once the install turns out to have no plan limits; stops all polling.
    private var disabled = false

    init(interval: TimeInterval = 300) {
        self.interval = interval
    }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: interval)
        timer.setEventHandler { [weak self] in self?.probe() }
        self.timer = timer
        timer.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    /// Refresh only if the newest snapshot is older than `maxAge`.
    func refreshIfStale(_ maxAge: TimeInterval) {
        queue.async { [weak self] in
            guard let self, !self.disabled, !self.inFlight else { return }
            if let last = self.lastFetch, Date().timeIntervalSince(last) < maxAge { return }
            self.probe()
        }
    }

    /// Must be called on `queue`.
    private func probe() {
        guard !disabled, !inFlight else { return }
        inFlight = true
        let outcome = QuotaProbe.fetchSync()
        inFlight = false
        lastFetch = Date()
        switch outcome {
        case .ok(let snapshot):
            DispatchQueue.main.async { [weak self] in self?.onSnapshot?(snapshot) }
        case .notApplicable:
            disabled = true
            stop()
            NSLog("AndreysOrchestrator: plan usage limits unavailable — quota bars disabled")
        case .failed(let reason):
            NSLog("AndreysOrchestrator: quota probe failed: \(reason)")
        }
    }
}
