// Live re-read of `~/.andreys-helper/config.json` when someone else edits it.
//
// The extension owns a few user-facing preferences (today: `moonMode`, written
// from `andreysHelper.orchestrator.moonMode`) and patches them straight into the
// shared config file. This watcher is what turns that into a live change in the
// running app — flip the setting in the editor, the circle re-skins, no relaunch.

import Foundation

/// Fires `onChange` with the freshly-decoded config whenever config.json changes
/// on disk. Main-queue delivery; safe to touch `AppModel` from the handler.
final class ConfigWatcher {
    private let onChange: (Config) -> Void
    private var source: DispatchSourceFileSystemObject?
    private var descriptor: CInt = -1
    private var pending: DispatchWorkItem?
    /// Bytes of the last config we reported, so the app's OWN writes (the
    /// remembered circle position is saved on every move) don't loop back in as
    /// spurious changes.
    private var lastSeen: Data?

    init(onChange: @escaping (Config) -> Void) {
        self.onChange = onChange
    }

    deinit { stop() }

    /// Begin watching. Idempotent; a failure to open the directory is logged and
    /// leaves the app on whatever config it loaded at launch.
    func start() {
        guard source == nil else { return }
        lastSeen = try? Data(contentsOf: Bootstrap.configURL)

        // The DIRECTORY, not the file. `Bootstrap.saveConfig` writes atomically
        // (write to a temp file, then rename over the target), and so does the
        // extension — which unlinks the inode our descriptor would be pinned to,
        // so a file-level watch goes deaf after the very first write.
        let dir = Bootstrap.baseDir.path
        descriptor = open(dir, O_EVTONLY)
        guard descriptor >= 0 else {
            NSLog("AndreysOrchestrator: cannot watch \(dir) (errno \(errno))")
            return
        }

        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor, eventMask: [.write], queue: .main)
        let fd = descriptor
        src.setEventHandler { [weak self] in self?.scheduleReload() }
        src.setCancelHandler { close(fd) }
        source = src
        src.resume()
    }

    func stop() {
        pending?.cancel()
        pending = nil
        source?.cancel()  // the cancel handler closes the descriptor
        source = nil
        descriptor = -1
    }

    /// Coalesce the burst of directory events a single atomic write produces
    /// (temp file created, renamed, old inode unlinked) into one reload.
    private func scheduleReload() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.reload() }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }

    private func reload() {
        guard let data = try? Data(contentsOf: Bootstrap.configURL) else { return }
        guard data != lastSeen else { return }
        lastSeen = data
        guard let config = try? JSONDecoder().decode(Config.self, from: data) else {
            NSLog("AndreysOrchestrator: config.json changed but does not parse — ignoring")
            return
        }
        onChange(config)
    }
}
