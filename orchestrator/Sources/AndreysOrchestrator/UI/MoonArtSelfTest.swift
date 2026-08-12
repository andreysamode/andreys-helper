// Moon-mode centre-glyph self-test (`--selftest-moonart`).
//
// The painted "?"/"✓" layers (`MoonCenterGlyphs`) carry their own size and their
// side-by-side placement inside a canvas shared with `moon.png`, and `MoonArt`
// restates each glyph's bounding box as a CONSTANT so a lone glyph can be pulled
// back to the middle of the disc. Two things can silently rot there: the art can
// be re-exported with a glyph in a different spot, and the disc and the layers
// can come out of registration (they are drawn in different coordinate spaces —
// the moon at its final on-screen size, the glyphs inside the scaled design box).
//
// Both are geometry, so this test measures geometry off REAL renders of the REAL
// `CircleView`. Each glyph is isolated by DIFFING two renders that differ only in
// that glyph's presence, which needs no colour-matching against the moon's own
// yellows and cannot drift away from what the circle actually composites.
//
// Invoked via `swift run AndreysOrchestrator --selftest-moonart`. Also writes the
// three states to PNGs for eyeballing against the reference art.

import AppKit
import SwiftUI

@MainActor
enum MoonArtSelfTest {
    /// Rendered at the zoomed moon (450pt) at 2×, so one pixel of the 876px art is
    /// about one pixel of the render and a measured box is worth trusting to ~1px.
    private static let renderScale: CGFloat = 2

    static func run() -> Bool {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[moonart]: \(name)")
            if !cond { pass = false }
        }

        // 0) The layers load and share the moon's canvas — everything else here
        //    assumes one canvas for all three.
        guard let moon = MoonArt.image,
              let q = MoonArt.questionLayer,
              let v = MoonArt.checkLayer else {
            check("moon.png + moon-q.png + moon-v.png all load", false)
            return false
        }
        check("moon.png + moon-q.png + moon-v.png all load", true)
        let squares = [moon, q, v].map { $0.size }
        check("all three layers are square", squares.allSatisfy { abs($0.width - $0.height) < 0.5 })
        check("glyph layers share the moon's aspect", abs(q.size.width / q.size.height - moon.size.width / moon.size.height) < 0.01)

        // 1) The hardcoded boxes still describe the shipped pixels. This is the
        //    check that catches re-exported art: nothing at runtime reads the
        //    alpha, so a moved glyph would only show up as bad solo centring.
        for (name, image, expected) in [("moon-q", q, MoonArt.questionBox),
                                        ("moon-v", v, MoonArt.checkBox)] {
            guard let measured = alphaBox(of: image) else {
                check("\(name).png has visible ink", false); continue
            }
            let k = MoonArt.canvas / image.size.width  // px per canvas unit
            let scaled = CGRect(x: expected.minX / k, y: expected.minY / k,
                                width: expected.width / k, height: expected.height / k)
            let off = maxCornerDrift(measured, scaled)
            check("\(name).png ink matches MoonArt's box (drift \(fmt(off))px ≤ 3)", off <= 3)
        }

        // 2) Renders of the real circle, differing only in which glyphs are asked
        //    for. The idle render is the baseline: moon + border, no glyphs.
        guard let idle = render(question: 0, done: 0),
              let qOnly = render(question: 1, done: 0),
              let vOnly = render(question: 0, done: 1),
              let both = render(question: 1, done: 1) else {
            check("CircleView renders in all four states", false)
            return false
        }
        check("CircleView renders in all four states", true)

        let disc = CGFloat(idle.width)  // square render; the disc fills it
        let canvasToPixels = disc / MoonArt.canvas

        // A solo glyph must be CENTRED on the disc, at the art's own size.
        for (name, image, box) in [("?", qOnly, MoonArt.questionBox),
                                   ("✓", vOnly, MoonArt.checkBox)] {
            guard let ink = diffBox(image, idle) else {
                check("solo \(name) draws something", false); continue
            }
            check("solo \(name) draws something", true)
            let expectedSize = CGSize(width: box.width * canvasToPixels,
                                      height: box.height * canvasToPixels)
            check("solo \(name) is the art's size (\(fmt(ink.width))×\(fmt(ink.height)) vs \(fmt(expectedSize.width))×\(fmt(expectedSize.height)))",
                  abs(ink.width - expectedSize.width) <= 4 && abs(ink.height - expectedSize.height) <= 4)
            // A few pixels of slack, at ~900px across: the drop shadow's faintest
            // tail passes the alpha threshold used on the layer but not always the
            // difference threshold used against the moon underneath it, and the
            // measured centre moves with it. Under a pixel at the parked 45pt.
            let dx = ink.midX - disc / 2, dy = ink.midY - disc / 2
            check("solo \(name) is centred on the disc (off by \(fmt(dx)), \(fmt(dy)) ≤ 4px)",
                  abs(dx) <= 4 && abs(dy) <= 4)
        }

