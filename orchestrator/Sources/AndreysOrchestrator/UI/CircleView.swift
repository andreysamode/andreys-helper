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
                    OutlinedGlyph(string: "?",
                                  size: 21,
                                  color: Theme.terracotta,
                                  outline: Self.glyphOutlineColor,
                                  outlineWidth: Self.glyphOutline)
                }
                if state.doneUnseenCount > 0 {
                    // Outline BEHIND the fill so the green stays exactly the
                    // `Theme.green` a session row draws — see `OutlinedGlyph`.
                    CheckFat()
                        .fill(Theme.green)
                        .background(CheckFat().stroke(Self.glyphOutlineColor,
                                                      lineWidth: Self.glyphOutline))
                        .frame(width: 18, height: 18)
                }
            }
        }
    }

    /// Hairline outline on the "✓"/"?" so they stay legible against whatever the
    /// frosted disc happens to be sitting on. Authored in the 56pt design space
    /// like everything else in this view. The stroke sits behind the glyph, so
    /// only its outer half shows: ~0.2pt of edge once scaled to the on-screen
    /// 45pt, i.e. a half-pixel line on a Retina display. Deliberately delicate —
    /// at 1.0 the white read as a border rather than an edge.
    private static let glyphOutline: CGFloat = 0.5

    /// Half-strength white — i.e. sitting midway between white and whatever the
    /// disc's frost resolves to, so the outline separates the glyph from the
    /// backdrop without announcing itself.
    ///
    /// Translucent white rather than a literal mid-gray on purpose: the disc is
    /// `.behindWindow` vibrancy, so there is no fixed background color to split
    /// the difference with — it's whatever is behind the panel, blurred. Letting
    /// the backdrop supply the other half is the only version that holds up as
    /// the HUD moves over light and dark windows, and it's what the rim border
    /// above already does (`white.opacity(0.85)`).
    private static let glyphOutlineColor = Color.white.opacity(0.5)

    /// The design-size → on-screen factor everything below is authored against.
    private static var scale: CGFloat { size / designSize }

    var body: some View {
        ZStack {
            // Always-frosted disc (identical whether or not the panel is focused).
            //
            // Deliberately authored at the FINAL on-screen size and kept OUTSIDE
            // the `scaleEffect` below, unlike everything else here. It is a
            // `.behindWindow` vibrancy view, and its material is composited by the
            // window server from a backdrop region — a scale transform on an
            // ancestor layer is one more thing that region has to be re-derived
            // from every time the panel resizes, which is how the disc came to
            // flash as an unclipped 56pt square on hover. Nothing above it
            // transforms or clips it now: it cuts its own circle (`Cut.circle`)
            // and is already the right size. See `FrostView`.
            //
            // Same circle either way — a 56pt disc scaled by 45/56 is a 45pt disc
            // — so the shadow just bakes in the factor the scale used to apply.
            Circle()
                .fill(Color.clear)
                .background(FrostedBackground(cut: .circle))
                .frame(width: Self.size, height: Self.size)
                // The frost cuts its own circle; this clip is what gives the
                // SHADOW its round silhouette (SwiftUI takes the shadow from the
                // clipped alpha). Same shape, so the two can't disagree.
                .clipShape(Circle())
                .shadow(radius: 3 * Self.scale)

            ZStack {
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
            .scaleEffect(Self.scale)
        }
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
    /// The tightest gap is at n = 5: (1/5 - dashFraction) of the circumference.
    /// The rim path is a 50pt circle (56pt design size less `padding(3)`), so one
    /// unit of fraction is ~157pt of arc, scaled on screen by 45/56 — i.e. 2
    /// on-screen points of extra gap costs 0.016 of the fraction.
    var dashFraction: CGFloat = 0.154
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
        .background(FrostedBackground(cut: .rounded(10)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.4), lineWidth: 1))
    }
}
