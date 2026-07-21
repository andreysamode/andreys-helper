import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  Agent,
  DEFAULT_SNIPPETS,
  KymData,
  Marble,
  Section,
  Snippet,
  SPHERE_TEXTURE_COUNT,
  Stage,
  STAGES,
  StageInstructions,
  emptyData,
} from "./model";

/**
 * Persists KYM board state to `.vscode/kym.json` at the window's open folder root.
 *
 * Two setting scopes (see docs/kym-plan.md §3c):
 *   - GLOBAL  — VSCode extension settings `andreysHelper.kym.*` (apply everywhere)
 *   - REPO    — this file (`.vscode/kym.json`), which overrides global.
 *
 * Board state (marbles) is always repo-scoped. Snippets and per-stage
 * instructions are the merge of global defaults + repo overrides.
 */
/** A field coordinate is an absolute pixel offset; keep it finite and >= 0. */
function clampCoord(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, n);
}

export class KymStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private data: KymData = emptyData();
  private readonly filePath: string;

  constructor(private readonly repoRoot: string) {
    this.filePath = path.join(repoRoot, ".vscode", "kym.json");
    this.load();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<KymData>;
      this.data = { ...emptyData(), ...parsed };
      // Defensive: ensure arrays/objects exist even if the file was hand-edited.
      this.data.marbles ??= [];
      this.data.sections ??= [];
      this.data.agents ??= [];
      this.data.snippets ??= [];
      this.data.stageInstructions ??= {};
      this.data.colWidths ??= {};
      this.data.colTextures ??= {};
      this.data.nextOrder ??= this.data.marbles.length + 1;
      this.repairAgentIds();
    } catch {
      this.data = emptyData();
    }
  }

  /**
   * Ensure every agent id is unique and seed the never-reused counter past any
   * existing ordinal. Older boards minted ids as `a${length+1}-…`, which reused
   * ordinals after a removal (and wrapped a timestamp), so two agents could share
   * one id — the wrong one then lit up / ran. Any exact duplicate found here is
   * reassigned a fresh id so `[data-aid=…]` is unambiguous from now on.
   */
  private repairAgentIds(): void {
    let maxOrd = 0;
    for (const a of this.data.agents) {
      const m = /^a(\d+)-/.exec(a.id || "");
      if (m) {
        maxOrd = Math.max(maxOrd, parseInt(m[1], 10));
      }
    }
    this.data.nextAgent = Math.max(
      this.data.nextAgent ?? 1,
      maxOrd + 1,
      this.data.agents.length + 1
    );
    const seen = new Set<string>();
    let reassigned = false;
    for (const a of this.data.agents) {
      if (!a.id || seen.has(a.id)) {
        a.id = `a${this.data.nextAgent}-${Math.floor(Date.now() % 1e7)}`;
        this.data.nextAgent += 1;
        reassigned = true;
      }
      seen.add(a.id);
    }
    // Write the de-duplicated ids back (without emitting — no listeners yet during
    // construction) so the repair is durable and stable across reloads.
    if (reassigned) {
      this.save(false);
    }
  }

  private save(emit = true): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n");
    } catch (err) {
      void vscode.window.showErrorMessage(
        `KYM: failed to save board state — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (emit) {
      this._onDidChange.fire();
    }
  }

  // --- reads ---------------------------------------------------------------

  get root(): string {
    return this.repoRoot;
  }

  marbles(): Marble[] {
    return [...this.data.marbles].sort((a, b) => a.order - b.order);
  }

  marble(id: string): Marble | undefined {
    return this.data.marbles.find((m) => m.id === id);
  }

  sections(): Section[] {
    return [...this.data.sections].sort((a, b) => a.order - b.order);
  }

  /** Repo-scoped column widths (px), keyed by column key. */
  colWidths(): Record<string, number> {
    return { ...this.data.colWidths };
  }

  /** Persist a column's pixel width at the repo level. */
  setColWidth(key: string, width: number): void {
    if (!key || !Number.isFinite(width)) {
      return;
    }
    this.data.colWidths[key] = Math.max(160, Math.round(width));
    this.save();
  }

  /** Repo-scoped column background textures, keyed by column key. */
  colTextures(): Record<string, string> {
    return { ...this.data.colTextures };
  }

  /**
   * Set a column's background texture. An empty value clears it (revert to the
   * column default); "none" is stored explicitly so a user can override a column
   * whose default is a texture (e.g. Plan/Process defaults to grass).
   */
  setColTexture(key: string, texture: string): void {
    if (!key) {
      return;
    }
    if (!texture) {
      delete this.data.colTextures[key];
    } else {
      this.data.colTextures[key] = texture;
    }
    this.save();
  }

  /** Clear a column's stored width so it reverts to its default (double-click). */
  resetColWidth(key: string): void {
    if (key in this.data.colWidths) {
      delete this.data.colWidths[key];
      this.save();
    }
  }

  /** Pick a sphere texture not already used by another marble (falls back to a
   *  cycle once all 35 are taken). Mirrors samodeus's pickUniqueTexture. */
  private pickUniqueTexture(): number {
    const used = new Set(
      this.data.marbles.map((m) => m.texture).filter((n): n is number => !!n)
    );
    const free: number[] = [];
    for (let n = 1; n <= SPHERE_TEXTURE_COUNT; n++) {
      if (!used.has(n)) {
        free.push(n);
      }
    }
    const pool = free.length ? free : Array.from({ length: SPHERE_TEXTURE_COUNT }, (_, i) => i + 1);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Marbles that still target a given branch and are not archived. */
  activeOnBranch(branch: string, excludeId?: string): Marble[] {
    return this.data.marbles.filter(
      (m) =>
        m.branch === branch &&
        m.id !== excludeId &&
        m.stage !== "archive"
    );
  }

  /**
   * Snippets shown on the board. The global setting `andreysHelper.kym.snippets`
   * is the source of truth (the modal edits it directly); we only fall back to
   * the built-in defaults when the user has never set any, so removals persist.
   * Repo overrides in `.vscode/kym.json` still layer on top.
   */
  snippets(): Snippet[] {
    const global = vscode.workspace
      .getConfiguration("andreysHelper.kym")
      .get<Snippet[]>("snippets", []);
    const base = global.length ? global : DEFAULT_SNIPPETS;
    const merged = new Map<string, Snippet>();
    for (const s of [...base, ...this.data.snippets]) {
      if (s && typeof s.tag === "string") {
        merged.set(s.tag, s);
      }
    }
    return [...merged.values()];
  }

  /** Persist the full snippet list to global (user) extension settings. */
  async setGlobalSnippets(snippets: Snippet[]): Promise<void> {
    const clean = (Array.isArray(snippets) ? snippets : []).filter(
      (s): s is Snippet =>
        !!s && typeof s.tag === "string" && s.tag.trim().length > 0
    );
    await vscode.workspace
      .getConfiguration("andreysHelper.kym")
      .update("snippets", clean, vscode.ConfigurationTarget.Global);
    this._onDidChange.fire();
  }

  /** Effective per-stage instructions: global setting, overridden per repo. */
  stageInstruction(stage: Stage): string {
    const global = vscode.workspace
      .getConfiguration("andreysHelper.kym")
      .get<StageInstructions>("stageInstructions", {});
    const repo = this.data.stageInstructions;
    return (repo[stage] ?? global[stage] ?? "").trim();
  }

  // --- writes --------------------------------------------------------------

  addMarble(
    partial: Omit<Marble, "id" | "order" | "stage"> & { stage?: Stage }
  ): Marble {
    const marble: Marble = {
      ...partial,
      id: `m${this.data.nextOrder}-${Math.floor(Date.now() % 1e7)}`,
      order: this.data.nextOrder,
      stage: partial.stage ?? "todo",
      texture: partial.texture || this.pickUniqueTexture(),
    };
    this.data.nextOrder += 1;
    this.data.marbles.push(marble);
    this.save();
    return marble;
  }

  updateMarble(id: string, patch: Partial<Marble>): Marble | undefined {
    const m = this.data.marbles.find((x) => x.id === id);
    if (!m) {
      return undefined;
    }
    Object.assign(m, patch);
    this.save();
    return m;
  }

  /**
   * Persist a marble patch WITHOUT emitting a change event (no re-render). For
   * live-position bookkeeping the webview already reflects — e.g. a ball's
   * resting centre after a hop roll — so a reload lands it correctly, but the
   * running board (mid-animation) isn't torn down and rebuilt under the user.
   */
  updateMarbleQuiet(id: string, patch: Partial<Marble>): void {
    const m = this.data.marbles.find((x) => x.id === id);
    if (!m) {
      return;
    }
    Object.assign(m, patch);
    this.save(false);
  }

  /**
   * Move a marble to a stage/section and reposition it (before `beforeId`, or
   * to the end of its destination group when null). Renumbers every marble's
   * `order` into a single stable sequence — stages left→right, and within TODO
   * the ungrouped area first, then each section in its own order — so per-group
   * sorts stay consistent.
   */
  reorder(
    id: string,
    stage: Stage,
    sectionId: string | undefined,
    beforeId: string | null
  ): void {
    const moved = this.data.marbles.find((m) => m.id === id);
    if (!moved) {
      return;
    }
    // Guard against a bad drag posting an unknown stage — that would strand the
    // marble in no column and read as "deleted" on the next render/reload.
    if (!STAGES.includes(stage)) {
      return;
    }
    moved.stage = stage;
    moved.sectionId = stage === "todo" ? sectionId : undefined;

    const byOrder = (a: Marble, b: Marble) => a.order - b.order;
    const groups: Marble[][] = [];
    for (const s of STAGES) {
      if (s === "todo") {
        const secIds = new Set(this.data.sections.map((x) => x.id));
        groups.push(
          this.data.marbles
            .filter(
              (m) =>
                m.stage === "todo" && (!m.sectionId || !secIds.has(m.sectionId))
            )
            .sort(byOrder)
        );
        for (const sec of this.sections()) {
          groups.push(
            this.data.marbles
              .filter((m) => m.stage === "todo" && m.sectionId === sec.id)
              .sort(byOrder)
          );
        }
      } else {
        groups.push(this.data.marbles.filter((m) => m.stage === s).sort(byOrder));
      }
    }
    // Reposition the moved marble within whichever group now contains it.
    for (const g of groups) {
      const idx = g.indexOf(moved);
      if (idx < 0) {
        continue;
      }
      g.splice(idx, 1);
      const bi = beforeId ? g.findIndex((m) => m.id === beforeId) : -1;
      if (bi >= 0) {
        g.splice(bi, 0, moved);
      } else {
        g.push(moved);
      }
      break;
    }
    groups.flat().forEach((m, i) => {
      m.order = i;
    });
    this.data.nextOrder = this.data.marbles.length + 1;
    this.save();
  }

  removeMarble(id: string): void {
    const before = this.data.marbles.length;
    this.data.marbles = this.data.marbles.filter((m) => m.id !== id);
    if (this.data.marbles.length !== before) {
      this.save();
    }
  }

  setRepoSnippets(snippets: Snippet[]): void {
    this.data.snippets = snippets;
    this.save();
  }

  // --- agents (Plan/Process field characters) ------------------------------

  agents(): Agent[] {
    return [...this.data.agents];
  }

  addAgent(sprite: string, x: number, y: number, hue?: number): Agent {
    const seq = this.data.nextAgent ?? this.data.agents.length + 1;
    this.data.nextAgent = seq + 1;
    const agent: Agent = {
      // seq is monotonic and never reused, so the prefix (and thus the whole id)
      // is unique for the lifetime of the board — no two agents can collide.
      id: `a${seq}-${Math.floor(Date.now() % 1e7)}`,
      sprite: String(sprite || ""),
      x: clampCoord(x),
      y: clampCoord(y),
    };
    if (hue) {
      agent.hue = Math.round(hue) % 360;
    }
    this.data.agents.push(agent);
    this.save();
    return agent;
  }

  moveAgent(id: string, x: number, y: number, flip?: boolean): void {
    const a = this.data.agents.find((g) => g.id === id);
    if (!a) {
      return;
    }
    a.x = clampCoord(x);
    a.y = clampCoord(y);
    if (flip !== undefined) {
      a.flip = !!flip;
    }
    this.save();
  }

  updateAgent(id: string, patch: Partial<Agent>): void {
    const a = this.data.agents.find((g) => g.id === id);
    if (!a) {
      return;
    }
    Object.assign(a, patch);
    this.save();
  }

  removeAgent(id: string): void {
    const before = this.data.agents.length;
    this.data.agents = this.data.agents.filter((g) => g.id !== id);
    if (this.data.agents.length !== before) {
      this.save();
    }
  }

  clearAgents(): void {
    if (this.data.agents.length === 0) {
      return;
    }
    this.data.agents = [];
    this.save();
  }

  // --- sections ------------------------------------------------------------

  addSection(label: string): Section {
    const order =
      this.data.sections.reduce((max, s) => Math.max(max, s.order), 0) + 1;
    const section: Section = {
      id: `s${order}-${Math.floor(Date.now() % 1e7)}`,
      label: label.trim() || "Section",
      order,
    };
    this.data.sections.push(section);
    this.save();
    return section;
  }

  updateSection(id: string, patch: Partial<Section>): void {
    const s = this.data.sections.find((x) => x.id === id);
    if (!s) {
      return;
    }
    Object.assign(s, patch);
    this.save();
  }

  /** Reposition a section before `beforeId` (or to the end when null). */
  reorderSection(id: string, beforeId: string | null): void {
    const ordered = this.sections();
    const moved = ordered.find((s) => s.id === id);
    if (!moved) {
      return;
    }
    const rest = ordered.filter((s) => s.id !== id);
    const bi = beforeId ? rest.findIndex((s) => s.id === beforeId) : -1;
    if (bi >= 0) {
      rest.splice(bi, 0, moved);
    } else {
      rest.push(moved);
    }
    rest.forEach((s, i) => {
      s.order = i + 1;
    });
    this.save();
  }

  /** Clear every section's stored height so they fall back to the default size. */
  resetSectionHeights(): void {
    let changed = false;
    for (const s of this.data.sections) {
      if (s.height !== undefined) {
        delete s.height;
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  removeSection(id: string): void {
    const before = this.data.sections.length;
    this.data.sections = this.data.sections.filter((s) => s.id !== id);
    // Orphaned marbles fall back to the ungrouped area.
    for (const m of this.data.marbles) {
      if (m.sectionId === id) {
        m.sectionId = undefined;
      }
    }
    if (this.data.sections.length !== before) {
      this.save();
    }
  }
}
