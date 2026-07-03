# Issue #6: Generalize the /distill reductive pass to epics (cross-sibling-issue consolidation)

## Definition of Done
- [x] `commands/distill.md` gains an **Epic mode** — `/distill --epic {N}` runs the same reductive
      pass over an epic's open sibling issues (found via `Epic: #{N}` linkage).
- [x] `reference/ilr-system.md` — the Decomposition/Trunk-First section references the epic distill
      pass; the Commands table shows `/distill [--epic N]`.

**Chesterton pivot.** The naive "same pass, different files" is a footgun: trunk-first *guarantees* a
partial, in-flux plan, so the greenfield "wait until stable" precondition can never hold; and distill's
own WET-before-DRY guard ("extract at the second real build") forbids extraction before build — which is
exactly when epic mode runs. So epic mode is a genuinely *different* mode, not a corpus swap. The three
deltas below are what make it real rather than redundant/wrong.

## Acceptance Criteria
- [x] AC1: `commands/distill.md` gets a **hard-partitioned "Epic mode" section** (no prose shared with
      greenfield, so greenfield's "whole plan / no code yet / WET-before-DRY-on-greenfield" text stays
      intact — AC7). `/distill --epic {N}` reads the epic's sibling `tracking.md` via **anchored
      discovery**: exact `Epic: #{N}` match on issue body (equality-checked `grep -oP 'Epic: #\K[0-9]+'`,
      NOT `gh search "Epic: #N"` which substring-matches #12/#15). It lists the discovered sibling set
      back to the human and prints "corpus may be incomplete — un-spec'd / closed siblings excluded."
- [x] AC2: **Trunk-first-aware trigger (delta 1), replacing the greenfield precondition.** Epic mode
      runs at the **proof-point boundary** over the currently-spec'd siblings toward that proof point;
      it states plainly that **stability is NOT expected mid-epic** (trunk-first only creates 2–3 issues
      at a time). It needs ≥2 spec-approved-or-near siblings — NOT the greenfield ≥3/stable gate.
- [x] AC3: **Extract demoted to a watchlist (delta 2) — the key divergence.** At trunk-first the
      actionable output is **simplify + consolidate-observations only**; a candidate shared shape goes on
      a **"revisit at the proof point / second real build" watchlist**, NEVER an actionable coupling
      edit. This is distill's own WET-before-DRY honestly applied: with nothing built, there is no second
      usage, so extraction is premature by construction. (The motivating #2/#3/#5 shared-hook shape is a
      watchlist item, not an extract.)
- [x] AC4: **Single-writer / in-flight guard (delta 3).** Epic mode enumerates sibling states first and
      edits ONLY siblings still in `dev/design`; it **aborts-with-report** if any target sibling is
      `dev/implement`, has an open `.claude/worktrees/issue-{k}`, or the set spans phases — respecting
      "one active pipeline per issue" and the worktree rule.
- [x] AC5: `reference/ilr-system.md` — the **Decomposition: Trunk-First** section notes `/distill
      --epic {N}` runs at the proof-point boundary and is watchlist-not-extract; the Commands table row
      reads `/distill [--epic N]`.
- [x] AC6: Same persona (Alexander) + single-writer-of-foundations discipline carry over; the epic
      section says so without re-deriving them.
- [x] AC7: **No regression** — greenfield `/distill` prose is untouched (grep its load-bearing phrases:
      "the whole plan", "no code yet", "WET before DRY"); the epic section is additive and partitioned.

## Design Notes

**NOT "same pass, different corpus" (Chesterton).** The reductive extract move is *wrong* at
trunk-first: trunk-first exists because you don't yet know the shape (building toward a proof point; a
failed proof means pivot with a 2–3 item blast radius). Extracting a shared module across unbuilt sibling
specs couples exactly what you might pivot away from. Distill's own WET-before-DRY guard says "extract at
the second real build" — and epic mode runs *before* any build, so extraction is premature by
construction. Hence the three deltas (AC2/AC3/AC4) that make epic mode a genuinely different, coherent
mode rather than a footgun.

**What epic mode does at trunk-first:** simplify (redundant complexity across the siblings) +
consolidate-**observations** + a **watchlist** of shared-shape candidates tagged "revisit at the proof
point / second real build." It does NOT propose coupling edits. Same persona (Alexander), same
single-writer-of-foundations rule. (The motivating #2/#3/#5 shared-hook shape is a watchlist item.)

**Anchored discovery, honest corpus.** Siblings via exact `Epic: #{N}` equality (the documented
`grep -oP 'Epic: #\K[0-9]+'` form), not `gh search "Epic: #N"` (substring-matches #12/#15). Un-spec'd and
closed siblings are excluded — so epic mode lists the discovered set and warns the corpus may be incomplete.

**Single-writer safety.** The auto-handoff pipeline builds approved siblings immediately (often in
parallel worktrees), so epic mode edits only `dev/design` siblings and aborts-with-report if any target
is `dev/implement` / has a worktree.

**Files touched:** `commands/distill.md` (+hard-partitioned Epic mode section), `reference/ilr-system.md`
(Trunk-First note + commands table `/distill [--epic N]`).

## Premortem
(Chesterton, ranked by likelihood × cost — addressed by the three deltas)

- **Extract-now at trunk-first couples siblings that then pivot** — early sign: the report contains an
  "extract shared module" proposal (not a watchlist item) while a proof point is unresolved. Mitigation
  (AC3): extract lens demoted to a watchlist; actionable output is simplify + consolidate-observations
  only.
- **Distill rewrites an in-flight sibling's tracking.md and corrupts an active pipeline** — early sign:
  it edits a sibling that's `dev/implement` or has an open worktree; Brunel's next commit conflicts.
  Mitigation (AC4): enumerate sibling states first, edit only `dev/design`, abort-with-report otherwise.
- **Precondition makes epic mode never-fire or always-fire-wrongly** — early sign: a 2-sibling trunk is
  skipped by a ≥3 gate, or it rationalizes a merge on an admittedly unstable set. Mitigation (AC2):
  trunk-first-aware trigger (proof-point-relative, ≥2 spec'd siblings), stability explicitly not expected.
- **Sibling discovery returns a wrong/partial set** — early sign: `gh search "Epic: #1"` pulls #12/#15,
  or omits an un-spec'd/closed sibling. Mitigation (AC1): anchored exact-line match; list the set back +
  "corpus may be incomplete" caveat.
- **Ships as "same pass, different files" (redundant footgun)** — early sign: the diff only adds a corpus
  switch with greenfield guards verbatim. Mitigation: the three deltas ARE the DoD for "epic mode is
  real"; without them, degrade to a `--epic` file filter + an explicit "not at trunk-first" warning.

## Cache Invalidation Plan
None — docs.

## Review History
- Chesterton (spec review) bounced the naive design as a **footgun**: "same pass, different corpus"
  imports a greenfield precondition that trunk-first *guarantees* is false, and an extract lens that
  distill's own WET-before-DRY rule forbids before build. Reshaped into a genuinely different mode via
  three deltas — trunk-first trigger (AC2), extract→watchlist (AC3), single-writer/in-flight guard (AC4)
  — plus anchored discovery (AC1) and a hard-partitioned section (AC7). (Prose, not a `- BOUNCE:` marker
  — spec bounce, not witness bounce.)

## Pipeline State
- Current phase: **witness complete / awaiting ship**
- Next agent: — (human ship gate)
- Bounce count: 0

## Witness
- [x] Spec approved
- [x] Implementation complete
- [x] Deployed / runnable
- [x] Witnessed
