// State-2 session pane (PLAN.md §3): sections = one per window (labeled by
// repo/folder), then worktree/branch groups mirroring the Source+ panel (every
// open worktree shows, even with no active session), then clickable session
// boxes styled like Source+ `.ctab`. Windows stack in a single scrolling column.
// Bottom strip = pending scheduled jobs with a live countdown.

import SwiftUI
import AppKit // NSCursor

struct SessionPaneView: View {
    @ObservedObject var model: AppModel
    static let width: CGFloat = 300

    private var orchestratorOpen: Bool { model.stage == .orchestrator }

    var body: some View {
        VStack(spacing: 0) {
            // Slim header: the orchestrator toggle, then the plan-usage bars. The
            // orchestrator pane opens to the LEFT, so the control lives top-left.
            // (No left/right chevrons — windows aren't paged; they stack below.)
            // The row carries no "Sessions" title: the pane's content says that,
            // and the width is worth more to the usage bars.
            HStack(spacing: 8) {
                Button(action: {
                    orchestratorOpen ? model.closeOrchestrator() : model.openOrchestrator()
                }) {
                    Image(systemName: "terminal")
                        .foregroundColor(orchestratorOpen ? Theme.terracotta : .secondary)
                }
                .buttonStyle(.plain)
                .help(orchestratorOpen ? "Hide orchestrator" : "Open orchestrator")
                QuotaBarsView(snapshot: model.quota)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            // Paints ABOVE the divider and session list. A VStack draws its
            // children in order, so without this the usage bars' hover callout —
            // which hangs below the header, over the content — lands underneath
            // the opaque session rows and is invisible where they overlap.
            .zIndex(1)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if model.tree.windows.isEmpty {
                        Text("No connected windows")
                            .font(.system(size: 12)).foregroundColor(.secondary)
                            .padding(.top, 12)
                    }
                    ForEach(model.tree.windows) { window in
                        WindowSection(window: window, model: model)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()
            PendingStrip(jobs: model.pendingJobs)
        }
        .frame(width: Self.width)
        .background(
            FrostedBackground(cut: .rounded(12))
                // The frost cuts its own corners; this clip is what gives the
                // SHADOW its rounded silhouette (SwiftUI takes the shadow from
                // the clipped alpha). Same shape, so the two can't disagree.
                .clipShape(RoundedRectangle(cornerRadius: 12))
                // Matches the circle, which authors its rim and glyphs at a 56pt
                // design size and scales them to 45pt: the shadow the eye actually
                // sees there is 3 × 45/56, so this bakes the same factor in.
                .shadow(radius: 3 * CircleView.size / CircleView.designSize)
        )
        // Same thin white border as the circle's circumference.
        .overlay(
            RoundedRectangle(cornerRadius: 12).inset(by: 0.5)
                .stroke(Color.white.opacity(0.85), lineWidth: 1)
        )
    }
}

private struct WindowSection: View {
    let window: WindowNode
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(window.repoName)
                .font(.system(size: 13, weight: .bold))
            ForEach(window.worktrees) { wt in
                VStack(alignment: .leading, spacing: 4) {
                    WorktreeHeader(wt: wt)
                    // Every open worktree is listed (mirrors Source+); ones with
                    // no active session simply show the branch header alone.
                    ForEach(wt.sessions) { session in
                        SessionBox(session: session, windowUpfront: window.isUpfront) {
                            model.reveal(session)
                        }
                    }
                }
                .padding(.leading, 6)
            }
        }
    }
}

/// Branch header for a worktree — icon + branch + ahead/behind, like Source+.
private struct WorktreeHeader: View {
    let wt: WorktreeNode

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: wt.isTrunk ? "house.fill" : "arrow.triangle.branch")
                .font(.system(size: 10)).foregroundColor(.secondary)
            Text(wt.branch.isEmpty ? wt.name : wt.branch)
                .font(.system(size: 11, weight: .medium)).foregroundColor(.secondary)
                .lineLimit(1).truncationMode(.middle)
            if wt.ahead > 0 {
                Text("↑\(wt.ahead)").font(.system(size: 10)).foregroundColor(.secondary)
            }
            if wt.behind > 0 {
                Text("↓\(wt.behind)").font(.system(size: 10)).foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }
    }
}

/// A session box styled like the Source+ `.ctab`: bordered rounded row, 16pt
/// status slot, 13px title. Three states (PLAN.md §3):
///   1. inactive — the tab isn't active in its window: muted outline, warm fill,
///      normal text.
///   2. window-active — active tab of a window that ISN'T frontmost: single
///      terracotta outline only; same fill and text as inactive.
///   3. upfront — active tab of the frontmost window: full accent — double
///      terracotta border, cream fill, terracotta text.
/// The terracotta border is reserved as a state indicator, so hover does NOT
/// change the border — it only shows the pointing-hand cursor (the box is
/// clickable).
private struct SessionBox: View {
    let session: SessionInfo
    /// Whether this session's window is the frontmost/upfront editor window.
    let windowUpfront: Bool
    let onReveal: () -> Void

    // The rule itself lives on `SessionVisual` (Aggregator.swift) so the reveal
    // self-test can assert exactly what gets drawn here.
    private var visual: SessionVisual { .of(session, windowUpfront: windowUpfront) }

