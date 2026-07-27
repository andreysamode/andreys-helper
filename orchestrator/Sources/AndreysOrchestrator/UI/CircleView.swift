// The circle — composites three independent signals: rotating rim dashes (how
// many sessions are working, 1…5), a center "?" (something's asking) and/or "✓"
// (something finished-unseen) shown side by side with NO numbers, and an alert
// takeover ("!" + queue count, click-to-ack). idle → frosted disc + border only.

import SwiftUI

struct CircleView: View {
    @ObservedObject var model: AppModel
    /// On-screen footprint (~80% of the 56pt design size). The contents are
    /// authored at `designSize` and scaled down uniformly, so the disc, border,
    /// glyphs, and rim dashes all stay in proportion.
    static let size: CGFloat = 45
    /// Not private: the panes derive their shadow radius from `size / designSize`
    /// so an unscaled pane casts the same shadow the eye sees on the circle.
    static let designSize: CGFloat = 56

    private var state: CircleState { model.circleState }

    /// The center attention glyph(s), independent of the rim dashes:
    ///  • a "?" when any session is asking, a "✓" when any is finished-unseen —
    ///    shown SIDE BY SIDE (question left, check right) when both apply, with
    ///    NO numbers (presence is enough).
    ///  • an alert takes over with a red "!" + its queue count (click-to-ack).
    ///  • working/idle show nothing in the center — the rim conveys "working".
    @ViewBuilder private var centerGlyph: some View {
        if state.category == .alert {
            HStack(spacing: 2) {
                Text("!").font(.system(size: 22, weight: .bold))
                if state.alertCount > 0 {
                    Text("\(state.alertCount)").font(.system(size: 15, weight: .semibold))
                }
            }
            .foregroundColor(Theme.red)
        } else {
            HStack(spacing: 4) {
                if state.needsInputCount > 0 {
                    Text("?").font(.system(size: 21, weight: .bold)).foregroundColor(Theme.terracotta)
                }
                if state.doneUnseenCount > 0 {
                    CheckFat().fill(Theme.green).frame(width: 18, height: 18)
                }
            }
        }
    }

    var body: some View {
        ZStack {
            // Always-frosted disc (identical whether or not the panel is focused).
            Circle()
                .fill(Color.clear)
                .background(FrostedBackground().clipShape(Circle()))
                .shadow(radius: 3)

            // Thin white border around the circumference (always present).
            Circle().inset(by: 0.5).stroke(Color.white.opacity(0.85), lineWidth: 1)

            // Rotating white dashes = number of sessions still working (1…5),
            // shown WHENEVER anything works — even while the center glyph is a
            // "?"/"✓". Inset ~1px inside the border (a thin gap of the disc).
            if state.workingCount > 0 {
                WorkingDashes(count: state.workingCount).padding(3)
            }

            centerGlyph
        }
        .frame(width: Self.designSize, height: Self.designSize)
        .scaleEffect(Self.size / Self.designSize)
        .frame(width: Self.size, height: Self.size)
        .contentShape(Circle())
        // NB: hover is decided from the pointer's position in PanelController,
        // not tracked here — tracking it on the circle caused an expand/collapse
        // feedback loop as the window resized out from under the cursor.
        //
        // A click only acks alerts. It deliberately does NOT latch the session
        // pane open: that latch (the old `pinned` flag) was invisible and a stray
        // click on the way to a session row left the pane stuck open with no way
        // to tell why — the pane is hover-driven, and moving the pointer off it
        // must always close it.
        .onTapGesture {
            if state.category == .alert {
                model.toggleAlertBubble()
            }
        }
        // Right-click → open Settings / Quit (PLAN.md Phase 3, item 6).
        .contextMenu {
            Button("Settings…") { model.openSettings() }
            Divider()
            Button("Quit AndreysOrchestrator") { model.quit() }
        }
        // Drag-to-move is handled by the hosting NSView (whole-window drag).
    }
}

/// The working indicator: `count` rounded white dashes equidistant around the
/// rim, each ~1/5 of the circumference (with a gap between), all rotating
/// clockwise together. `count` = sessions still working, rendered 1…5 (capped).
/// One dash for one, two on opposite sides, three/four/five equidistant.
private struct WorkingDashes: View {
    let count: Int
    var lineWidth: CGFloat = 3
    /// Arc length per dash — a touch under 1/5 so there's always a visible gap.
    var dashFraction: CGFloat = 0.17
    @State private var spin = false

    private var n: Int { min(max(count, 1), 5) }

    var body: some View {
        ZStack {
            ForEach(0..<n, id: \.self) { i in
                Circle()
                    .trim(from: 0, to: dashFraction)
                    .stroke(Color.white, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(Double(i) * 360.0 / Double(n)))
            }
        }
        // Positive degrees rotate clockwise in SwiftUI's coordinate space.
        .rotationEffect(.degrees(spin ? 360 : 0))
        .animation(.linear(duration: 1.4).repeatForever(autoreverses: false), value: spin)
        .onAppear { spin = true }
    }
}

/// The fired-alert bubble anchored to the circle; each row is click-to-ack (§4).
struct AlertBubble: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Alerts").font(.caption).foregroundColor(.secondary)
            ForEach(model.alerts) { alert in
                Button {
                    model.ackAlert(alert.id)
                } label: {
                    HStack {
                        Text(alert.text).lineLimit(2).font(.system(size: 12))
                        Spacer()
                        Image(systemName: "xmark.circle.fill").foregroundColor(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }
            if model.alerts.isEmpty {
                Text("No alerts").font(.system(size: 12)).foregroundColor(.secondary)
            }
        }
        .padding(10)
        .frame(width: 240, alignment: .leading)
        .background(FrostedBackground().clipShape(RoundedRectangle(cornerRadius: 10)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.4), lineWidth: 1))
    }
}