        // Paired, the glyphs must sit where the ARTWORK puts them, which is also
        // proof the layers are registered to the moon: the expected box is the
        // canvas box scaled by the disc the moon itself is filling.
        //
        // Measured as the UNION of the two, because the pair cannot be taken apart
        // by diffing — the only render with one glyph has it centred, not parked in
        // its half. The union pins all four outer edges (the "?" sets left, the "✓"
        // right, and they set one of top/bottom each), and the solo checks above
        // already pin each glyph's own size.
        if let ink = diffBox(both, idle) {
            let union = MoonArt.questionBox.union(MoonArt.checkBox)
            let expected = CGRect(x: union.minX * canvasToPixels, y: union.minY * canvasToPixels,
                                  width: union.width * canvasToPixels, height: union.height * canvasToPixels)
            let off = maxCornerDrift(ink, expected)
            check("the pair spans the art's baked positions (drift \(fmt(off))px ≤ 5)", off <= 5)
        } else {
            check("the pair draws something", false)
        }

        // 3) PNGs for the eye — the styling (inner shadow, white edge, taupe
        //    secondary edge, drop shadow) is the art's, and only a look can
        //    confirm it survived compositing.
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("moonart-selftest", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, image) in [("idle", idle), ("question", qOnly), ("check", vOnly), ("pair", both)] {
            let url = dir.appendingPathComponent("\(name).png")
            if write(image, to: url) { print("  wrote \(url.path)") }
        }

        return pass
    }

    // MARK: - Rendering

    /// The real `CircleView` in moon mode at the zoomed size, with `count`s that
    /// ask for the glyphs and nothing working (no rim stars to confuse a diff).
    private static func render(question: Int, done: Int) -> CGImage? {
        let model = AppModel()
        model.moonMode = true
        model.toggleMoonZoom()  // moonZoomed is private(set); this is its only door
        model.circleState = CircleState(category: question > 0 ? .needsInput : (done > 0 ? .doneUnseen : .idle),
                                        count: 0,
                                        alertCount: 0,
                                        workingCount: 0,
                                        needsInputCount: question,
                                        doneUnseenCount: done)
        let renderer = ImageRenderer(content: CircleView(model: model))
        renderer.scale = renderScale
        return renderer.cgImage
    }

    private static func write(_ image: CGImage, to url: URL) -> Bool {
        let rep = NSBitmapImageRep(cgImage: image)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: url)) != nil
    }

    // MARK: - Pixel measurement

    /// Bounding box of everything with meaningful alpha, in the image's pixels.
    private static func alphaBox(of image: NSImage) -> CGRect? {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let px = Pixels(cg) else { return nil }
        return px.box { $0.a > 5 }
    }

    /// Bounding box of the pixels where two renders of the same size DIFFER —
    /// i.e. exactly the ink one has and the other does not.
    private static func diffBox(_ a: CGImage, _ b: CGImage) -> CGRect? {
        guard a.width == b.width, a.height == b.height,
              let pa = Pixels(a), let pb = Pixels(b) else { return nil }
        return pa.box(comparedTo: pb, differBy: 12)
    }

    /// How far apart two boxes are, as the worst of their four corners. Compares
    /// position AND size in one number, which is what "did this glyph move or
    /// resize" wants.
    private static func maxCornerDrift(_ a: CGRect, _ b: CGRect) -> CGFloat {
        max(abs(a.minX - b.minX), abs(a.minY - b.minY),
            abs(a.maxX - b.maxX), abs(a.maxY - b.maxY))
    }

    private static func fmt(_ v: CGFloat) -> String { String(format: "%.1f", v) }
}

/// A CGImage's pixels as a flat premultiplied RGBA buffer, redrawn into a known
/// layout so the reads below don't have to handle every possible bitmap format.
private struct Pixels {
    let width: Int
    let height: Int
    private let bytes: [UInt8]

    init?(_ image: CGImage) {
        let w = image.width, h = image.height
        var buffer = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let drawn = buffer.withUnsafeMutableBytes { raw -> Bool in
            guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h,
                                     bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return false }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        width = w
        height = h
        bytes = buffer
    }

    struct Pixel { let r: Int, g: Int, b: Int, a: Int }

    func at(_ x: Int, _ y: Int) -> Pixel {
        let i = (y * width + x) * 4
        return Pixel(r: Int(bytes[i]), g: Int(bytes[i + 1]), b: Int(bytes[i + 2]), a: Int(bytes[i + 3]))
    }

    /// Bounding box of the pixels satisfying `include`, y measured from the TOP so
    /// it lines up with how the art's canvas is described.
    func box(_ include: (Pixel) -> Bool) -> CGRect? {
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where include(at(x, y)) {
                if x < minX { minX = x }; if x > maxX { maxX = x }
                if y < minY { minY = y }; if y > maxY { maxY = y }
            }
        }
        guard maxX >= 0 else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    }

    /// Bounding box of the pixels differing from `other` by more than `tolerance`
    /// in any channel. The tolerance absorbs resampling noise; a glyph's own edges
    /// are far past it.
    func box(comparedTo other: Pixels, differBy tolerance: Int) -> CGRect? {
        guard width == other.width, height == other.height else { return nil }
        return box2 { x, y in
            let p = at(x, y), o = other.at(x, y)
            return abs(p.r - o.r) > tolerance || abs(p.g - o.g) > tolerance
                || abs(p.b - o.b) > tolerance || abs(p.a - o.a) > tolerance
        }
    }

    private func box2(_ include: (Int, Int) -> Bool) -> CGRect? {
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where include(x, y) {
                if x < minX { minX = x }; if x > maxX { maxX = x }
                if y < minY { minY = y }; if y > maxY { maxY = y }
            }
        }
        guard maxX >= 0 else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    }
}
