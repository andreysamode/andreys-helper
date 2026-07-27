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
struct FrostedBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .popover

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.blendingMode = .behindWindow
        configure(v)
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        configure(v)
    }

    private func configure(_ v: NSVisualEffectView) {
        v.material = material
        v.state = .active
        v.appearance = NSAppearance(named: .aqua)
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
