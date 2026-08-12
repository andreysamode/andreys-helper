// Shared visual language — mirrors the Source+ panel's status icons, colors, and
// box styling (see src/scmMirrorView.ts: CLAUDE_STATUS, .ctab, .cspin/.ccheck/.cask)
// so the orchestrator reads as the same product.

import SwiftUI
import AppKit

enum Theme {
    // Source+ palette (scmMirrorView.ts CLAUDE_STATUS + .ctab accents).
    static let terracotta = Color(hex: 0xD97757) // hover/active accent + attention "?"
    static let green = Color(hex: 0x22C55E) // done (unseen) check
    static let amber = Color(hex: 0xF59E0B)
    static let purple = Color(hex: 0xA855F7)
    static let red = Color(hex: 0xEF4444) // permission / alert
    static let blue = Color(hex: 0x3B82F6)

    // Session box (`.ctab`) fills/borders. Source+ uses the editor's warm light
    // theme vars (tab-activeBackground + an #FDF8EC cream mix on the active row);
    // the orchestrator isn't in VS Code, so these are concrete warm-light values
    // chosen to match that panel.
    static let boxFill = Color(hex: 0xFFFFFF).opacity(0.55) // idle row on frosted panel
    static let boxActiveFill = Color(hex: 0xFDF3DE) // active row — warm cream
    static let boxBorder = Color.black.opacity(0.16) // idle 1px outline
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1)
    }
}

/// Always-frosted vibrancy background — the ONE place the frost is configured, so
/// the circle, the session pane, and the orchestrator pane can never drift apart.
///
/// This is the samodeus-mac frost recipe (`MenuChrome.configureBlur`, the shared
/// factory behind every frosted surface there: menus, dropdowns, arrow popovers,
/// modal cards, the settings backdrop):
///
///   * `.popover` material — the light, warm-neutral frost, NOT `.hudWindow`'s
///     darker gray wash, and not emphasized (emphasis pushes it toward the
///     opaque key-window tone).
///   * `.behindWindow` blending — every orchestrator surface lives in the borderless
///     `CirclePanel`, i.e. samodeus's `FrostHost.window`: a separate window
///     sampling what is behind it. samodeus only lays its corrective α0.8
///     `PopoverChrome.tint` over `.withinWindow` frosts, whose lighter base tone
///     needs pulling back; a `.behindWindow` `.popover` is already the target
///     tone, so there is deliberately NO tint layer here.
///   * `appearance` pinned to `.aqua` — samodeus resolves the frost's appearance
///     from its own theme rather than inheriting the system's. The orchestrator's
///     palette is warm-light throughout (cream/white box fills), so the frost
///     stays light in macOS dark mode instead of turning into a dark HUD under
///     unchanged cream rows.
///   * `state = .active` — unlike SwiftUI's `.ultraThinMaterial` (which follows
///     the window's key state and desaturates to gray when the non-activating
///     panel isn't key), this pins active so the frost is identical whether or
///     not the panel has focus.
///
/// The frost also carries its OWN rounded shape (`cut`) rather than being clipped
/// from above — see `FrostView` for why that distinction is load-bearing.
struct FrostedBackground: NSViewRepresentable {
    /// The shape the frost is cut to, applied to the vibrancy view itself.
    enum Cut: Equatable {
        case rect
        case circle
        case rounded(CGFloat)
    }

    var material: NSVisualEffectView.Material = .popover
    var cut: Cut = .rect

    func makeNSView(context: Context) -> FrostView {
        let v = FrostView()
        v.blendingMode = .behindWindow
        configure(v)
        return v
    }

    func updateNSView(_ v: FrostView, context: Context) {
        configure(v)
    }

    private func configure(_ v: FrostView) {
        v.material = material
        v.state = .active
        v.appearance = NSAppearance(named: .aqua)
        v.cut = cut
    }
}

