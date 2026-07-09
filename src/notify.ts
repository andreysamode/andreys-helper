import * as vscode from "vscode";

type ToastKind = "info" | "warning" | "error";

// VS Code auto-hides info/warning toasts but keeps error toasts (and any toast
// with buttons) on screen until dismissed. To make every status message behave
// like a transient toast, we render it as a self-closing progress notification.
export function toast(message: string, kind: ToastKind = "info", ms = 2000): void {
  const icon = kind === "error" ? "$(error) " : kind === "warning" ? "$(warning) " : "";
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: icon + message },
    () => new Promise<void>((resolve) => setTimeout(resolve, ms))
  );
}
