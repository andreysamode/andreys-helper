// The moon face used by moon mode (`CircleView`).
//
// `moon.png` is a 256px RGBA disc — the painted moon cropped to its own circle,
// with everything outside it transparent — so it can be drawn straight into the
// circle's frame with no colour fringe from the artwork's original backdrop.

import AppKit
import SwiftUI

enum MoonArt {
    /// The moon bitmap, or nil when the app is running without its resources.
    ///
    /// Deliberately NOT `Bundle.module`: SwiftPM's generated accessor calls
    /// `fatalError` when it can't find the resource bundle, and a missing image
    /// is not worth killing the HUD over. Same search, nil instead of a trap —
    /// moon mode falls back to the frosted circle.
    static let image: NSImage? = {
        let name = "AndreysOrchestrator_AndreysOrchestrator.bundle"
        // Contents/Resources when bundled as the .app; the build directory
        // alongside the binary for a plain `swift run`.
        let roots = [Bundle.main.resourceURL, Bundle.main.bundleURL].compactMap { $0 }
        for root in roots {
            if let bundle = Bundle(url: root.appendingPathComponent(name)),
                let url = bundle.url(forResource: "moon", withExtension: "png"),
                let image = NSImage(contentsOf: url)
            {
                return image
            }
        }
        // Loose in Contents/Resources — the shape an older staged bundle has.
        if let url = Bundle.main.url(forResource: "moon", withExtension: "png") {
            return NSImage(contentsOf: url)
        }
        NSLog("AndreysOrchestrator: moon.png not found — moon mode will show the frosted circle")
        return nil
    }()

    static var isAvailable: Bool { image != nil }

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
