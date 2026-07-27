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
    public var visibleFrame: CGRect
    public init(displayID: Int?, name: String, visibleFrame: CGRect) {
        self.displayID = displayID
        self.name = name
        self.visibleFrame = visibleFrame
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
    public static let edgeGap: CGFloat = 3

    /// Distance from the screen edge to the circle's center at the drag limit.
    public static func clampRadius(discBox: CGFloat) -> CGFloat { discBox / 2 + edgeGap }

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
        return clampCenter(CGPoint(x: config.x, y: config.y), discBox: discBox, in: screen.visibleFrame)
    }

    public static func defaultCircleCenter(on screen: ScreenDesc?, discBox: CGFloat) -> CGPoint {
        guard let vf = screen?.visibleFrame else { return .zero }
        let r = discBox / 2
        return CGPoint(x: vf.maxX - margin - r, y: vf.maxY - margin - r)
    }

    /// Keep the visible disc (`discBox` across, centered on the point) on-screen
    /// with `edgeGap` to spare.
    public static func clampCenter(_ c: CGPoint, discBox: CGFloat, in vf: CGRect) -> CGPoint {
        let r = clampRadius(discBox: discBox)
        // If the screen is somehow smaller than the box, min-wins keeps it visible.
        let x = min(max(c.x, vf.minX + r), vf.maxX - r)
        let y = min(max(c.y, vf.minY + r), vf.maxY - r)
        return CGPoint(x: x, y: y)
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
