# AndreysOrchestrator — Integration & manual verification

End-to-end wiring (W8) and the orchestrator host (W5). This doc covers what can be
verified headlessly (self-tests) and the manual steps for the live GUI path that a
non-interactive environment cannot drive (real Cursor window ↔ broker ↔ circle,
click-to-focus, orchestrator terminals).

## Components

```
Cursor window (extension)  ──WS(hello+snapshot / commands)──┐
                                                            ▼
ah CLI  ──WS-upgrade token (x-ah-token header + ?token=) ── Broker (:47615)
                                                            │  ├─ registry + aggregation → Circle UI
                                                            │  ├─ query verbs (windows/sessions/openWindow/schedule/alert)
                                                            │  └─ routed verbs (reveal/interrupt/sendPrompt/spawnSession/createWorktree)
                                                            ▼
                                                          Daemon (jobs, alerts)
Orchestrator host: N embedded SwiftTerm `claude` tabs in ~/.andreys-helper/orchestrator
```

Shared state lives in `~/.andreys-helper/`: `config.json` (port 47615, repoScanDirs,
orchestrator.workspace) and `token` (0600, generated on first run). The app, the
extension, and `ah` all read these.

## Auth model (§9.3)

- **Extension** connects plain WS and authenticates with the token in the `hello`
  message body (unchanged).
- **`ah` CLI / tools** authenticate at the WS *upgrade*: the token is sent both as
  the `x-ah-token` request header **and** the `?token=` query param. A
  `TokenPeekFramer` sits just below `NWProtocolWebSocket`, reads the raw HTTP
  upgrade request (Network.framework does not surface it otherwise), validates the
  token, and marks the connection a trusted CLI. Only trusted connections may issue
  broker commands; everyone else must `hello`. Wrong/absent tokens are rejected.

## Headless self-tests (run these first)

```bash
cd orchestrator
swift build
swift run AndreysOrchestrator --selftest       # W3 broker + W4 daemon unit checks
swift run AndreysOrchestrator --selftest-e2e   # W8: real `ah` binary ↔ real broker ↔ mock extension
swift run AndreysOrchestrator --selftest-orch  # W5: orchestrator tab spawns a real process + lifecycle
```

`--selftest-e2e` builds the CLI (`npm run build:cli`), boots the real broker,
connects a mock extension client with a canned snapshot, then drives the built
`node dist/ah.js` against the broker via `AH_PORT`/`AH_TOKEN` and asserts:
`ah windows` lists the window, `ah sessions` (+ `--repo` filter) lists the sessions,
`ah reveal <id>` routes to the mock and is acked, `ah alert` reaches the daemon, and
a wrong token is rejected.

## Manual GUI verification (needs a real display + Cursor)

The live GUI path cannot be driven in a non-interactive environment; verify it by
hand:

1. **Run the app.** `swift run AndreysOrchestrator` (or build a release binary). A borderless
   always-on-top circle appears top-right. ⌘Q quits.
2. **Install/patch the extension** in Cursor so it connects to the broker:
   - `npm run build` (bundles `dist/extension.js`), then install the VSIX / dev
     extension into Cursor and reload the window. The extension reads the same
     `~/.andreys-helper/{config.json,token}` and connects to `ws://127.0.0.1:47615`.
   - Open a repo with a Claude tab. The extension sends `hello` + `snapshot`.
3. **Observe the circle.** With a session in `question|plan|permission` the circle
   shows `?` + count; `done`-unseen shows `✓` + count; `working` shows the rim
   spinner (no number); an alert shows `!`. Hover the circle → the session pane
   slides out (window → worktree → session boxes).
4. **Click-to-focus.** Click a session box → the folder's Cursor window is
   foregrounded and the tab revealed (marks it seen; the circle recomputes).
5. **`ah` from a terminal** (same machine): `node orchestrator/../dist/ah.js windows`,
   `... sessions`, `... reveal <sessionId>`. Each returns JSON; `reveal` foregrounds
   the window.
6. **Orchestrator (state 3).** Click the `>` expander in the session pane → the
   orchestrator opens further left with a `[orch 1] [+]` tab bar and an embedded
   `claude` terminal running in `~/.andreys-helper/orchestrator`.
   - `+` adds an independent orchestrator (its own PTY + `claude` + conversation).
   - Each tab has a close (`x`); a green dot marks a running tab.
   - **State 3 stays open while any tab is running** (its running dot is green);
     closing the **last** tab collapses back to the session pane.
   - **Drag a screenshot** onto the terminal area → its file path is inserted into
     the active `claude` prompt.
   - If `claude` is not on PATH, the tab shows a graceful in-terminal message and
     drops to a login shell (no crash).

## Phase 3 manual verification

Phase 3 (polish) added alert-ack, live pending countdowns, launch-at-login, `.app`
packaging, `ah` install-to-PATH, an onboarding/settings window, and robust
multi-monitor position persistence. What can be checked headlessly is covered by
self-tests; the rest needs a real display / packaged app.

### Headless (already run, all green)

