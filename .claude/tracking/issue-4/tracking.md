# Issue #4: Add a greenfield holistic "distill" pass (/distill) — simplify, consolidate, modularize

## Definition of Done
- [x] `commands/distill.md` exists — the `/distill` command, voiced as **Christopher Alexander**,
      running the holistic pre-build pass over the whole greenfield plan.
- [x] `reference/ilr-system.md` lists `/distill` in the Commands table and adds Alexander to the
      agent model (greenfield reductive design agent).
- [x] `reference/greenfield-foundations.md` documents the greenfield flow so `/distill` has a home:
      `/foundation` → feature specs → **`/distill`** → build.
- [x] `reference/ilr-playbook.md` roster mentions Alexander (greenfield/optional).

## Acceptance Criteria

- [x] AC1: `commands/distill.md` exists with valid frontmatter (`AskUserQuestion`, Read, Grep, Glob,
      Edit, Write, Agent), voiced as **Christopher Alexander**, carrying the interaction conventions
      (AskUserQuestion by default, never-bare-ticket-ID). It ingests **every**
      `.claude/tracking/issue-*/tracking.md` (the whole plan) plus a read-only view of
      `reference/foundations.md`; its unit of analysis is the **plan, never a single spec**.
- [x] AC2: **Precondition + graceful bail (Chesterton).** The pass runs only when the feature set is
      substantially all spec'd and the plan is stable. Fewer than ~3 substantially-complete specs →
      it reports "too small/too early to distill" and exits clean (no invented merges to justify
      itself). Distilling a partial spec set is documented as harmful.
- [x] AC3: **Three cross-plan lenses**, each finding naming the specs + a concrete before/after:
      **simplify** (the *plan as a whole* carries redundant complexity — NOT single-spec tidying),
      **consolidate/merge** (the same need spread across specs), **extract-as-shared-module** (a
      recurring pattern → one reusable component). A simplify-only pass is flagged as a signal the
      pass wasn't needed.
- [x] AC4: **Anti-premature-abstraction counter-pressure baked in (Chesterton), not just an approval
      gate:** (a) no extract-as-shared proposal without **≥3 real usages AND an explicit list of how
      they differ**; (b) every merge proposal carries a one-line **"why these might be 3 fences, not
      1"** (an embedded Chesterton null-case check); (c) **WET-before-DRY default on greenfield** —
      recommend "duplicate now, extract at the second real build" for anything guessed; (d) **cap the
      proposals per pass** to a short ranked list (avoid approval fatigue). Proposed edits are applied
      **only on approval** — never auto-rewrite.
- [x] AC5: **Single writer for the foundation (Chesterton — the real collision).** `/distill` edits
      **feature specs only**. Any change that belongs at the foundation layer (data model, a Tier-1
      decision) is **routed back through `/foundation` as a proposed revision** — `/distill` NEVER
      writes `foundations.md` itself. States this explicitly so the two greenfield commands don't
      double-author the foundation record.
- [x] AC6: The **Christopher Alexander** persona is documented — A Pattern Language bias (find the
      recurring pattern, build it once; coherence of the whole), anchored to **whole-plan cross-spec
      analysis**, framed as the reductive complement to Chesterton (Chesterton conserves per-ticket;
      Alexander reduces across the plan).
- [x] AC7: `reference/ilr-system.md` Commands table includes a `/distill` row and the agent model
      documents Alexander; `reference/greenfield-foundations.md` documents the greenfield flow
      (`/foundation` → spec features → **`/distill`** → build), optional/greenfield-only;
      `reference/ilr-playbook.md` roster lists Alexander.
