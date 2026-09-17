/**
 * Pure ceiling for the herdr background-work promotion (HERDR-BACKGROUND-DETECTION.md
 * §4 Layer 2, consumed by claudeStatus.tabs()).
 *
 * No `vscode` import and no I/O, so the edge logic is unit-testable under
 * `node --test` (bgPromote.test.ts) — same discipline as stepWorkflowTabStatus,
 * whose shape this deliberately mirrors.
 *
 * WHY A CEILING. The process-tree signal answers "does this tab's claude process
 * still have a live tool shell under it?", and promotes a quiet tab back to
 * "working" when it does. That is right for the case it was built for — a
 * `run_in_background` test run or build that the main loop is about to come back
 * and report on. It is WRONG, with no way out, for a shell that never exits:
 *
 *   Session "Fix triple dot menu position in input fields" (2026-08-18) launched
 *     until grep -qE "Storybook … started|…" sb.log; do sleep 2; done
 *   in the background to wait for a Storybook boot. Storybook was then killed and
 *   restarted onto a different log, so the pattern never matched. The loop was still
 *   spinning 19 minutes later — long after the session delivered its final answer —
 *   and the Source+ box for that session showed a spinner that could never clear:
 *   nothing the user does (revealing the tab, a new turn, waiting) retires it, and
 *   the shell has no reason to ever exit.
 *
 * A never-exiting shell is indistinguishable from a long-running one while it lives —
 * a dev server, a watch process and an abandoned wait-loop all look the same in the
 * process table — so the shell promotion is bounded in TIME instead: it survives only
 * for a window. Inside that window a backgrounded job still holds the spinner; past
 * it the tab reports what the session itself reports, and a leftover shell can no
 * longer pin it.
 *
 * WHAT THE WINDOW IS MEASURED FROM. The SHELL's own age, not the tab's quiet stretch.
 * Measuring from the working→quiet edge was the first attempt and it does not hold:
 * the edge resets on every turn, so each turn that ends with a dev server still up
 * hands that server a fresh window, and the ceiling never bites. Observed 2026-09-17:
 * a session in a worktree with two `run_in_background` dev servers (a `react-router
 * dev` started that morning, a `manage.py runserver` from the day before) sat on a
 * spinner it could never clear — every "are you done?" the user sent bought the
 * servers another ten minutes. Aging the shell instead is monotonic: a job that was
 * already old when the turn began is old no matter how many turns follow, while a
 * job the turn actually launched is young exactly when it should be.
 *
 * The quiet-stretch bound is kept alongside it, because a shell's age is OBSERVED
 * (the monitor dates it by when it first appeared) and so can be wrong in the one
 * direction that matters — a shell it could not date reads as old, never as young,
 * which the quiet bound is not needed for; but a shell mis-dated young by a pid
 * recycle or a monitor restart is still caught by it. Both bounds must hold, so the
 * promotion can only ever narrow, never widen.
 *
 * Only the promotion is capped — the process-tree monitor itself keeps reporting the
 * truth, and nothing here can downgrade a tab that the session says is working or
 * needs attention.
 *
 * WHY THE CEILING IS NOT ENOUGH ON ITS OWN. A flat ceiling on the only signal we had
 * traded the stuck spinner for the opposite bug: a session waiting on four
 * `run_in_background` review agents (2026-08-20) went quiet at dispatch and stayed
 * quiet for 20 minutes, so the promotion lapsed mid-run and the box showed a
 * completion check while three of the four reviewers were still working. Background
 * agents run INSIDE the CLI process, so neither the process tree nor the webview can
 * see them (see sessionActivity.ts) — which is why the second signal here is not a
 * longer timer but a different observation: whether a subagent transcript is still
 * open. Evidence of work, rather than an assumption about its duration, is the only
 * thing that can hold a spinner honestly for an unbounded time.
 */


/** Statuses the promotion may lift; everything else passes through untouched. */
const QUIET = new Set(["done", "idle"]);

/**
 * Whether a status is one the promotion can lift. Exported so callers can skip
 * gathering signals for a tab whose session already says it is working — the disk
 * probe costs a `readdir` and a few `stat`s, and `tabs()` runs on every repaint.
 */
export function isQuietStatus(status: string): boolean {
  return QUIET.has(status);
}