/// A `.behindWindow` vibrancy view that cuts its own round shape via `maskImage`.
///
/// This exists because of the "circle flashes as a square on hover" bug, and the
/// reason is architectural. `.behindWindow` material is not drawn by us: the
/// window server composites it *underneath* the app's layers, from a backdrop
/// region it is handed separately. A SwiftUI `.clipShape(Circle())` above the
/// view is nothing but `masksToBounds` + `cornerRadius` on an intermediate
/// `_NSGraphicsView` (measured) — an app-side layer clip. For that clip to reach
/// the backdrop it has to be re-derived and re-sent to the window server, and
/// that re-derivation is not atomic with the window's own geometry change. Hover
/// resizes the panel 61×61 → 369×576 and slides the disc from one end of it to
/// the other, so for a frame or two the backdrop could still be the *unclipped*
/// rectangle: a square of frost, exactly as reported.
///
/// `maskImage` is the sanctioned fix. It is part of the vibrancy view's own
/// state, so it travels with the backdrop instead of having to be recovered from
/// the layer tree, and — because the disc's bounds never change, only its
/// position — nothing about it needs recomputing when the panel resizes.
///
/// The other half of the same bug lives at the call site: nothing may apply a
/// scale transform ABOVE one of these (see `CircleView`), since that is another
/// ancestor-layer property the backdrop would have to re-derive.
final class FrostView: NSVisualEffectView {
    var cut: FrostedBackground.Cut = .rect {
        didSet { if cut != oldValue { rebuildMask() } }
    }

    /// Bounds the current `maskImage` was cut for, so `layout` only redraws it
    /// when the size actually changed (every surface here is fixed-size, so in
    /// practice this happens exactly once per view).
    private var maskedSize: NSSize = .zero

    override func layout() {
        super.layout()
        if bounds.size != maskedSize { rebuildMask() }
    }

    private func rebuildMask() {
        maskedSize = bounds.size
        let radius: CGFloat
        switch cut {
        case .rect:
            maskImage = nil
            return
        case .circle:
            radius = min(bounds.width, bounds.height) / 2
        case .rounded(let r):
            radius = r
        }
        guard bounds.width > 0, bounds.height > 0 else {
            maskImage = nil
            return
        }
        // Drawn at exactly the view's size — `maskedSize` re-cuts it on any
        // resize, so the image never has to be stretched (and a circle has no
        // stretchable center region to cap-inset anyway).
        maskImage = NSImage(size: bounds.size, flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
    }
}

/// The Source+ working spinner (`.cspin`) — a terracotta ring open at the top
/// (border-top transparent), rotating.
struct RingSpinner: View {
    var size: CGFloat = 11
    var lineWidth: CGFloat = 1.6
    var color: Color = Theme.terracotta
    var trim: CGFloat = 0.75
    @State private var spin = false

