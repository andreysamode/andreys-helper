// Minimal parser for the `ah schedule <spec>` verb (PLAN.md §6.3, §6.5).
//
// The CLI passes a free-text spec; the broker routes it here (via App wiring)
// to create/list/cancel jobs in the daemon. Supported forms:
//   • `list`                    → the current pending jobs
//   • `cancel <jobId>`          → remove a job
//   • `in <dur> <text…>`        → a one-shot time-triggered alert (dur: 30s/10m/1h/N=min)
//   • `every <dur> <text…>`     → an interval-triggered alert
// Anything else is reported as an error. Output is a JSON-shaped dictionary the
// CLI prints verbatim.

import Foundation

enum ScheduleSpec {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func handle(_ spec: String, daemon: Daemon) -> [String: Sendable] {
        var tokens = spec.split(separator: " ").map(String.init)
        guard let head = tokens.first?.lowercased() else {
            return ["ok": false, "error": "empty schedule spec"]
        }
        tokens.removeFirst()

        switch head {
        case "list":
            let jobs = daemon.jobsSnapshot().map { jobDict($0) }
            return ["ok": true, "jobs": jobs as [Sendable]]

        case "cancel":
            guard let id = tokens.first else { return ["ok": false, "error": "usage: cancel <jobId>"] }
            daemon.removeJob(id: id)
            return ["ok": true, "cancelled": id]

        case "in", "every":
            guard let durTok = tokens.first, let ms = parseDurationMs(durTok) else {
                return ["ok": false, "error": "usage: \(head) <dur> <text>  (dur like 30s/10m/1h)"]
            }
            let text = tokens.dropFirst().joined(separator: " ")
            let label = text.isEmpty ? "reminder" : text
            let id = UUID().uuidString
            let job: Job
            if head == "every" {
                job = Job(
                    id: id, kind: .static,
                    trigger: JobTrigger(type: .interval, everyMs: ms),
                    action: JobAction(type: .alert, text: label),
                    label: label,
                    nextFireAt: iso.string(from: Date().addingTimeInterval(Double(ms) / 1000)))
            } else {
                job = Job(
                    id: id, kind: .static,
                    trigger: JobTrigger(type: .time, at: iso.string(from: Date().addingTimeInterval(Double(ms) / 1000))),
                    action: JobAction(type: .alert, text: label),
                    label: label,
                    nextFireAt: iso.string(from: Date().addingTimeInterval(Double(ms) / 1000)))
            }
            daemon.addJob(job)
            return ["ok": true, "job": jobDict(job)]

        default:
            return ["ok": false, "error": "unrecognized schedule spec '\(spec)'"]
        }
    }

    private static func jobDict(_ j: Job) -> [String: Sendable] {
        [
            "id": j.id, "kind": j.kind.rawValue, "label": j.label,
            "nextFireAt": j.nextFireAt, "trigger": j.trigger.type.rawValue,
        ]
    }

    /// Parse `30s`, `10m`, `2h`, `1d`, or a bare number (minutes) into milliseconds.
    private static func parseDurationMs(_ s: String) -> Int? {
        let lower = s.lowercased()
        let unit = lower.last
        let numPart = (unit.map { "smhd".contains($0) } == true) ? String(lower.dropLast()) : lower
        guard let n = Double(numPart), n >= 0 else { return nil }
        switch unit {
        case "s": return Int(n * 1000)
        case "h": return Int(n * 3_600_000)
        case "d": return Int(n * 86_400_000)
        case "m": return Int(n * 60_000)
        default: return Int(n * 60_000)  // bare number → minutes
        }
    }
}
