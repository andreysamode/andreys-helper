// `--render-circle <path>` — draw the circle, in every state it has, to a PNG.
//
// The HUD is a floating accessory panel and does NOT composite into
// `screencapture`, so the only way to actually LOOK at a change to `CircleView`
// is to render it offscreen. This produces a contact sheet: moon mode across the
// top, the frosted original underneath, one tile per state.
//
// Caveat worth knowing before reading the output: `FrostedBackground` is an
// `NSViewRepresentable` wrapping a `.behindWindow` vibrancy view, and neither
// SwiftUI's `ImageRenderer` nor anything else offscreen can composite a backdrop
// that isn't there. The frosted tiles therefore show their border, dashes, and
// glyphs over the bare backdrop, with no disc. Moon mode is an opaque bitmap and
// renders exactly as it ships.

import AppKit
import SwiftUI

enum CircleRender {
    /// The states worth eyeballing, in the order they appear on the sheet.
    private static let cases: [(label: String, state: CircleState)] = [
        ("idle", CircleState(category: .idle, count: 0, alertCount: 0)),
        ("working 1", CircleState(category: .working, count: 1, alertCount: 0, workingCount: 1)),
        ("working 3", CircleState(category: .working, count: 3, alertCount: 0, workingCount: 3)),
        ("working 5", CircleState(category: .working, count: 5, alertCount: 0, workingCount: 5)),
        ("asking", CircleState(category: .needsInput, count: 1, alertCount: 0, needsInputCount: 1)),
        (
            "asking + done + working",
            CircleState(
                category: .needsInput, count: 1, alertCount: 0,
                workingCount: 2, needsInputCount: 1, doneUnseenCount: 1)
        ),
        ("done", CircleState(category: .doneUnseen, count: 1, alertCount: 0, doneUnseenCount: 1)),
        ("alert", CircleState(category: .alert, count: 2, alertCount: 2)),
    ]

    @MainActor
    static func run(path: String, scale: CGFloat = 6) -> Bool {
        let renderer = ImageRenderer(content: Sheet(cases: cases))
        // Far past retina by default — this sheet is for READING the artwork,
        // and the rim stars and their trails are a couple of points across at
        // the parked size. Everything on the circle is vector except the moon
        // bitmap, so the detail is really there to be had; pass a bigger scale
        // when working on the small stuff.
        renderer.scale = scale
        guard let image = renderer.nsImage,
            let tiff = image.tiffRepresentation,
            let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:])
        else {
            print("render-circle: could not rasterise the sheet")
            return false
        }
        do {
            try png.write(to: URL(fileURLWithPath: path))
        } catch {
            print("render-circle: \(error)")
            return false
        }
        print("render-circle: wrote \(path) (\(rep.pixelsWide)×\(rep.pixelsHigh)), moon art \(MoonArt.isAvailable ? "loaded" : "MISSING")")
        return MoonArt.isAvailable
    }

    /// One row per skin, one column per state.
    private struct Sheet: View {
        let cases: [(label: String, state: CircleState)]

        var body: some View {
            VStack(alignment: .leading, spacing: 18) {
                row(title: "moon mode", moon: true)
                row(title: "default (frost cannot render offscreen)", moon: false)
            }
            .padding(20)
            .background(
                // Something with light and dark areas, so a white border and a
                // half-black glyph outline can both be judged.
                LinearGradient(
                    colors: [Color(white: 0.13), Color(white: 0.62)],
                    startPoint: .topLeading, endPoint: .bottomTrailing))
        }

        private func row(title: String, moon: Bool) -> some View {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.system(size: 11, weight: .semibold)).foregroundColor(.white)
                HStack(alignment: .top, spacing: 16) {
                    ForEach(cases.indices, id: \.self) { i in
                        VStack(spacing: 6) {
                            CircleView(model: model(cases[i].state, moon: moon))
                            Text(cases[i].label)
                                .font(.system(size: 8))
                                .foregroundColor(.white.opacity(0.75))
                                .frame(width: 62)
                                .multilineTextAlignment(.center)
                        }
                    }
                }
            }
        }

        private func model(_ state: CircleState, moon: Bool) -> AppModel {
            let m = AppModel()
            m.circleState = state
            m.moonMode = moon
            return m
        }
    }
}
