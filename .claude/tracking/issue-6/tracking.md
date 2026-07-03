# Issue #6: Generalize the /distill reductive pass to epics (cross-sibling-issue consolidation)

## Definition of Done
- [ ] `commands/distill.md` gains an **Epic mode** — `/distill --epic {N}` runs the same reductive
      pass over an epic's open sibling issues (found via `Epic: #{N}` linkage).
- [ ] `reference/ilr-system.md` — the Decomposition/Trunk-First section references the epic distill
      pass; the Commands table shows `/distill [--epic N]`.

## Acceptance Criteria
- [ ] AC1: `commands/distill.md` documents an **Epic mode**: `/distill --epic {N}` ingests the open
      sibling issues of epic `#{N}` (via the `Epic: #{N}` line in issue bodies) and applies the SAME
      three cross-plan lenses (simplify / consolidate / extract-shared), the SAME anti-premature-
      abstraction counter-pressure (rule-of-three, argue-the-null-case, WET-before-DRY, cap), and the
      SAME single-writer-of-foundations discipline. Unit of analysis is the sibling set, never one spec.
- [ ] AC2: Epic mode is documented to run at the **trunk-first boundary** — after `/spec`-ing the 2–3
      siblings toward a proof point, before building them — and is optional (skip if <3 siblings, same
      precondition as greenfield).
- [ ] AC3: The greenfield-vs-epic distinction is documented in `commands/distill.md`: greenfield =
      the whole plan; epic = one epic's open siblings. Same persona (Alexander), same guardrails.
- [ ] AC4: `reference/ilr-system.md` — the Decomposition: Trunk-First section notes that `/distill
      --epic {N}` runs across the 2–3 siblings before build; the Commands table row reads
      `/distill [--epic N]`.
- [ ] AC5: No regression — the greenfield `/distill` behavior (precondition, lenses, counter-pressure,
      single-writer) is unchanged; Alexander persona and roster entries stay consistent.

## Design Notes

**Same pass, different corpus.** The reductive move ("these siblings need one component — build it
once") is identical to greenfield; only the *input set* differs: an epic's open siblings instead of
the whole greenfield plan. So Epic mode reuses everything — lenses, counter-pressure, single-writer,
precondition — and just changes what it reads. This keeps Alexander one coherent agent, not two.

**Where the siblings come from.** ilr-system.md already defines epic linkage: sub-issues carry
`Epic: #{N}` in their body, found via `gh search issues "Epic: #{EPIC}" --state open`. Epic mode reads
those siblings' `tracking.md`.

**When to run it.** Trunk-first says decompose only 2–3 issues to the first proof point. Epic distill
runs at that boundary — once the 2–3 siblings are spec'd, before they're built — the cheapest moment
to notice they share a table/util/hook. (This session is the motivating case: #2/#3/#5 all share the
"PreToolUse hook reading committed ILR state" shape.)

**Files touched:** `commands/distill.md` (+Epic mode section), `reference/ilr-system.md`
(Trunk-First note + commands table).

## Premortem
{To be filled by Chesterton spawn.}

## Cache Invalidation Plan
None — docs.

## Review History
{Empty.}

## Pipeline State
- Current phase: spec / awaiting approval
- Next agent: Brunel (implement) on approval
- Bounce count: 0

## Witness
- [ ] Spec approved
- [ ] Implementation complete
- [ ] Deployed / runnable
- [ ] Witnessed
