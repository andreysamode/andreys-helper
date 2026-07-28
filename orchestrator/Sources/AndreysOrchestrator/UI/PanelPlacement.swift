// Multi-monitor circle placement (PLAN.md §3 "window remembers its screen +
// position"; Phase 3, item 7).
//
// Pure geometry so it is unit-testable without a live display: given the saved
// `CircleConfig`, the window size, and a description of the currently-attached
// screens, it resolves the top-right anchor point — restoring onto the correct
// monitor by `displayID` (robust across re-ordering), falling back to screen name,
// then to the main screen, and always clamping the window fully on-screen so a
// monitor that is no longer present cannot strand the circle off-screen.

import CoreGraphics

/// Minimal screen descriptor (decoupled from `NSScreen` for testing).
public struct ScreenDesc: Sendable {
    public var displayID: Int?
    public var name: String
    /// The whole display, Dock and menu bar included.
    public var frame: CGRect
    /// What macOS considers usable — `frame` minus the menu bar and the Dock.
    public var visibleFrame: CGRect
    /// The camera-housing cutout at the top centre, if this display has one.
    public var notch: CGRect?
    public init(
        displayID: Int?, name: String, frame: CGRect? = nil, visibleFrame: CGRect,
        notch: CGRect? = nil
    ) {
        self.displayID = displayID
        self.name = name
        self.frame = frame ?? visibleFrame
        self.visibleFrame = visibleFrame
        self.notch = notch
    }

    /// Where the circle may be parked — see `PanelPlacement.ParkRegion`.
    public var parkRegion: PanelPlacement.ParkRegion {
        PanelPlacement.ParkRegion(bounds: frame, notch: notch)
    }
}

public enum PanelPlacement {
    /// Gap between the circle and the screen edge at its DEFAULT placement.
    public static let margin: CGFloat = 10

    /// Gap kept between the visible disc and the screen edge when the circle is
    /// dragged into a corner — the closest the user can park it. Measured from
    /// the disc, not the window box: the box carries 8pt of transparent padding
    /// for the pane shadows, and clamping on the box turned that padding into an
    /// invisible margin the drag could never cross.
    ///
    /// Zero, deliberately. The point of parking in a corner is that the corner
    /// is a target you cannot miss: flick the pointer at it, the pointer stops
    /// at the edge, and the circle is under it. Any gap at all breaks that —
    /// a slammed pointer lands in the dead band beside the disc and the pane
    /// never opens, which is exactly the "I have to aim for it" report.
    public static let edgeGap: CGFloat = 0

    /// Distance from the screen edge to the circle's center at the drag limit.
    public static func clampRadius(discBox: CGFloat) -> CGFloat { discBox / 2 + edgeGap }

    /// Where the circle's disc may be parked.
    ///
    /// `bounds` is the WHOLE display, not `visibleFrame`: both of the strips macOS
    /// reserves — the Dock's and the menu bar's — are parkable, because the panel
    /// floats above them both (see `PanelController`'s level). Honouring those
    /// insets is what kept the drag limit tens of points shy of the top and bottom
    /// edges, and an edge you cannot actually reach is an unmissable target lost:
    /// a circle parked flush in a corner is found by flicking the pointer there,
    /// with no aiming, because the pointer stops exactly where the circle is.
    ///
    /// `notch` is the one part of the glass that is out of bounds, and not by
    /// convention — there are no pixels behind the camera housing, so a disc parked
    /// there would come out sliced. It is excluded by `clampCenter`, which dips the
    /// circle just below the cutout while it is horizontally inside it.
    public struct ParkRegion: Sendable {
        public var bounds: CGRect
        public var notch: CGRect?
        public init(bounds: CGRect, notch: CGRect? = nil) {
            self.bounds = bounds
            self.notch = notch
        }
    }

    /// Bounds for the whole window box, given the park region and the transparent
    /// padding the box carries around its content. The pad is allowed to hang off
    /// the screen — it has to, or clamping the box would shove the disc back
    /// inside by exactly that much (the old 8pt gap in the corners).
    public static func windowBounds(parkFrame pf: CGRect, pad: CGFloat) -> CGRect {
        pf.insetBy(dx: -pad, dy: -pad)
    }

    /// The notch of a display whose menu bar is split around a camera housing,
    /// derived from the two auxiliary areas macOS reports beside it (nil when the
    /// display has none, i.e. when either area is missing).
    public static func notch(auxTopLeft: CGRect?, auxTopRight: CGRect?) -> CGRect? {
        guard let l = auxTopLeft, let r = auxTopRight, r.minX > l.maxX else { return nil }
        return CGRect(x: l.maxX, y: l.minY, width: r.minX - l.maxX, height: l.height)
    }

    /// Resolve the top-right anchor for the panel. `mainIndex` is the index of the
    /// main screen within `screens` (or nil → first).
    public static func resolveAnchor(
        config: CircleConfig, size: CGSize, screens: [ScreenDesc], mainIndex: Int?
    ) -> CGPoint {
        let main = screens.indices.contains(mainIndex ?? -1)
            ? screens[mainIndex!]
            : screens.first
        // No saved placement → default to the top-right of the main screen.
        let hasSaved = !(config.screen.isEmpty && config.displayID == nil)
                       && !(config.x == 0 && config.y == 0)
        guard hasSaved else { return defaultAnchor(on: main) }

        // Find the saved screen: displayID first, then name.
        let target: ScreenDesc? =
            screens.first(where: { config.displayID != nil && $0.displayID == config.displayID })
            ?? screens.first(where: { !config.screen.isEmpty && $0.name == config.screen })

        guard let screen = target else {
            // The saved monitor is gone → fall back to the main screen, top-right.
            return defaultAnchor(on: main)
        }
        return clamp(CGPoint(x: config.x, y: config.y), size: size, in: screen.visibleFrame)
    }

