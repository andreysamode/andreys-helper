// Plan-usage bars for the session pane header: one equal-width bar per usage
// window, filling left-to-right in Claude terracotta as the window is consumed.
// Hovering a bar reveals which window it is and when it next resets.
//
// The reveal is drawn by us rather than left to `.help()`: AppKit only shows
// tooltips while the application is ACTIVE, and this panel is a non-activating
// accessory that deliberately never activates (App.swift), so a `.help()` string
// would essentially never appear. `.help()` is kept alongside as a no-cost
// fallback for the one case where the app IS active (the orchestrator stage).

import SwiftUI

struct QuotaBarsView: View {
    let snapshot: QuotaSnapshot?

    /// Fixed so the header never changes height between "loading" and loaded.
    static let height: CGFloat = 13

    /// The bar under the pointer, if any. Held here rather than per-bar so the
    /// reveal can span the full pane width instead of one narrow bar.
    @State private var hovered: QuotaBar?

    var body: some View {
        HStack(spacing: 5) {
            if let bars = snapshot?.bars, !bars.isEmpty {
                ForEach(bars) { bar in
                    QuotaBarView(bar: bar) { inside in
                        // Moving between adjacent bars can deliver B's enter
                        // before A's exit, so an exit only clears the state when
                        // it belongs to the bar still showing.
                        if inside {
                            hovered = bar
                        } else if hovered?.id == bar.id {
                            hovered = nil
                        }
                    }
                }
            } else {
                // No snapshot yet (first probe takes a moment) or none applies.
                Text("usage …")
                    .font(.system(size: 8))
                    .foregroundColor(.secondary)
                Spacer(minLength: 0)
            }
        }
        .frame(height: Self.height)
        // Floats over the pane below instead of being inserted into the column,
        // so revealing it never moves the header or the session list.
        .overlay(alignment: .topLeading) {
            if let hovered {
                ResetCallout(bar: hovered)
                    .offset(y: Self.height + 4)
                    .allowsHitTesting(false) // must not steal the hover it reports
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: hovered)
    }
}

/// The hover reveal: which window the bar is, and when it rolls over.
private struct ResetCallout: View {
    let bar: QuotaBar

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(bar.title)
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(.primary)
            Text(resetLine)
                .font(.system(size: 9))
                .foregroundColor(.secondary)
        }
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(Theme.boxActiveFill)
                .shadow(color: .black.opacity(0.18), radius: 4, y: 2))
        .overlay(
            RoundedRectangle(cornerRadius: 5)
                .stroke(Theme.terracotta.opacity(0.45), lineWidth: 1))
    }

    /// "resets Mon Jul 27, 11:10 AM · in 2h 58m", or why there's no reset yet.
    private var resetLine: String {
        guard let resets = bar.resetsAt else {
            // A scoped window has no reset time until it is first used.
            return "\(bar.percent)% used · window not started"
        }
        var line = "resets \(Self.resetFormatter.string(from: resets))"
        if let countdown = Self.countdown(to: resets) { line += " · \(countdown)" }
        return line
    }

    private static let resetFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE MMM d, h:mm a" // local time — the user's own clock
        return f
    }()

    private static func countdown(to date: Date) -> String? {
        let secs = Int(date.timeIntervalSinceNow)
        guard secs > 0 else { return nil }
        if secs < 3600 { return "in \(secs / 60)m" }
        let hours = secs / 3600, minutes = (secs % 3600) / 60
        if hours < 24 { return "in \(hours)h \(minutes)m" }
        return "in \(hours / 24)d \(hours % 24)h"
    }
}

private struct QuotaBarView: View {
    let bar: QuotaBar
    let onHoverChange: (Bool) -> Void

    private var fraction: CGFloat { CGFloat(bar.percent) / 100 }

    var body: some View {
        ZStack {
            Rectangle().fill(Theme.boxFill)
            // Left-anchored consumed portion. A bare Color is fully flexible, so
            // fixing its width leaves it spanning the bar's height.
            GeometryReader { geo in
                Theme.terracotta.opacity(0.85)
                    .frame(width: max(0, geo.size.width * fraction))
            }
            Text("\(bar.label): \(bar.percent)%")
                .font(.system(size: 8, weight: .medium))
                .foregroundColor(.primary.opacity(0.85))
                .lineLimit(1)
                .fixedSize()
        }
        .frame(maxWidth: .infinity)
        .frame(height: QuotaBarsView.height)
        // Clip before stroking so the fill stays inside the rounded ends and the
        // 1px outline isn't clipped away with it.
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .overlay(RoundedRectangle(cornerRadius: 3).stroke(Theme.boxBorder, lineWidth: 1))
        // The shape only paints where it's filled; make the whole rect hoverable.
        .contentShape(Rectangle())
        .onHover(perform: onHoverChange)
        .help(helpText)
    }

    private var helpText: String {
        "\(bar.title) · \(bar.percent)% used"
    }
}
