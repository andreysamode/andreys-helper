// The artwork used by moon mode (`CircleView`) — the moon face and the two
// centre glyphs, as three layers of ONE illustration.
//
// `moon.png` is the painted moon cropped to its own circle, with everything
// outside it transparent, so it can be drawn straight into the circle's frame
// with no colour fringe from the artwork's original backdrop. `moon-q.png` and
// `moon-v.png` are the "?" and "✓" on a transparent canvas of the SAME square,
// each already carrying its inner shadow, white edge, taupe secondary edge and
// drop shadow, and already sitting where it belongs in the side-by-side pair.
//
// Because the three share a canvas, the layers need no layout: drawing one
// across the whole disc reproduces the illustration exactly. The only geometry
// kept here is each glyph's bounding box, for the one thing a fixed canvas
// cannot express — a glyph shown WITHOUT its partner (see `MoonCenterGlyphs`).

import AppKit
import SwiftUI

enum MoonArt {
    /// The moon bitmap, or nil when the app is running without its resources.
    static let image: NSImage? = load("moon")

    /// The centre-glyph layers: the terracotta "?" and the green "✓".
    static let questionLayer: NSImage? = load("moon-q")
    static let checkLayer: NSImage? = load("moon-v")

    /// Edge of the square canvas all three layers share, in pixels.
    static let canvas: CGFloat = 876

    /// Where each glyph's ink actually falls inside `canvas` — the alpha bounding
    /// box of the shipped art, measured once (shadows and both edges included,
    /// since those are part of the glyph). Re-measure if the art is re-exported;
    /// nothing at runtime checks these against the pixels.
    static let questionBox = CGRect(x: 121, y: 191, width: 321, height: 460)
    static let checkBox = CGRect(x: 385, y: 284, width: 398, height: 318)

    /// The offset that moves `box`'s centre onto the centre of a canvas drawn at
    /// `size` — i.e. what it takes to bring one glyph of the pair back to the
    /// middle of the disc when it is shown on its own.
    static func recentring(_ box: CGRect, drawnAt size: CGFloat) -> CGSize {
        let k = size / canvas
        return CGSize(width: (canvas / 2 - box.midX) * k,
                      height: (canvas / 2 - box.midY) * k)
    }

    static var isAvailable: Bool { image != nil }

    /// Both glyph layers present. Required together: one layer missing would put
    /// a painted glyph beside a vector one, which looks worse than the vector
    /// pair that `CircleView` falls back to.
    static var glyphsAvailable: Bool { questionLayer != nil && checkLayer != nil }

    /// Finds a PNG in the resource bundle.
    ///
    /// Deliberately NOT `Bundle.module`: SwiftPM's generated accessor calls
    /// `fatalError` when it can't find the resource bundle, and a missing image
    /// is not worth killing the HUD over. Same search, nil instead of a trap —
    /// moon mode falls back to the frosted circle and the vector glyphs.
    private static func load(_ name: String) -> NSImage? {
        let bundleName = "AndreysOrchestrator_AndreysOrchestrator.bundle"
        // Contents/Resources when bundled as the .app; the build directory
        // alongside the binary for a plain `swift run`.
        let roots = [Bundle.main.resourceURL, Bundle.main.bundleURL].compactMap { $0 }
        for root in roots {
            if let bundle = Bundle(url: root.appendingPathComponent(bundleName)),
                let url = bundle.url(forResource: name, withExtension: "png"),
                let image = NSImage(contentsOf: url)
            {
                return image
            }
        }
        // Loose in Contents/Resources — the shape an older staged bundle has.
        if let url = Bundle.main.url(forResource: name, withExtension: "png") {
            return NSImage(contentsOf: url)
        }
        NSLog("AndreysOrchestrator: \(name).png not found — moon mode will fall back")
        return nil
    }

    /// Outline for the moon-mode stars: the deep amber of the moon's own crater
    /// shadows. Dark enough to hold a white star's silhouette where it crosses
    /// the lit surface, warm enough that it reads as part of the illustration
    /// rather than a UI stroke laid over it.
    static let starOutline = Color(red: 0.36, green: 0.21, blue: 0.04).opacity(0.85)

    /// Outline for the trail streaks: the star's own edge at half strength.
    ///
    /// A streak is a third the star's width, so the full-strength edge meets
    /// itself across the ribbon and the trail reads as dark braided rope rather
    /// than as light. Dropping the outline altogether fixes that and costs too
    /// much — bare white has nothing to separate it from the moon's lit face.
    /// Half is the settlement: enough edge to hold the shape, not enough to
    /// close up across the width.
    ///
    /// Derived from `starOutline` rather than restated, so the two can only ever
    /// differ in strength — `Color.opacity` multiplies into what is already
    /// there, making this the same amber at ~0.42.
    static let trailOutline = starOutline.opacity(0.5)
}