- [x] AC8: The spec names, in one line, that the reductive pass **generalizes to epics** (a
      cross-sibling-issue distill) and that this is **deliberately out of scope** here — filed as a
      follow-up. (This session's own 4-issues-no-consolidation is the motivating case.)

## Design Notes

**Why a distinct persona from Chesterton (the fence question the review will ask).** Chesterton is
conservative by design — "don't take a fence down until you know why it's there." That bias is exactly
wrong for the greenfield consolidation moment, whose whole job is to *actively remove and merge*.
Alexander is the reductive complement: A Pattern Language is about spotting the recurring need across
many places and factoring it into one reusable, modular pattern, and about the coherence of the whole
("quality without a name"). Same design altitude, opposite-and-complementary bias. `/foundation` is
also Chesterton (build the fences deliberately); `/distill` is Alexander (find the fences that are
secretly one pattern). Both greenfield, different jobs.

**Where it sits.** Greenfield flow: `/foundation` (day-zero cross-cutting decisions) → `/spec` each
feature → **`/distill`** (one holistic pass over the whole plan) → build. It's the "last look before
we build" Josh described — cheapest possible moment to make three specs share a component instead of
hand-rolling three.

**Three lenses, concrete before/after.** simplify (this spec is two features pretending to be five),
consolidate (specs #2/#5/#7 all need the same table/util — make it one), extract (this shape recurs →
a reusable component/pattern). Vague "consider simplifying" is useless; each finding names the specs
and the proposed shared artifact.

**Report + approval is necessary but NOT sufficient (Chesterton).** Approval blocks auto-*application*
but not biased *proposal generation* + a tired approver — and a persona whose identity is "find the
shared pattern" will always find patterns. So the counter-pressure is baked into proposal generation
(AC4): rule-of-three + named differences, Alexander argues the null case per merge, WET-before-DRY
default (a wrong duplicate is trivial to merge later; a wrong shared module couples three features you
must unwind), and a capped, ranked proposal list.

**Single writer for the foundation (Chesterton — the real collision).** `/foundation` owns
`foundations.md`. `/distill` reads it but edits only feature specs; anything foundation-layer is
proposed back through `/foundation`. Otherwise two greenfield commands double-author the record and a
Josh-approved (maybe already-migrated) data model gets silently reopened.

**Generalizes to epics (out of scope here).** The reductive cross-plan pass isn't really
greenfield-specific — an epic that decomposes into sibling issues has the same "these three siblings
need one component" gap, and nothing looks across them before build. This session is the proof: four
capabilities added one-at-a-time with no consolidation pass. #4 stays greenfield as decided; an
epic-level distill is filed as a follow-up so the door is visible, not assumed shut.

**Optional + greenfield.** Not every project runs it; a small tool doesn't need a holistic pass. Say
so, so it doesn't become ceremony.

**Files touched:** new `commands/distill.md`; edited `reference/ilr-system.md` (commands table +
agent model), `reference/greenfield-foundations.md` (greenfield flow), `reference/ilr-playbook.md`
(roster).

## Premortem
(Chesterton, ranked by likelihood × cost)

- **Over-consolidation shipped as "approved"** — early sign: approval turns are long lists of merges
  accepted with little pushback; extracted "shared" modules already sprout per-caller `if` branches.
  Mitigation: AC4 — rule-of-three + name-the-differences + Alexander argues the null case + WET-by-
  default on greenfield + cap proposals per pass.
- **/distill and /foundation double-author the foundation** — early sign: `foundations.md` gains
  edits not traceable to a `/foundation` run, or the data model changes after it was approved.
  Mitigation: AC5 single-writer — `/distill` edits feature specs only, routes foundation-layer
  changes back through `/foundation`.
- **Ceremony on projects too small to need it** — early sign: runs on a 1–2 spec project and no-ops
  or invents a merge to justify itself. Mitigation: AC2 precondition (≥3 substantially-complete specs
  + stable plan) with a clean "too small — skipped" exit.
- **Alexander indistinguishable from Chesterton** — early sign: distill reports read like per-ticket
  Chesterton notes; output dominated by single-spec simplify findings. Mitigation: AC1/AC3/AC6 anchor
  Alexander to whole-plan cross-spec analysis; a simplify-only pass flags the pass as unneeded.
- **Distilled at the wrong time (partial coverage)** — early sign: new feature specs created AFTER a
  distill pass already extracted a shared module. Mitigation: AC2 "substantially all spec'd + stable"
  precondition; keep the pass cheaply re-runnable; pre-build extractions provisional until 2nd usage.

## Cache Invalidation Plan
None — new command + docs.

## Review History
{Empty.}

## Pipeline State
- Current phase: **witness complete / awaiting ship**
- Next agent: — (human ship gate)
- Bounce count: 0

## Witness
- [x] Spec approved
- [x] Implementation complete
- [x] Deployed / runnable
- [x] Witnessed