```bash
cd orchestrator
swift build
swift run AndreysOrchestrator --selftest         # W3 broker + W4 daemon (unchanged)
swift run AndreysOrchestrator --selftest-orch    # W5 orchestrator host (unchanged)
swift run AndreysOrchestrator --selftest-e2e     # W8 real ah ↔ broker (unchanged)
swift run AndreysOrchestrator --selftest-alerts  # NEW: fire → ack → CircleState re-derivation
                                       #      + multi-monitor placement (item 7)
```

`--selftest-alerts` asserts: a fired alert flips the circle to `!` with the queued
count; a second alert bumps the count to 2; acking one leaves `!`+1; acking the
**last** alert empties the queue and the category falls back per §4 precedence
(here `done-unseen`). It also asserts `PanelPlacement`: restore onto the saved
`displayID`, fall back to main + clamp when the monitor is absent, clamp an
off-screen point on-screen, and resolve a legacy name-only config.

### Packaging (item 4)

```bash
orchestrator/scripts/build-app.sh          # → orchestrator/build/AndreysOrchestrator.app
codesign --verify --verbose orchestrator/build/AndreysOrchestrator.app   # "valid on disk"
```

The bundle is **ad-hoc signed** (`codesign -s -`), which is enough to launch
locally (`open orchestrator/build/AndreysOrchestrator.app`). `spctl --assess` intentionally
reports **rejected** — the bundle is not signed for distribution. `LSUIElement` is
set so there is no dock icon (matches the `.accessory` activation policy). The `ah`
CLI is bundled as `Contents/Resources/ah.js` + a symlink-resolving `ah` wrapper.

**Manual-only — real distribution signing/notarization** (no Developer ID identity
exists on this machine, so this was NOT attempted):

1. Obtain an Apple Developer ID Application certificate; install it in the login
   keychain.
2. Re-sign with hardened runtime:
   `codesign --force --deep --options runtime --timestamp -s "Developer ID Application: <NAME> (<TEAMID>)" orchestrator/build/AndreysOrchestrator.app`
3. Notarize: `xcrun notarytool submit orchestrator/build/AndreysOrchestrator.app --apple-id <id> --team-id <TEAMID> --password <app-specific-pw> --wait`, then `xcrun stapler staple orchestrator/build/AndreysOrchestrator.app`.
4. Verify: `spctl --assess --type execute -v` should then report *accepted*.

### `ah` install-to-PATH (item 5)

```bash
swift run AndreysOrchestrator --install-ah        # non-bundled: generates a wrapper in
                                        #   ~/.andreys-helper/bin and symlinks it
# or, from the packaged app:
orchestrator/build/AndreysOrchestrator.app/Contents/MacOS/AndreysOrchestrator --install-ah
ah help                                 # → JSON list of verbs
```

Installs to `/usr/local/bin/ah` when writable, else falls back to
`~/.andreys-helper/bin/ah` and prints a PATH hint. The in-app equivalent is the
"Install `ah` CLI" button in Settings. **Verified:** both paths install and
`ah help` resolves on PATH and returns the verb list. The current install points
`/usr/local/bin/ah` → the packaged app's bundled wrapper.

### Manual-only (needs a real display)

1. **Alert bubble & ack.** Push an alert: `ah alert "build finished"`. The circle
   turns red `!` with the count and the bubble auto-appears near the circle. Click
   a row (or the circle to toggle the bubble) → the alert clears, the count
   decrements, and when the last alert is acked the circle falls back to the next
   §4 category. Multiple alerts stack in the bubble, one row each.
2. **Pending-strip live countdown.** Schedule a job (`ah schedule …`) and watch the
   bottom strip of the session pane tick every second — "in 45s" → "in 10 min" →
   "in 2 h" → "overdue".
3. **Onboarding / settings.** Right-click the circle → "Settings…" (or ⌘, from the
   menu). Add/remove `repoScanDirs`, toggle launch-at-login, click "Install `ah`".
   Changes persist to `~/.andreys-helper/config.json`.
4. **Launch-at-login (item 3).** Only works from the packaged `AndreysOrchestrator.app`
   (`SMAppService.mainApp`). Toggle it on in Settings, confirm it appears in
   System Settings → General → Login Items; toggle off to remove. Under `swift run`
   the toggle is disabled and registration no-ops (guarded by `LoginItem.isBundled`).
5. **Multi-monitor persistence (item 7).** With two displays, drag the circle to the
   secondary monitor and quit (⌘Q). Relaunch → it returns to the same monitor +
   corner (persisted by `CGDirectDisplayID`, not index/name alone). Unplug that
   monitor and relaunch → it falls back to the main screen, clamped on-screen.

## Notes

- macOS has no `timeout(1)`; the self-tests are self-bounding and exit on their own.
- The orchestrator seeds `~/.andreys-helper/orchestrator/CLAUDE.md` from
  `orchestrator/orchestrator-workspace/CLAUDE.md` (authored by W7) on first use; if that
  manual is absent it just creates the workspace dir and no-ops.