    var body: some View {
        Circle()
            .trim(from: 0, to: trim)
            .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(.linear(duration: 0.8).repeatForever(autoreverses: false), value: spin)
            .opacity(0.85)
            .onAppear { spin = true }
    }
}

/// The Source+ "done" check — the Phosphor **check-fat** glyph, i.e. the exact
/// shape of `SVG_CHECKFAT` emitted by `statusIndicator()` in src/scmMirrorView.ts,
/// so the orchestrator's done icon is identical to the Source+ panel rather than the
/// visibly thinner, differently-angled SF Symbol `checkmark`.
///
/// Reproduced from the SVG's 256×256 outline as a rounded-corner checkmark: the
/// path is a 6-vertex polygon whose corners carry a 16-unit radius, except the
/// inner elbow, which is sharp (the SVG uses a straight `L` there). Vertices are
/// the sharp intersections of the outline's straight edges; `addArc(tangent…)`
/// re-rounds each corner, matching the SVG's arcs.
struct CheckFat: Shape {
    func path(in rect: CGRect) -> Path {
        // Sharp-corner vertices in travel order (256×256 viewBox space).
        let verts: [CGPoint] = [
            CGPoint(x: 254.78, y: 79.44),   // top-right
            CGPoint(x: 103.57, y: 230.65),  // bottom tip
            CGPoint(x: 9.40,   y: 135.98),  // short-arm end
            CGPoint(x: 51.79,  y: 93.58),   // short-arm outer
            CGPoint(x: 104.00, y: 144.22),  // inner elbow (sharp)
            CGPoint(x: 212.01, y: 37.54),   // tall-arm top
        ]
        let radii: [CGFloat] = [16, 16, 16, 16, 0, 16]

        let s = min(rect.width, rect.height) / 256
        let pts = verts.map { CGPoint(x: rect.minX + $0.x * s, y: rect.minY + $0.y * s) }
        let n = pts.count

        // Start on the last edge so the first arc has a real incoming direction.
        let last = pts[n - 1], first = pts[0]
        var p = Path()
        p.move(to: CGPoint(x: (last.x + first.x) / 2, y: (last.y + first.y) / 2))
        for i in 0..<n {
            p.addArc(tangent1End: pts[i], tangent2End: pts[(i + 1) % n], radius: radii[i] * s)
        }
        p.closeSubpath()
        return p
    }
}

/// A short string as a `Shape`, so it can be STROKED as well as filled —
/// SwiftUI's `Text` can only be filled, and the circle's center glyphs need a
/// hairline outline (see `CircleView.centerGlyph`).
///
/// The glyphs are laid out on a baseline `ascent` below the top of the rect,
/// i.e. exactly where `Text` puts it: for the system font `leading` is 0, so
/// `boxSize` (ascent + descent) is the same box `Text` reserves to within a
/// third of a point, and swapping one for the other doesn't move the glyph.
struct GlyphPath: Shape {
    let string: String
    /// The system font to trace, held as size + weight rather than an `NSFont`
    /// so the shape stays `Sendable` (`Shape` requires it; `NSFont` isn't).
    let size: CGFloat
    let weight: NSFont.Weight

    private var font: NSFont { .systemFont(ofSize: size, weight: weight) }

    /// The box `Text` would occupy for this string — give the view this frame.
    var boxSize: CGSize {
        let m = Self.metrics(string, font)
        return CGSize(width: m.advance, height: m.ascent + m.descent)
    }

    func path(in rect: CGRect) -> Path {
        let m = Self.metrics(string, font)
        let glyphs = CGMutablePath()
        for run in CTLineGetGlyphRuns(m.line) as? [CTRun] ?? [] {
            let attrs = CTRunGetAttributes(run) as NSDictionary
            guard let runFont = attrs[kCTFontAttributeName as String] as? NSFont else { continue }
            let count = CTRunGetGlyphCount(run)
            var ids = [CGGlyph](repeating: 0, count: count)
            var positions = [CGPoint](repeating: .zero, count: count)
            CTRunGetGlyphs(run, CFRange(location: 0, length: count), &ids)
            CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
            for i in 0..<count {
                guard let g = CTFontCreatePathForGlyph(runFont, ids[i], nil) else { continue }
                glyphs.addPath(g, transform: CGAffineTransform(translationX: positions[i].x,
                                                              y: positions[i].y))
            }
        }
        // Core Text is y-up from the baseline; flip into the rect's y-down space
        // with the baseline sitting `ascent` below the top edge.
        let toRect = CGAffineTransform(translationX: rect.minX, y: rect.minY + m.ascent)
            .scaledBy(x: 1, y: -1)
        return Path(glyphs).applying(toRect)
    }