    /// Top-right of a screen with a margin (default placement).
    public static func defaultAnchor(on screen: ScreenDesc?) -> CGPoint {
        guard let vf = screen?.visibleFrame else { return .zero }
        return CGPoint(x: vf.maxX - margin, y: vf.maxY - margin)
    }

    // MARK: - Circle-center placement + corner-aware unfolding

    /// Resolve the circle CENTER (screen coords) from saved config — restoring
    /// onto the right monitor (displayID → name → main) and clamping the circle
    /// box fully on-screen. Default = top-right of the main screen.
    public static func resolveCircleCenter(
        config: CircleConfig, discBox: CGFloat, screens: [ScreenDesc], mainIndex: Int?
    ) -> CGPoint {
        let main = screens.indices.contains(mainIndex ?? -1) ? screens[mainIndex!] : screens.first
        let hasSaved = !(config.screen.isEmpty && config.displayID == nil)
                       && !(config.x == 0 && config.y == 0)
        guard hasSaved else { return defaultCircleCenter(on: main, discBox: discBox) }
        let target =
            screens.first(where: { config.displayID != nil && $0.displayID == config.displayID })
            ?? screens.first(where: { !config.screen.isEmpty && $0.name == config.screen })
        guard let screen = target else { return defaultCircleCenter(on: main, discBox: discBox) }
        return clampCenter(CGPoint(x: config.x, y: config.y), discBox: discBox, in: screen.parkRegion)
    }

    public static func defaultCircleCenter(on screen: ScreenDesc?, discBox: CGFloat) -> CGPoint {
        guard let vf = screen?.visibleFrame else { return .zero }
        let r = discBox / 2
        return CGPoint(x: vf.maxX - margin - r, y: vf.maxY - margin - r)
    }

    /// Keep the visible disc (`discBox` across, centered on the point) inside
    /// `vf` — pass a park region's `bounds` to let it park flush to the edge.
    public static func clampCenter(_ c: CGPoint, discBox: CGFloat, in vf: CGRect) -> CGPoint {
        let r = clampRadius(discBox: discBox)
        // If the screen is somehow smaller than the box, min-wins keeps it visible.
        let x = min(max(c.x, vf.minX + r), vf.maxX - r)
        let y = min(max(c.y, vf.minY + r), vf.maxY - r)
        return CGPoint(x: x, y: y)
    }

    /// The drag limit: clamp the disc into a park region, keeping it out of the
    /// display's notch.
    ///
    /// Horizontal first, then vertical, because on a notched display the ceiling
    /// depends on where the circle is horizontally: flush with the top edge out on
    /// the wings, and a notch's height lower while the disc is under the cutout.
    /// Dragging along the top edge therefore dips the circle below the camera
    /// housing and lifts it back afterwards, which is both self-explanatory on
    /// screen and the only way it stays whole.
    public static func clampCenter(_ c: CGPoint, discBox: CGFloat, in region: ParkRegion) -> CGPoint {
        var p = clampCenter(c, discBox: discBox, in: region.bounds)
        guard let notch = region.notch, !notch.isEmpty else { return p }
        let r = clampRadius(discBox: discBox)
        let overlapsNotch = (p.x + r) > notch.minX && (p.x - r) < notch.maxX
        if overlapsNotch { p.y = min(p.y, notch.minY - r) }
        return p
    }

    /// Choose which way the panes unfold from the circle so the fully-expanded
    /// shape fits: panes to the side with room (left preferred, else right) and
    /// content down if there's room below, else up. `maxContent` is the largest
    /// expanded window size (orchestrator stage). AppKit coords: y grows upward,
    /// so "down" means toward `vf.minY`.
    public static func decideExpansion(
        circleCenter: CGPoint, maxContent: CGSize, circleBox: CGFloat, in vf: CGRect
    ) -> (panesLeft: Bool, contentDown: Bool) {
        let r = circleBox / 2
        let needX = maxContent.width - circleBox
        let roomLeft = (circleCenter.x - r) - vf.minX
        let roomRight = vf.maxX - (circleCenter.x + r)
        let panesLeft = roomLeft >= needX ? true : (roomRight >= needX ? false : roomLeft >= roomRight)

        let needY = maxContent.height - circleBox
        let roomDown = (circleCenter.y - r) - vf.minY
        let roomUp = vf.maxY - (circleCenter.y + r)
        let contentDown = roomDown >= needY ? true : (roomUp >= needY ? false : roomDown >= roomUp)
        return (panesLeft, contentDown)
    }

    /// Clamp a top-right anchor so the whole `size`d window stays within `vf`.
    public static func clamp(_ anchor: CGPoint, size: CGSize, in vf: CGRect) -> CGPoint {
        // Window occupies [anchor.x - w, anchor.x] × [anchor.y - h, anchor.y].
        let minX = vf.minX + size.width
        let maxX = vf.maxX
        let minY = vf.minY + size.height
        let maxY = vf.maxY
        let x = maxX >= minX ? min(max(anchor.x, minX), maxX) : maxX
        let y = maxY >= minY ? min(max(anchor.y, minY), maxY) : maxY
        return CGPoint(x: x, y: y)
    }
}
