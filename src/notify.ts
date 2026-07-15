import * as vscode from "vscode";

type ToastKind = "info" | "warning" | "error";

// VS Code auto-hides info/warning toasts but keeps error toasts (and any toast
// with buttons) on screen until dismissed. To make every status message behave
// like a transient toast, we render it as a self-closing progress notification.
export function toast(message: string, kind: ToastKind = "info", ms = 2000): void {
  // Errors persist until dismissed — they usually need action, and the native
  // error notification carries its own icon/severity styling.
  if (kind === "error") {
    void vscode.window.showErrorMessage(message);
    return;
  }
  // Info/warning stay transient. A ProgressLocation.Notification title is a
  // plain label — it does NOT parse `$(codicon)` syntax (that only renders in
  // showInformationMessage & friends), so use a plain glyph, not "$(warning)".
  const icon = kind === "warning" ? "⚠ " : "";
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: icon + message },
    () => new Promise<void>((resolve) => setTimeout(resolve, ms))
  );
}
