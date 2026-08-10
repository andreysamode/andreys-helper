import * as vscode from "vscode";

/**
 * The custom names the user gives worktree rows in the Source Control+ pane
 * ("rename" on a branch header), keyed by worktree root path.
 *
 * These used to live only in the webview's own `vscode.setState`, which made
 * them invisible to everything else in the extension — including the broker
 * snapshot, so the orchestrator could only ever show the branch. Holding them
 * in workspaceState instead keeps them readable while the pane is closed (the
 * webview is disposed with the view) and survives window reloads, which the
 * webview state does only while the view is retained.
 */

const KEY = "andreysHelper.repoNames";

export class RepoNameStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever a name is set or cleared, so publishers can re-emit. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly memento: vscode.Memento) {}

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** All custom names, keyed by worktree root path. */
  all(): Record<string, string> {
    return this.memento.get<Record<string, string>>(KEY, {});
  }

  get(root: string): string | undefined {
    return this.all()[root] || undefined;
  }

  /** Set a custom name, or clear it when `name` is empty/undefined. */
  set(root: string, name: string | undefined): void {
    const next = { ...this.all() };
    if (name) {
      next[root] = name;
    } else {
      delete next[root];
    }
    void this.memento.update(KEY, next);
    this._onDidChange.fire();
  }

  /**
   * Seed from names a webview persisted before this store existed, without
   * clobbering anything already here (the store is authoritative once written).
   */
  seed(names: Record<string, string>): void {
    const current = this.all();
    const merged = { ...names, ...current };
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      void this.memento.update(KEY, merged);
      this._onDidChange.fire();
    }
  }
}
