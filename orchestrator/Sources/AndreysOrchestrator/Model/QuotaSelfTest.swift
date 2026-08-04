// Headless check of the usage-quota path (`--selftest-quota`).
//
// Two halves:
//   • parser — asserted against a captured `get_usage` control response, so it
//     passes with no CLI, no network, and no subscription.
//   • live probe — run for real and reported, but NOT asserted: a machine with
//     no `claude` on PATH or an API-key install has no plan limits to show.

import Foundation

enum QuotaSelfTest {
    static func run() -> Bool {
        var ok = true

        func check(_ label: String, _ condition: Bool) {
            print("  \(condition ? "ok  " : "FAIL") \(label)")
            if !condition { ok = false }
        }

        // A real response, trimmed to the fields the parser reads.
        let sample = #"""
        {"type":"control_response","response":{"subtype":"success","request_id":"quota-1","response":{
        "subscription_type":"team","rate_limits_available":true,"rate_limits":{
        "limits":[
        {"kind":"session","group":"session","percent":38,"resets_at":"2026-07-27T15:10:00.963405+00:00","scope":null},
        {"kind":"weekly_all","group":"weekly","percent":28.4,"resets_at":"2026-07-31T15:00:00.963426+00:00","scope":null},
        {"kind":"weekly_scoped","group":"weekly","percent":0,"resets_at":null,"scope":{"model":{"id":null,"display_name":"Fable"}}},
        {"kind":"some_future_window","group":"weekly","percent":99,"resets_at":null,"scope":null}
        ]}}}}
        """#

        guard case .ok(let snapshot)? = QuotaProbe.parse(Data(sample.utf8)) else {
            print("  FAIL parse produced no snapshot")
            return false
        }
        check("three bars (unknown kind ignored)", snapshot.bars.count == 3)
        check("labels are cur/all/fab", snapshot.bars.map(\.label) == ["cur", "all", "fab"])
        check("percent rounds (28.4 → 28)", snapshot.bars.map(\.percent) == [38, 28, 0])
        check("scoped title names the model",
              snapshot.bars[2].title == "Current week (Fable only)")
        check("fractional-second reset parses", snapshot.bars[0].resetsAt != nil)
        check("null reset stays nil", snapshot.bars[2].resetsAt == nil)

        // Not-a-subscriber payload must be terminal, not an error to retry.
        let unavailable = #"{"type":"control_response","response":{"subtype":"success","response":{"rate_limits_available":false,"rate_limits":null}}}"#
        if case .notApplicable? = QuotaProbe.parse(Data(unavailable.utf8)) {
            check("rate_limits_available:false → notApplicable", true)
        } else {
            check("rate_limits_available:false → notApplicable", false)
        }

        // …but a success response that merely carried nothing must stay RETRYABLE.
        // Calling these `.notApplicable` is what let one hiccup disable the monitor
        // for the rest of the app's life, freezing the bars on a stale percent.
        func isFailure(_ json: String) -> Bool {
            if case .failed? = QuotaProbe.parse(Data(json.utf8)) { return true }
            return false
        }
        check("available:true but no limits → retryable failure",
              isFailure(#"{"type":"control_response","response":{"subtype":"success","response":{"rate_limits_available":true,"rate_limits":{}}}}"#))
        check("empty limits array → retryable failure",
              isFailure(#"{"type":"control_response","response":{"subtype":"success","response":{"rate_limits_available":true,"rate_limits":{"limits":[]}}}}"#))
        check("only unrecognized windows → retryable failure",
              isFailure(#"{"type":"control_response","response":{"subtype":"success","response":{"rate_limits":{"limits":[{"kind":"mystery","percent":5}]}}}}"#))

        // Non-control lines (login-shell noise, stream events) are skipped.
        check("stream events are not control responses",
              QuotaProbe.parse(Data(#"{"type":"system","subtype":"init"}"#.utf8)) == nil)
        check("garbage is skipped", QuotaProbe.parse(Data("Last login: Mon".utf8)) == nil)

        // The monitor's disable policy, driven through the `fetch` seam so it needs
        // no CLI. `isDisabled` does a `queue.sync`, which also barriers the async
        // probes queued ahead of it.
        func drive(_ outcomes: [QuotaProbe.Outcome]) -> Bool {
            let monitor = QuotaMonitor(interval: 3600) // never fires on its own
            var next = 0
            monitor.fetch = {
                defer { next += 1 }
                return next < outcomes.count ? outcomes[next] : .failed("exhausted")
            }
            for _ in outcomes { monitor.refreshIfStale(0) }
            return monitor.isDisabled
        }

        let sampleSnapshot = QuotaSnapshot(bars: [
            QuotaBar(id: "session", label: "cur", title: "Current session",
                     percent: 77, resetsAt: nil)
        ])
        check("one notApplicable does NOT disable polling",
              drive([.notApplicable]) == false)
        check("two notApplicable does NOT disable polling",
              drive([.notApplicable, .notApplicable]) == false)
        check("three consecutive notApplicable disables polling",
              drive([.notApplicable, .notApplicable, .notApplicable]) == true)
        check("a good snapshot clears the streak",
              drive([.notApplicable, .notApplicable, .ok(sampleSnapshot),
                     .notApplicable, .notApplicable]) == false)
        check("a failure clears the streak",
              drive([.notApplicable, .notApplicable, .failed("blip"),
                     .notApplicable, .notApplicable]) == false)

        // Live probe — informational.
        print("  --- live probe (informational) ---")
        let started = Date()
        switch QuotaProbe.fetchSync() {
        case .ok(let live):
            let took = String(format: "%.1fs", Date().timeIntervalSince(started))
            print("  live: \(took) — " + live.bars.map { "\($0.label): \($0.percent)%" }.joined(separator: "  "))
            for bar in live.bars {
                print("        \(bar.title) — resets \(bar.resetsAt.map(String.init(describing:)) ?? "n/a")")
            }
        case .notApplicable:
            print("  live: no plan limits apply on this machine (skipped)")
        case .failed(let reason):
            print("  live: probe failed — \(reason)")
        }

        return ok
    }
}

extension QuotaProbe.Outcome: Equatable {
    static func == (lhs: QuotaProbe.Outcome, rhs: QuotaProbe.Outcome) -> Bool {
        switch (lhs, rhs) {
        case (.ok(let a), .ok(let b)): return a == b
        case (.notApplicable, .notApplicable): return true
        case (.failed(let a), .failed(let b)): return a == b
        default: return false
        }
    }
}
