import * as vscode from "vscode";
import { ClaudeStatusService } from "../claudeStatus";
import { resolveRepoRoot } from "../git";
import { toast } from "../notify";
import { KymBoard } from "./board";
import { KymStore } from "./store";

/**
 * Wire up Keep Your Marbles: the `openBoard` command (launched from the kanban
 * button in the Source Plus title bar). One KymStore per open-folder root,
 * created lazily and reused for the window's lifetime.
 */
export function registerKym(
  context: vscode.ExtensionContext,
  status: ClaudeStatusService
): void {
  const stores = new Map<string, KymStore>();

  context.subscriptions.push(
    vscode.commands.registerCommand("andreysHelper.kym.openBoard", async () => {
      const root = await resolveRepoRoot();
      if (!root) {
        toast("KYM: open a git repository to use the board.", "warning");
        return;
      }
      let store = stores.get(root);
      if (!store) {
        store = new KymStore(root);
        stores.set(root, store);
        context.subscriptions.push(store);
      }
      KymBoard.show(context, store, status);
    })
  );
}
