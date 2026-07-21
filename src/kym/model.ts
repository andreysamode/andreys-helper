/**
 * Keep Your Marbles (KYM) — shared data model.
 *
 * A *marble* is one unit of work that flows left→right across the Kanban stages.
 * Each marble names a target git *branch*; a worktree for that branch is created
 * lazily (only when the marble is processed) and removed on archive when no other
 * marble still targets it. See docs/kym-plan.md for the full design.
 */

export type Stage =
  | "todo"
  | "plan"
  | "process"
  | "verify"
  | "done"
  | "archive";

export const STAGES: Stage[] = [
  "todo",
  "plan",
  "process",
  "verify",
  "done",
  "archive",
];

/** Human labels for the column headers (Source Plus is a separate pane). */
export const STAGE_LABELS: Record<Stage, string> = {
  todo: "TODO",
  plan: "Plan",
  process: "Process",
  verify: "Verify",
  done: "Done",
  archive: "Archive",
};

/** How a marble should behave when dropped into Plan. */
export type PlanMode = "pause" | "implement";

export interface Ticket {
  /** Display label, e.g. "PRO-123". */
  label: string;
  /** Optional link to Linear/Jira/etc. */
  url?: string;
}

/** A reusable prompt fragment; dragging its tag into the prompt expands to body. */
export interface Snippet {
  tag: string;
  body: string;
}

/**
 * A decorative animated character placed freely on the Plan/Process "field".
 * `sprite` is a sprite-sheet filename in media/sprites (without extension);
 * `x`/`y` are fractional (0..1) positions of its center within the field.
 */
export interface Agent {
  id: string;
  sprite: string;
  x: number;
  y: number;
  /** Whether the sprite is mirrored horizontally (faces left). */
  flip?: boolean;
  /** Hue rotation in degrees (0..360) baked in at placement time. */
  hue?: number;
  /** Optional display name — shown in a bubble above the character. */
  name?: string;
  /** Optional prompt associated with the character. */
  prompt?: string;
}

/** The named marble colors, ported from samodeus (each maps to a color-*.webp). */
export const MARBLE_COLORS = [
  "plum",
  "mud",
  "red",
  "orange",
  "yellow",
  "purple",
  "blue",
  "gray",
  "green",
  "lime",
] as const;
export type MarbleColor = (typeof MARBLE_COLORS)[number];

/** How many sphere-*.svg texture overlays ship in media/marbles. */
export const SPHERE_TEXTURE_COUNT = 35;

/**
 * A user-defined divider within the TODO column — a foldable "fieldset" that
 * groups marbles for organization. Sections only exist in TODO (see FigJam).
 */
export interface Section {
  id: string;
  label: string;
  collapsed?: boolean;
  order: number;
  /** User-set pixel height (via the resize handle); unset = share space evenly. */
  height?: number;
}

export interface Marble {
  id: string;
  title: string;
  stage: Stage;
  /** Target branch — defines which worktree this marble lands in. */
  branch: string;
  tickets: Ticket[];
  prompt: string;
  model?: string;
  openSpec: boolean;
  copyIgnored: boolean;
  /** Worktree creation mode: "basic" (fast) or "full" (also copies gitignored). */
  worktreeSetup?: "basic" | "full";
  /** Named palette color (see MARBLE_COLORS); maps to a color-*.webp texture. */
  color?: string;
  /** 1-based sphere texture index (see SPHERE_TEXTURE_COUNT), assigned on create. */
  texture?: number;
  icon?: string;
  /** TODO-column section this marble belongs to (undefined = ungrouped). */
  sectionId?: string;
  /** Free position (fractional 0..1 of the field) when resting in Plan/Process. */
  fieldX?: number;
  fieldY?: number;
  /**
   * Ordered agent ids the marble should be passed through on its way from TODO
   * to Verify (authored via the chevron path editor). Order is click order; the
   * marble executes each agent's prompt in turn. Empty/undefined = no path.
   */
  pathAgentIds?: string[];
  /**
   * Live pass-around run state while the marble travels its `pathAgentIds`:
   *  - "running"   — executing a hop (circling the current agent);
   *  - "paused"    — session was stopped; a pause badge shows, click to resume;
   *  - "attention" — session needs the user (see `runKind`); the marble bounces;
   *  - "failed"    — session was closed mid-run; parked in TODO's Failed group.
   * Undefined = not on a pass-around run.
   */
  runStatus?: "running" | "paused" | "attention" | "failed";
  /** Current hop: index into `pathAgentIds` of the agent being executed. */
  runIndex?: number;
  /** When runStatus === "attention", which kind: question | permission | plan. */
  runKind?: string;
  /** Which Plan drop-target was used (pause = stop; implement = quick path). */
  planMode?: PlanMode;
  /**
   * Bound Claude PANEL id ("wt<N>") — identifies the exact open tab the marble's
   * prompts target. Per-window: panel ids restart on every host reload, so a
   * persisted value from a previous window may collide with an unrelated new
   * tab. Always cross-check against `claudeSessionId` (see sessionFor).
   */
  sessionId?: string;
  /**
   * Persistent Claude session uuid of the marble's conversation. Survives tab
   * closes and window reloads — used to RESUME the session with its history
   * (and to detect a stale `sessionId` binding). Recorded as soon as the bound
   * tab publishes it; cleared when a fresh run intentionally starts a new
   * session.
   */
  claudeSessionId?: string;
  /** Resolved worktree cwd (realpath-normalized), created lazily on process. */
  worktreeCwd?: string;
  /** Creation order timestamp-free counter for stable sort. */
  order: number;
}

/** Per-stage extra instructions appended to the message sent at that stage. */
export type StageInstructions = Partial<Record<Stage, string>>;

/** The on-disk `.vscode/kym.json` shape (repo-scoped state + overrides). */
export interface KymData {
  version: 1;
  marbles: Marble[];
  /** User-defined TODO-column grouping dividers. */
  sections: Section[];
  /** Decorative animated characters placed on the Plan/Process field. */
  agents: Agent[];
  /** Repo-scoped snippet library (merged over global defaults). */
  snippets: Snippet[];
  /** Repo-scoped per-stage instruction overrides (merged over global). */
  stageInstructions: StageInstructions;
  /** Repo-scoped column pixel widths, keyed by column key (todo, planprocess…). */
  colWidths: Record<string, number>;
  /** Repo-scoped column background texture, keyed by column key (e.g. "grass"). */
  colTextures: Record<string, string>;
  /** Monotonic counter backing Marble.order. */
  nextOrder: number;
  /**
   * Monotonic counter backing agent ids — never reused, so an agent id is unique
   * for the lifetime of the board. (The old `a${length+1}` scheme reused ordinals
   * after a removal, which could collide two agents onto one id and light/run the
   * wrong one.)
   */
  nextAgent?: number;
}

export function emptyData(): KymData {
  return {
    version: 1,
    marbles: [],
    sections: [],
    agents: [],
    snippets: [],
    stageInstructions: {},
    colWidths: {},
    colTextures: {},
    nextOrder: 1,
    nextAgent: 1,
  };
}

/** Seeded snippet defaults, mirroring the FigJam chips. */
export const DEFAULT_SNIPPETS: Snippet[] = [
  { tag: "code review", body: "Then run a thorough code review of your changes." },
  {
    tag: "security review",
    body: "Then perform a security review of your changes.",
  },
  { tag: "IMOGAA", body: "Interview me on gaps and ambiguities." },
];