/**
 * How long a live TOOL SHELL may hold a quiet tab at "working" — counted from the
 * shell's own start, and from the tab's quiet edge; both have to be inside it.
 *
 * 10 minutes, the same TTL the patch's `__wtBgTasks` mirror applies to a local-agent
 * task entry (patchClaude.ts, `bn-ts>6e5`) for the same reason. It has to comfortably
 * outlast a normal backgrounded build or test run, which is what the shell signal
 * exists to cover; a job that outruns it shows a completion check and flips back to
 * "working" when the agent resumes — a bounded misreport, unlike a spinner with no
 * way out. Background AGENT work is not bounded by this: it has its own, evidence-
 * based signal below.
 */
export const BG_PROMOTE_WINDOW_MS = 600_000;

/**
 * How long an unfinished subagent transcript's last write keeps counting as live work.
 *
 * This is a backstop, not the mechanism: normally a subagent's transcript CLOSES when
 * it is done (sessionActivity.ts reads that state directly), so the promotion ends
 * because the evidence ends. The bound only catches a subagent that was killed
 * mid-run and will never write its closing message. It therefore has to outlast a
 * working subagent's longest silence — measured at 5.4 minutes on the reviewers that
 * exposed the premature check (one long tool call, nothing written meanwhile) — so a
 * live agent is never mistaken for an abandoned one.
 */
export const AGENT_ACTIVITY_STALE_MS = 600_000;

/** Per-tab memory: when the tab's current quiet stretch began. */
export interface BgQuietLatch {
  /** Timestamp of the working→quiet edge that started this stretch. */
  since: number;
}

/** What the two monitors see for one tab, as of now. */
export interface BgSignals {
  /**
   * Process tree: when the YOUNGEST live tool / `run_in_background` shell under the
   * tab's agent started, epoch ms; absent when the tab has none.
   *
   * `0` is the monitor's "started before I was watching" (backgroundWork.ts) — it
   * arrives here as an age no window can contain, which is the intended reading.
   */
  shellWorkStartedAt?: number;
  /**
   * Newest write to a subagent transcript of this session that hasn't closed out,
   * epoch ms; absent when every subagent has finished (or there never was one).
   */
  unfinishedSubagentWriteAt?: number;
}

export interface BgPromotion {
  /** The status to render — `"working"` when a promotion applies. */
  status: string;
  /** Latch to carry to the next poll, or `undefined` to drop it (tab not quiet). */
  latch: BgQuietLatch | undefined;
}

/**
 * Decide whether work that the session itself can't report holds a quiet tab at
 * "working".
 *
 * Levels in, edge out: `tabs()` only ever sees the current status, so the quiet
 * stretch has to be remembered across polls by the caller (see the latch) — though
 * only the shell rule needs it. The two signals are deliberately NOT symmetric: an
 * unfinished subagent transcript still being written is direct evidence of work in
 * flight, while a live shell is only evidence that something was started, and may
 * never end — which is why the shell rule is the one carrying two time bounds.
 *
 * @param status  the tab's status before promotion, as the session reports it
 * @param signals what the process tree and the transcripts show for this tab
 * @param prev    the latch this tab returned last poll, if any
 * @param now     current epoch ms
 */
export function stepBgPromotion(
  status: string,
  signals: BgSignals,
  prev: BgQuietLatch | undefined,
  now: number
): BgPromotion {
  if (!QUIET.has(status)) {
    // The session speaks for itself while it is working or asking; the next quiet
    // edge starts a fresh window.
    return { status, latch: undefined };
  }
  // The quiet edge, held fixed for the whole stretch: it is what the shell window is
  // measured from, so letting it creep forward would hand a leftover shell a new
  // window on every poll and the ceiling would never bite.
  const latch = prev ?? { since: now };
  const wrote = signals.unfinishedSubagentWriteAt;
  if (wrote !== undefined && now - wrote < AGENT_ACTIVITY_STALE_MS) {
    return { status: "working", latch };
  }
  const shellAt = signals.shellWorkStartedAt;
  if (
    shellAt !== undefined &&
    now - shellAt < BG_PROMOTE_WINDOW_MS &&
    now - latch.since < BG_PROMOTE_WINDOW_MS
  ) {
    return { status: "working", latch };
  }
  return { status, latch };
}