    var body: some View {
        HStack(spacing: 6) {
            // Title first (flex:1), status icon on the RIGHT — matching the
            // Source+ `.ctab` layout (`.ctitle { flex:1 }` then `.cstat`).
            Text(session.title.isEmpty ? "(untitled)" : session.title)
                .font(.system(size: 13))
                // Terracotta text only for the upfront active tab (state 3).
                .foregroundColor(visual == .upfront ? Theme.terracotta : .primary)
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            SessionStatusIcon(status: session.status, seen: session.seen)
        }
        .padding(.horizontal, 8).padding(.vertical, 2)
        .frame(minHeight: 22)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Warm cream fill only for the upfront active tab; states 1 & 2 share
        // the same muted fill so state 2 differs from inactive by border only.
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(visual == .upfront ? Theme.boxActiveFill : Theme.boxFill))
        // Upfront row = DOUBLE border: 1px terracotta outer, a bg-gap, then a
        // half-strength terracotta inner stroke (Source+ `.ctab-active`
        // box-shadow). Only state 3 gets the inner stroke.
        .overlay(
            RoundedRectangle(cornerRadius: 2.5).inset(by: 2)
                .stroke(Theme.terracotta.opacity(0.5), lineWidth: 1)
                .opacity(visual == .upfront ? 1 : 0))
        // Outer border: terracotta whenever the tab is active (states 2 & 3);
        // muted outline otherwise. Hover deliberately does NOT affect it — the
        // terracotta border is a state indicator, not a hover affordance.
        .overlay(
            RoundedRectangle(cornerRadius: 4)
                .stroke(visual != .inactive ? Theme.terracotta : Theme.boxBorder,
                        lineWidth: 1))
        // Interaction (click-to-reveal + pointing-hand cursor) is an AppKit view
        // on top rather than a SwiftUI Button: as the top hit view it owns the
        // cursor authoritatively (SwiftUI/window kept resetting it to the arrow),
        // and it accepts first mouse so the click lands even when the panel isn't
        // the key window.
        .overlay(RowInteraction(onReveal: onReveal))
    }
}

/// Transparent AppKit overlay that makes a session row clickable AND shows the
/// pointing-hand cursor. Being the frontmost hit view, its `cursorUpdate` wins;
/// `acceptsFirstMouse` makes the first click count in the non-activating panel.
private struct RowInteraction: NSViewRepresentable {
    let onReveal: () -> Void

    func makeNSView(context: Context) -> NSView {
        let v = InteractionView(); v.onReveal = onReveal; return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? InteractionView)?.onReveal = onReveal
    }

    private final class InteractionView: NSView {
        var onReveal: (() -> Void)?

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            trackingAreas.forEach(removeTrackingArea)
            // `.cursorUpdate` re-asserts the pointing hand on every move inside
            // (winning the per-move race with SwiftUI); `.mouseEnteredAndExited`
            // resets it on the way out so it can't leak onto the rest of the pane.
            addTrackingArea(NSTrackingArea(
                rect: .zero,
                options: [.cursorUpdate, .mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                owner: self, userInfo: nil))
        }
        override func cursorUpdate(with event: NSEvent) { NSCursor.pointingHand.set() }
        override func mouseEntered(with event: NSEvent) {
            // Deliberately does NOT key the panel. macOS only honors cursor
            // changes for the key window, so keying here did give the row a
            // pointing hand — at the cost of the panel swallowing every keystroke
            // meant for the editor for as long as it stayed key (a key
            // `.nonactivatingPanel` receives input without its app being
            // frontmost; measured directly). Typing into the session you just
            // revealed matters more than the cursor shape, so the pointer stays
            // an arrow over the pane. The row is still fully clickable.
            NSCursor.pointingHand.set()
        }
        override func mouseExited(with event: NSEvent) { NSCursor.arrow.set() }

        // Swallow the down; reveal on mouse-up if it lands inside (a real click).
        override func mouseDown(with event: NSEvent) {}
        override func mouseUp(with event: NSEvent) {
            if bounds.contains(convert(event.locationInWindow, from: nil)) { onReveal?() }
        }
    }
}

/// Bottom strip: pending scheduled jobs with a live countdown ("XYZ in 10 mins").
private struct PendingStrip: View {
    let jobs: [Job]
    @State private var now = Date()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()

    private func countdown(_ job: Job) -> String {
        switch job.trigger.type {
        case .completion: return "on completion"
        case .time, .interval:
            guard let fire = Self.iso.date(from: job.nextFireAt) else { return "" }
            let secs = Int(fire.timeIntervalSince(now).rounded())
            if secs <= 0 { return "overdue" }
            if secs < 60 { return "in \(secs)s" }
            if secs < 3600 { return "in \(secs / 60) min" }
            return "in \(secs / 3600) h"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if jobs.isEmpty {
                Text("No pending jobs").font(.system(size: 11)).foregroundColor(.secondary)
            } else {
                ForEach(jobs, id: \.id) { job in
                    HStack {
                        Text(job.label).font(.system(size: 11))
                        Spacer()
                        Text(countdown(job)).font(.system(size: 11)).foregroundColor(.secondary)
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onReceive(timer) { now = $0 }
    }
}