    private static func metrics(_ string: String, _ font: NSFont)
        -> (line: CTLine, advance: CGFloat, ascent: CGFloat, descent: CGFloat) {
        let line = CTLineCreateWithAttributedString(
            NSAttributedString(string: string, attributes: [.font: font]))
        var ascent: CGFloat = 0, descent: CGFloat = 0
        let advance = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
        return (line, advance, ascent, descent)
    }
}

extension Shape {
    /// THE definition of an outlined center glyph — the circle's "?" and its "✓"
    /// both render through this, so the two cannot drift apart in outline width,
    /// outline color, or stroke geometry. Previously each call site hand-rolled
    /// `.fill` + `.background(.stroke)` and stayed matched only by both passing
    /// the same constants; parity is structural now.
    ///
    /// The outline is a PAIR of bands — a light one hugging the glyph, a darker
    /// one outside it. One band can only ever separate the glyph from backdrops
    /// darker (or lighter) than itself; two opposite bands separate it from
    /// both, which is what lets these glyphs sit on a `.behindWindow` disc whose
    /// backdrop is whatever window happens to be under the HUD. The light band
    /// also does the work of making the glyph read as slightly raised rather
    /// than merely fenced in.
    ///
    /// `innerBand`/`outerBand` are VISIBLE thicknesses, not line widths. Strokes
    /// are centered on the path and sit behind the fill, so only their outer
    /// half shows: a band of `b` needs a `2 * b` stroke, and the outer band's
    /// stroke has to clear the inner one's radius before it starts showing.
    ///
    /// Two more deliberate choices, shared by every glyph that uses it:
    ///
    /// • The strokes go BEHIND the fill, not over it. A stroke is centered on
    ///   the path, so an overlay paints its inner half across the glyph —
    ///   thinning it and washing `fill` toward the outline color, which is how
    ///   the circle's check came to look like a paler green than the identical
    ///   `Theme.green` in a session row. Behind the fill only the outer half
    ///   survives and `fill` renders at full strength.
    ///
    /// • Round joins and caps, because these glyphs don't agree on corners —
    ///   `CheckFat` has a deliberately sharp inner elbow and text glyphs have
    ///   flat terminals. A miter join would let the hairline spike outward at
    ///   those corners on one glyph and not the other.
    func outlinedGlyph(fill: Color,
                       inner: Color, innerBand: CGFloat,
                       outer: Color, outerBand: CGFloat) -> some View {
        self.fill(fill)
            .background(self.stroke(inner, style: glyphStroke(2 * innerBand)))
            .background(self.stroke(outer, style: glyphStroke(2 * (innerBand + outerBand))))
    }
}

/// Shared stroke geometry for `outlinedGlyph`'s two bands — see the round
/// cap/join rationale there.
private func glyphStroke(_ lineWidth: CGFloat) -> StrokeStyle {
    StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
}

/// A `GlyphPath` drawn in the shared center-glyph style — the stroked
/// counterpart of `Text`, used for the circle's "?" so it matches the
/// `CheckFat` beside it. See `Shape.outlinedGlyph`.
struct OutlinedGlyph: View {
    let string: String
    let size: CGFloat
    var weight: NSFont.Weight = .bold
    let color: Color
    var inner: Color = .white
    var innerBand: CGFloat = 0.5
    var outer: Color = .black
    var outerBand: CGFloat = 0.5

    var body: some View {
        let shape = GlyphPath(string: string, size: size, weight: weight)
        let box = shape.boxSize
        return shape
            .outlinedGlyph(fill: color, inner: inner, innerBand: innerBand,
                           outer: outer, outerBand: outerBand)
            .frame(width: box.width, height: box.height)
    }
}

/// The per-session status icon shown in a session box — identical semantics to
/// Source+ `statusIndicator()`: working → muted spinner, done(unseen) → green
/// check, any attention state → terracotta "?", idle/done(seen) → empty (the
/// 16pt slot still holds width so titles stay aligned across rows).
struct SessionStatusIcon: View {
    let status: SessionStatus
    let seen: Bool

    var body: some View {
        ZStack {
            switch status {
            case .working:
                RingSpinner(size: 11, lineWidth: 1.6, color: Theme.terracotta)
            case .done:
                if !seen {
                    CheckFat()
                        .fill(Theme.green)
                        .frame(width: 14, height: 14) // matches Source+ .ccheck (14×14 SVG)
                }
            case .question, .plan, .permission:
                Text("?")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(Theme.terracotta)
            case .idle:
                EmptyView()
            }
        }
        .frame(width: 16, height: 16)
    }
}
