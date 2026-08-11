// RootView — assembles the three §3 stages. The circle is pinned to a screen
// corner; the panes unfold AWAY from it toward whichever side has room, chosen by
// PanelController (model.panesLeft / model.contentDown). The session pane is
// always adjacent to the circle; the orchestrator sits on the outside.
//
// NB: this view deliberately does NOT track hover. Hover is decided from the
// pointer's position against the visible regions in `PanelController` — see
// "Pointer-truth hover" there for why an `onHover` could not close the pane
// reliably.

import SwiftUI

struct RootView: View {
    @ObservedObject var model: AppModel

    private var frameAlignment: Alignment {
        // Zoomed, the window is a square built around the moon and the window
        // itself is centred on the parked spot — so the moon centres in it too.
        // Cornering it here would push the star tips off two of the four sides.
        if model.moonZoomed { return .center }
        switch (model.panesLeft, model.contentDown) {
        case (true, true): return .topTrailing
        case (true, false): return .bottomTrailing
        case (false, true): return .topLeading
        case (false, false): return .bottomLeading
        }
    }

    var body: some View {
        // NO layout animation on `model.stage`: the hosting NSPanel resizes
        // instantly with the circle's corner pinned, so the circle is already in
        // its final spot every frame (animating the content made it slide).
        HStack(alignment: model.contentDown ? .top : .bottom, spacing: 8) {
            if model.panesLeft {
                orchestratorPane
                sessionPane
                circleColumn
            } else {
                circleColumn
                sessionPane
                orchestratorPane
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: frameAlignment)
        .padding(8)
    }

    /// The bubble is anchored beside a 45pt disc; the zoomed moon leaves it
    /// nowhere to sit, and the window sized for the moon has no room for it
    /// either. The "!" stays on the moon, and a click unzooms.
    private var showBubble: Bool { model.showAlertBubble && !model.moonZoomed }

    /// Circle + its alert bubble. The bubble sits on the far side from where the
    /// content grows: below the circle when growing down, above when growing up.
    private var circleColumn: some View {
        VStack(alignment: model.panesLeft ? .trailing : .leading, spacing: 8) {
            if !model.contentDown, showBubble {
                AlertBubble(model: model)
            }
            CircleView(model: model)
            if model.contentDown, showBubble {
                AlertBubble(model: model)
            }
        }
    }

    @ViewBuilder private var sessionPane: some View {
        if model.stage == .session || model.stage == .orchestrator {
            SessionPaneView(model: model)
        }
    }

    @ViewBuilder private var orchestratorPane: some View {
        if model.stage == .orchestrator {
            OrchestratorPaneView(model: model)
        }
    }
}
