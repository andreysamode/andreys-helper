// The circle — composites three independent signals: rotating rim dashes (how
// many sessions are working, 1…5), a center "?" (something's asking) and/or "✓"
// (something finished-unseen) shown side by side with NO numbers, and an alert
// takeover ("!" + queue count, click-to-ack). idle → frosted disc + border only.
//
// MOON MODE (`AppModel.moonMode`, from the extension setting
// `andreysHelper.orchestrator.moonMode`) re-skins exactly three things and
// nothing else: the frosted disc becomes the painted moon, the rotating rim
// dashes become rotating rim stars, and the glyph outline flips from half-white
// to half-black so the "?"/"✓" still read against a bright yellow surface. All
// the signals, their meanings, and their geometry are unchanged.

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
    /// Moon mode only: clicking the moon blows it up to ten times its parked
    /// diameter and clicking again puts it back (`AppModel.moonZoomed`).
    static let zoomedSize: CGFloat = size * 10

    /// Design-space radius the drawn content actually reaches. The disc is 28 (a
    /// 56pt design box); the moon-mode stars are centred ON the rim, so their
    /// outer tips reach past it and this is what the hosting window must make
    /// room for — see `box(for:)`.
    ///
    /// The stars set it: `WorkingStars.radius` 25, plus the widest a 14pt star
    /// reaches across its line of travel — 6.7, since it flies tip-first and so
    /// presents its side points, not a tip — is ~31.7. Their trails curve along
    /// the orbit and stay well inside that (~29.0 at the outermost streak, which
    /// is held inside the star's own rear points by design).
    ///
    /// 33 leaves a point of deliberate margin. Keep it: the parked circle would
    /// hide an overrun in the window's 8pt shadow margin, but the ZOOMED moon is
    /// sized straight off this number, where one design point is ~8 on-screen
    /// points of clipped artwork.
    static let contentRadius: CGFloat = 33

    /// The square a circle of `size` needs so nothing it draws is clipped.
    /// `PanelController` sizes the zoomed window from this; at the parked size
    /// the window's 8pt shadow margin already covers the overhang.
    static func box(for size: CGFloat) -> CGFloat {
        (size * 2 * contentRadius / designSize).rounded(.up)
    }

    private var state: CircleState { model.circleState }

    /// Moon mode, and the artwork actually loaded — a bundle without `moon.png`
    /// falls back to the frosted circle rather than showing a hole.
    private var moon: Bool { model.moonMode && MoonArt.isAvailable }

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
                                  outline: glyphOutlineColor,
                                  outlineWidth: Self.glyphOutline)
                }
                if state.doneUnseenCount > 0 {
                    // Same `outlinedGlyph` treatment as the "?" above — one
                    // definition, so the pair can't drift apart.
                    CheckFat()
                        .outlinedGlyph(fill: Theme.green,
                                       outline: glyphOutlineColor,
                                       width: Self.glyphOutline)
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
    ///
    /// Moon mode flips it to half-BLACK for the same reason it is half-white
    /// here: the moon's surface is a bright yellow, so a white edge dissolves
    /// into it and the glyphs lose their separation. The backdrop still supplies
    /// the other half of the blend — it is the same trick, pointed the other way.
    private var glyphOutlineColor: Color {
        moon ? Color.black.opacity(0.5) : Color.white.opacity(0.5)
    }

    /// This circle's on-screen diameter: the parked 45pt, or the zoomed moon.
    private var discSize: CGFloat { model.moonZoomed ? Self.zoomedSize : Self.size }

    /// The design-size → on-screen factor everything below is authored against.
    private var scale: CGFloat { discSize / Self.designSize }

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
            // Moon mode swaps the vibrancy view for an opaque bitmap. Same
            // placement rules apply — final on-screen size, outside the
            // `scaleEffect` — so the two surfaces are interchangeable and the
            // shadow is identical either way.
            if moon {
                MoonDisc(size: discSize)
                    .shadow(radius: 3 * scale)
            } else {
                Circle()
                    .fill(Color.clear)
                    .background(FrostedBackground(cut: .circle))
                    .frame(width: Self.size, height: Self.size)
                    // The frost cuts its own circle; this clip is what gives the
                    // SHADOW its round silhouette (SwiftUI takes the shadow from the
                    // clipped alpha). Same shape, so the two can't disagree.
                    .clipShape(Circle())
                    .shadow(radius: 3 * scale)
            }

            ZStack {
                // Thin border around the circumference (always present). White
                // against the frost; a soft dark warm line against the moon,
                // where white would vanish into the lit surface and only the
                // artwork's own terminator would separate it from the desktop.
                Circle().inset(by: 0.5).stroke(
                    moon ? Color.black.opacity(0.22) : Color.white.opacity(0.85),
                    lineWidth: 1)

                // Rotating dashes (stars in moon mode) = number of sessions still
                // working (1…5), shown WHENEVER anything works — even while the
                // center glyph is a "?"/"✓". Inset ~1px inside the border (a thin
                // gap of the disc).
                if state.workingCount > 0 {
                    if moon {
                        WorkingStars(count: state.workingCount)
                    } else {
                        WorkingDashes(count: state.workingCount).padding(3)
                    }
                }

                centerGlyph
            }
            .frame(width: Self.designSize, height: Self.designSize)
            .scaleEffect(scale)
        }
        .frame(width: discSize, height: discSize)
        .contentShape(Circle())
        // NB: hover is decided from the pointer's position in PanelController,
        // not tracked here — tracking it on the circle caused an expand/collapse
        // feedback loop as the window resized out from under the cursor.
        //
        // A click acks alerts, and in moon mode toggles the zoomed moon. It
        // deliberately does NOT latch the session pane open: that latch (the old
        // `pinned` flag) was invisible and a stray click on the way to a session
        // row left the pane stuck open with no way to tell why — the pane is
        // hover-driven, and moving the pointer off it must always close it.
        //
        // Alerts keep the click, zoom or no zoom: the bubble is the only way to
        // ack them, and an alert is the one thing on this circle that is waiting
        // on the user. Moon zoom is the fallback meaning, not an override.
        .onTapGesture {
            if state.category == .alert {
                model.toggleAlertBubble()
            } else if moon {
                model.toggleMoonZoom()
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

/// The moon-mode working indicator: the same 1…5 count as `WorkingDashes`, and
/// the same clockwise 1.4s revolution, drawn as stars sitting on the rim instead
/// of dashes drawn along it.
///
/// The stars straddle the rim rather than sitting inside it — centred just short
/// of the 28pt disc edge and large enough that their outer points break past it.
/// Mostly on the moon, a little against the sky: contained stars read as pips on
/// a dial, and stars floating clear of the moon read as unrelated. `radius +
/// starSize/2` is what `CircleView.contentRadius` promises the window, so the
/// overhang is budgeted for and never clipped.
private struct WorkingStars: View {
    let count: Int
    var starSize: CGFloat = 14
    /// Centres 3pt inside the 28pt rim, tips 4pt outside it.
    var radius: CGFloat = 25
    @State private var spin = false

    private var n: Int { min(max(count, 1), 5) }

    var body: some View {
        ZStack {
            ForEach(0..<n, id: \.self) { i in
                // Each star positions ITSELF on the rim (its trail is authored in
                // the same polar space and has to share an origin with it), so all
                // this does is turn the pair to its station.
                StarWithTrail(starSize: starSize, orbitRadius: radius)
                    .rotationEffect(.degrees(Double(i) * 360.0 / Double(n)))
            }
        }
        .rotationEffect(.degrees(spin ? 360 : 0))
        .animation(.linear(duration: 1.4).repeatForever(autoreverses: false), value: spin)
        .onAppear { spin = true }
    }
}

/// One rim star and its motion trail: three tapered streaks curving off the back
/// of it, in the star's own white with the star's own warm outline, so a star
/// going round the moon reads as FLYING rather than riding a wire.
///
/// Entirely static — nothing here animates. The trail is drawn behind the star
/// and carried around by the same rotation `WorkingStars` applies, which is all
/// the motion it has to imply.
///
/// The whole thing is authored in POLAR coordinates about the circle's centre,
/// with the star at 12 o'clock, because the streaks follow the orbit rather than
/// running straight off the back — a straight streak on a 25pt orbit visibly
/// leaves the curve within its own length and reads as a scratch. Everything
/// here is therefore an angle and a radius, and the view's frame is the whole
/// orbit box rather than the star's own.
///
/// "Behind" is DECREASING angle: the stars travel clockwise, and with y growing
/// downward, clockwise is increasing angle. Getting that backwards is the one way
/// this graphic reads wrong, and it reads wrong immediately — the stars look like
/// they are being sucked in rather than flying.
private struct StarWithTrail: View {
    let starSize: CGFloat
    /// Radius the star's centre rides at — the spine the streaks curve along.
    let orbitRadius: CGFloat

    /// Per streak: radial offset from the orbit, arc length, and half-thickness
    /// at the head. Where each one STARTS is not listed — it is derived, so that
    /// all three sit the same distance from the star's actual silhouette.
    ///
    /// The middle one is longest and thickest; the flankers are smaller and, by
    /// that derivation, start further back — the star's rear points stick out
    /// where they are, while the middle one tucks into the valley between those
    /// points. The chevron the three heads form is a consequence of the star's
    /// own shape rather than a stagger picked by eye, which is what makes the
    /// trail read as part of the star instead of three bars parked behind it.
    ///
    /// Lengths are set by RATIO: a streak under about three times its own
    /// thickness stops reading as a trail and starts reading as a chip stuck to
    /// the moon. The middle runs ~4:1, the flankers ~3:1.
    ///
    /// The flankers sit at ±3.0 so that their outer edge (±3.95 with their
    /// half-width) stays inside the ±4.1 where the star's rear points are. They
    /// have to stream from BEHIND that silhouette, never past it — a streak
    /// wider than the back of the star it comes off reads as a separate object
    /// stuck to the star rather than as its wake.
    private static let streaks: [(radial: CGFloat, arc: CGFloat, halfWidth: CGFloat)] = [
        (-3.0, 6.0, 0.95),
        (0, 11.0, 1.4),
        (3.0, 6.0, 0.95),
    ]

    /// Uniform clearance between the star's edge and the head of every streak.
    private static let gap: CGFloat = 1.0

    /// The square the polar geometry is drawn in: the SAME design box the border
    /// circle and the glyphs are authored in, so this view is exactly as big as
    /// its siblings in that ZStack.
    ///
    /// Not a box sized to the trail. A ZStack re-proposes its final union size to
    /// flexible children, so one oversized child silently inflates the others —
    /// giving this view its own 78pt box blew the border `Circle` up to 78pt too
    /// and drew a ring floating well outside the moon. Nothing needs the extra
    /// room anyway: shapes are not clipped to their frame, so the streaks that
    /// ride past the 28pt edge draw fine.
    private var box: CGFloat { CircleView.designSize }

    var body: some View {
        ZStack {
            ForEach(Self.streaks.indices, id: \.self) { i in
                let s = Self.streaks[i]
                let spine = orbitRadius + s.radial
                TrailStreak(
                    spine: spine,
                    // Measured back from the star's REAR EDGE at this streak's
                    // own offset, not from the star's centre — see
                    // `StarShape.rearReach`. Angles rather than lengths, and at
                    // the SPINE's radius rather than the orbit's, so a streak set
                    // inside the orbit doesn't come out longer than the one
                    // outside it.
                    standoff: (StarShape.rearReach(lateralOffset: s.radial, size: starSize)
                        + Self.gap) / spine,
                    sweep: s.arc / spine,
                    halfWidth: s.halfWidth)
            }
            StarShape()
                .fill(Color.white)
                // A star crossing the lit surface would otherwise lose its
                // silhouette exactly where it overlaps the moon. Outlined in the
                // moon's own crater amber rather than a neutral dark, so the edge
                // belongs to the artwork instead of reading as UI.
                .overlay(StarShape().stroke(MoonArt.starOutline, lineWidth: 0.9))
                .frame(width: starSize, height: starSize)
                // Tip into the direction of travel. `StarShape` points at 12
                // o'clock and this station IS 12 o'clock, where travel is +x, so
                // a quarter turn aims the point along the orbit and leaves the
                // valley between the two rear points facing the trail.
                //
                // Before the offset, deliberately: this pivots on the star's own
                // centre, whereas rotating after the offset would pivot on the
                // circle's centre and swing the star off its station.
                .rotationEffect(.degrees(90))
                .offset(y: -orbitRadius)
        }
        .frame(width: box, height: box)
    }
}

/// One streak of the trail: an arc following `spine`, starting `standoff` radians
/// behind the star and running `sweep` radians further back, `halfWidth` thick at
/// the head and tapering to nothing at the tail.
///
/// White, edged in the star's amber at half strength (`MoonArt.trailOutline`) —
/// the star's own edge is too heavy at a third of its width, and no edge at all
/// loses the streak against the lit moon.
///
/// Fill and outline both run through a head→tail opacity ramp, so the streak
/// fades out as it thins instead of ending on a hard little point.
private struct TrailStreak: View {
    let spine: CGFloat
    let standoff: CGFloat
    let sweep: CGFloat
    let halfWidth: CGFloat

    /// 12 o'clock, where `StarWithTrail` authors the star, less the standoff.
    private var head: CGFloat { -.pi / 2 - standoff }
    private var tail: CGFloat { head - sweep }

    /// Where an angle on the spine lands in the frame's unit space — the gradient
    /// has to follow the arc, and a stock `.leading`/`.trailing` pair would run
    /// across the whole box instead of along the ~20° the streak occupies.
    private func unit(_ angle: CGFloat, in box: CGFloat) -> UnitPoint {
        UnitPoint(x: 0.5 + cos(angle) * spine / box, y: 0.5 + sin(angle) * spine / box)
    }

    private func ramp(_ color: Color, in box: CGFloat) -> LinearGradient {
        LinearGradient(
            colors: [color, color.opacity(0.35)],
            startPoint: unit(head, in: box), endPoint: unit(tail, in: box))
    }

    var body: some View {
        GeometryReader { geo in
            let box = min(geo.size.width, geo.size.height)
            let shape = TrailArc(
                spine: spine, head: head, sweep: sweep, halfWidth: halfWidth)
            shape
                .fill(ramp(.white, in: box))
                // Thinner than the star's own 0.9 as well as lighter: the two
                // edges of a streak this narrow are only a couple of points
                // apart, so weight here costs double what it does on the star.
                .overlay(shape.stroke(ramp(MoonArt.trailOutline, in: box), lineWidth: 0.55))
        }
    }
}

/// The streak's outline: a tapering ribbon along an arc. Drawn about the centre
/// of `rect`, in the same polar space as the star it trails.
private struct TrailArc: Shape {
    /// Radius of the ribbon's centre line.
    let spine: CGFloat
    /// Angle of the head (the end nearest the star).
    let head: CGFloat
    /// How far back from the head the ribbon runs, in radians. Positive.
    let sweep: CGFloat
    /// Half-thickness at the head, held for `hold` of the run and then tapered
    /// to zero at the tail.
    let halfWidth: CGFloat

    /// How much of the streak keeps its full thickness before the taper starts.
    /// Tapering from the very head makes a shard — a thin wedge with no body,
    /// which at the parked size is all outline and no fill. Holding the width
    /// for the first third gives it a stripe to be the tail OF.
    private static let hold: CGFloat = 0.35

    /// Enough segments that the curve is smooth at ten times the parked size,
    /// where a streak is ~90 points long.
    private static let steps = 24

    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        func point(_ angle: CGFloat, _ radius: CGFloat) -> CGPoint {
            CGPoint(x: c.x + cos(angle) * radius, y: c.y + sin(angle) * radius)
        }

        var outer: [CGPoint] = []
        var inner: [CGPoint] = []
        for step in 0...Self.steps {
            let t = CGFloat(step) / CGFloat(Self.steps)
            let angle = head - sweep * t
            let w = halfWidth * min(1, (1 - t) / (1 - Self.hold))
            outer.append(point(angle, spine + w))
            inner.append(point(angle, spine - w))
        }

        var path = Path()
        path.move(to: outer[0])
        for p in outer.dropFirst() { path.addLine(to: p) }
        for p in inner.reversed() { path.addLine(to: p) }
        // Closes on a flat radial edge at the head. A chevron notch bitten in
        // here was the obvious way to make each streak a dart, and it is wrong at
        // this size: the notch splits the head into two prongs, so three streaks
        // render as six thorns and the whole trail reads as flames. The chevron
        // lives in the FORMATION instead — see `StarWithTrail.streaks`.
        path.closeSubpath()
        return path
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