/// The moon drawn to fill `size`, opaque (no vibrancy — the moon IS the surface).
struct MoonDisc: View {
    let size: CGFloat

    var body: some View {
        if let image = MoonArt.image {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fill)
                .frame(width: size, height: size)
                // The art is already a disc; this only guarantees the SHADOW's
                // silhouette is round (SwiftUI takes it from the clipped alpha).
                .clipShape(Circle())
        }
    }
}

/// Moon mode's centre glyphs — the "?" and "✓" as painted layers rather than the
/// vector `OutlinedGlyph`/`CheckFat` pair.
///
/// The layers share `moon.png`'s canvas, so drawn across the whole disc they land
/// exactly where the illustration puts them: the sizes, the side-by-side order,
/// and the slight overlap between the "✓" and the "?" descender all come from the
/// art and are not restated here.
///
/// A LONE glyph is the one thing the shared canvas cannot express. Its baked
/// position is its place in the PAIR — the "?" left of centre, the "✓" right of
/// it — which reads as a rendering fault when there is nothing beside it, so a
/// glyph shown on its own is shifted back onto the centre of the disc.
struct MoonCenterGlyphs: View {
    let question: Bool
    let check: Bool
    /// Edge of the square the layers are drawn across — the disc's diameter in
    /// whatever coordinate space this view is placed in. The moon fills the same
    /// square, which is what keeps the layers registered to it.
    let size: CGFloat

    var body: some View {
        ZStack {
            if question {
                layer(MoonArt.questionLayer, box: MoonArt.questionBox, alone: !check)
            }
            if check {
                layer(MoonArt.checkLayer, box: MoonArt.checkBox, alone: !question)
            }
        }
        .frame(width: size, height: size)
    }

    @ViewBuilder
    private func layer(_ image: NSImage?, box: CGRect, alone: Bool) -> some View {
        if let image {
            // A big downsample (a ~876px layer into a 56pt box), so interpolation
            // is doing real work here — the glyph edges and the taupe outline are
            // both about a pixel wide once scaled.
            let shift = alone ? MoonArt.recentring(box, drawnAt: size) : CGSize.zero
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
                .offset(x: shift.width, y: shift.height)
        }
    }
}

/// A five-pointed cartoon star. Used for the working-session indicator in moon
/// mode, where the rotating rim dashes would read as debris around the moon.
struct StarShape: Shape {
    /// Inner (valley) radius as a fraction of the outer (tip) radius. 0.42 is
    /// the chunky storybook star; lower gets spiky, higher gets floral.
    static let defaultInnerRatio: CGFloat = 0.42

    var points: Int = 5
    var innerRatio: CGFloat = StarShape.defaultInnerRatio

    func path(in rect: CGRect) -> Path {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let outer = min(rect.width, rect.height) / 2
        let inner = outer * innerRatio
        var path = Path()
        for i in 0..<(points * 2) {
            // Start at 12 o'clock so a lone star points straight up.
            let angle = -CGFloat.pi / 2 + CGFloat(i) * .pi / CGFloat(points)
            let radius = i.isMultiple(of: 2) ? outer : inner
            let point = CGPoint(
                x: center.x + cos(angle) * radius,
                y: center.y + sin(angle) * radius)
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        return path
    }

    /// How far the silhouette of a TIP-FORWARD five-pointed star reaches behind
    /// its centre, at a lateral offset `u` from the axis it points along.
    ///
    /// The back of a star is not a wall. On the centre line it is the valley
    /// between the two rear points — barely 0.42 of the radius out — and it runs
    /// out to a full-radius point on either side. Anything meant to sit a fixed
    /// distance BEHIND the star has to measure from this, not from the star's
    /// centre or its bounding box: measured from the centre, something on the
    /// axis is left stranded in open space while its neighbours crowd the points.
    ///
    /// Beyond the rear points the silhouette turns back toward the side points;
    /// `u` is clamped there, which under-reports and so only ever errs toward a
    /// bigger gap.
    static func rearReach(lateralOffset u: CGFloat, size: CGFloat) -> CGFloat {
        let r = size / 2
        let inner = r * defaultInnerRatio
        // Tip at 0°, so the rear points sit at ±144° and the valley at 180°.
        let rearPoint = CGFloat.pi * 144 / 180
        let depth = -r * cos(rearPoint)  // 0.809r behind centre
        let lateral = r * sin(rearPoint)  // 0.588r off axis
        let t = min(1, abs(u) / lateral)
        return inner + t * (depth - inner)
    }
}
