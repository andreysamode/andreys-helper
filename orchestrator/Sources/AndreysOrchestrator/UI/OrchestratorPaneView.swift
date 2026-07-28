// State-3 orchestrator container (PLAN.md §3, §8 W5). Tab bar (`[orch N] … [+]`)
// over an embedded SwiftTerm `claude` terminal for the active tab. Tabs are
// independently closable; closing the last one collapses state-3 back to the
// session pane. State-3 stays open while any tab runs (driven by
// `model.hasRunningOrchestrator` via `Orchestrator.onRunningChanged`).
//
// Screenshots / files dropped on the terminal area have their path inserted into
// the running `claude` (§3 "drag screenshots in").

import AppKit
import SwiftTerm
import SwiftUI

struct OrchestratorPaneView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var orchestrator: Orchestrator
    static let width: CGFloat = 340

    init(model: AppModel) {
        self._model = ObservedObject(wrappedValue: model)
        self._orchestrator = ObservedObject(wrappedValue: model.orchestrator)
    }

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Divider()
            terminalArea
        }
        .frame(width: Self.width)
        .background(FrostedBackground(cut: .rounded(12)))
        .onAppear { orchestrator.ensureStarted() }
    }

    // MARK: Tab bar

    private var tabBar: some View {
        HStack(spacing: 6) {
            Button(action: { model.closeOrchestrator() }) {
                Image(systemName: "chevron.right")
            }
            .buttonStyle(.plain)
            .help("Collapse orchestrator")

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(orchestrator.tabs) { tab in
                        tabChip(tab)
                    }
                }
            }

            Button(action: { orchestrator.addTab() }) {
                Image(systemName: "plus")
            }
            .buttonStyle(.plain)
            .help("New orchestrator")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private func tabChip(_ tab: OrchestratorTab) -> some View {
        let isActive = orchestrator.activeTabId == tab.id
        return HStack(spacing: 4) {
            Circle()
                .fill(tab.running ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 6, height: 6)
            Text(tab.title)
                .font(.system(size: 11, weight: isActive ? .semibold : .regular))
            Button(action: { closeTab(tab.id) }) {
                Image(systemName: "xmark").font(.system(size: 8))
            }
            .buttonStyle(.plain)
            .help("Close \(tab.title)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            (isActive ? Color.primary.opacity(0.14) : Color.primary.opacity(0.05)),
            in: RoundedRectangle(cornerRadius: 5))
        .contentShape(Rectangle())
        .onTapGesture { orchestrator.activate(tab.id) }
    }

    private func closeTab(_ id: Int) {
        orchestrator.closeTab(id)
        // Closing the last tab collapses state-3 to the session pane (§3).
        if orchestrator.isEmpty { model.closeOrchestrator() }
    }

    // MARK: Terminal area

    private var terminalArea: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.9))
            if orchestrator.tabs.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "terminal").font(.system(size: 28)).foregroundColor(.secondary)
                    Text("No orchestrator — press +").font(.system(size: 11)).foregroundColor(.secondary)
                }
            } else {
                OrchestratorTerminalArea(orchestrator: orchestrator)
                    .padding(4)
            }
        }
        .padding(8)
    }
}

// MARK: - Embedded terminal host + drag-in

/// Hosts the active tab's `LocalProcessTerminalView` and accepts file drops,
/// inserting the dropped path into the active `claude` (§3). All tab terminals
/// stay alive (retained by `Orchestrator`); only the active one is in the view
/// hierarchy at a time.
private struct OrchestratorTerminalArea: NSViewRepresentable {
    let orchestrator: Orchestrator

    func makeNSView(context: Context) -> TerminalDropView {
        let view = TerminalDropView()
        view.onDropPath = { [weak orchestrator] path in
            orchestrator?.insertPath(path)
        }
        return view
    }

    func updateNSView(_ nsView: TerminalDropView, context: Context) {
        nsView.setActiveTerminal(orchestrator.activeTab?.terminal)
    }
}

/// Container NSView that swaps in the active terminal and handles screenshot/file
/// drops. Lays the hosted terminal out to fill its bounds.
final class TerminalDropView: NSView {
    var onDropPath: ((String) -> Void)?
    private weak var current: NSView?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    func setActiveTerminal(_ terminal: NSView?) {
        guard current !== terminal else { return }
        current?.removeFromSuperview()
        current = terminal
        if let terminal {
            terminal.frame = bounds
            terminal.autoresizingMask = [.width, .height]
            addSubview(terminal)
        }
    }

    override func layout() {
        super.layout()
        current?.frame = bounds
    }

    // Drag destination — accept file URLs (e.g. a screenshot).
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: nil) ? .copy : []
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
            !urls.isEmpty
        else { return false }
        for url in urls { onDropPath?(url.path) }
        return true
    }
}
