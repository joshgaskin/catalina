# Issue #3: Make the ILR hand off between agents seamlessly without stalling

## Definition of Done
- [x] `reference/ilr-playbook.md` carries the **Completion Report Contract** for implementer
      subagents (paste-verbatim block).
- [x] `reference/ilr-system.md` has an **Auto-Handoff Pipeline** section (full flow, two human
      gates, bounded-retry-on-fail) and a **Never idle without handoff** guardrail.
- [x] The tracking.md template (in both `ilr-system.md` and `commands/spec.md`) gains a
      **`## Pipeline State`** block; `spec.md`/`witness.md` update it at transitions.
- [x] `commands/spec.md` auto-begins implementation on approval; `commands/witness.md` routes on
      pass (→ ship gate) vs fail (→ bounded auto-loop back to implement).
- [x] `CLAUDE.md` states the two human gates + the never-idle rule.

## Acceptance Criteria

- [x] AC1: `reference/ilr-playbook.md` contains a **Completion Report Contract** to paste at the
      end of every implementer-subagent prompt: final message = files changed, tests written/run
      (verbatim counts), deviations from tracking.md with justification, and anything unverified;
      "an ended turn with no report is a failed task."
- [x] AC2: `reference/ilr-system.md` has an **Auto-Handoff Pipeline** section naming the **only two
      human gates** (approve spec, ship) with every other transition automatic. **Gate-word
      discipline (Chesterton):** at the spec gate the sole proceed trigger is **"approved"**; **"go"/
      "ship" is valid ONLY at the ship gate** (never overload "go" to mean start-building). A
      same-turn follow-up after "approved" (an extra AC, "oh also…", `/capture`) is an **amend, not a
      proceed** — the approval→implement transition emits a one-line "starting implementation — last
      call to amend" so the old approve-then-a-beat pause is preserved cheaply.
- [x] AC3: **Bounded retry — split by red-state, honest about the bound (Chesterton).** Two failures
      are different and route differently: a **witness-gate block (exit 2)** = evidence missing/fake →
      **gather/repair evidence and re-witness** (NOT re-implement); a **`/witness` AC fail** = wrong
      code → **re-implement**. The bound is **derived from committed ground truth** (count `## Review
      History` bounces / `verification.jsonl` fail-lines), not a self-incremented field. After 2
      bounces it STOPS and escalates to the human with a diagnosis. **`CATALINA_WITNESS_ALLOW` is
      NEVER a loop exit** — escalation to the human is the only sanctioned exit, and any override use
      is logged to the issue. (Mechanical enforcement of the bound is a candidate follow-up hook, not
      claimed here.)
- [x] AC4: A **`## Pipeline State`** block (current phase · next agent · bounce count) is added to the
      tracking.md template in BOTH `reference/ilr-system.md` and `commands/spec.md`; `spec.md` and
      `witness.md` update it at their transition. **It is ADVISORY, not authoritative (Chesterton):**
      on resume, reconcile it against ground truth (labels + `verification.jsonl` + `git log --grep`),
      and **when they conflict, ground truth wins** — never re-run or skip a phase (especially witness)
      on the state block alone.
- [x] AC5: **Never idle without handoff** appears in `CLAUDE.md` + `reference/ilr-system.md` guardrails,
      framed honestly: an agent should hand off, escalate via `AskUserQuestion`, or post a completion
      report. This is a **convention that makes a stall detectable on resume** (Pipeline State names a
      next agent with no commit following), NOT a mechanically enforced guarantee — say so.
- [x] AC6: **Single active pipeline per issue + worktree transition (Chesterton).** State the
      invariant: one active pipeline per issue. Define worktree creation/entry as part of the
      approval→implement transition (per CLAUDE.md's worktree rule), so state is written on the issue
      branch and a resumer reconciles against ground truth rather than trusting `main`'s stale copy.
- [x] AC7: `commands/spec.md` step 7 begins implementation immediately on "approved" (no separate
      command); `commands/witness.md` presents for ship on pass and routes per AC3 on fail — both
      updating Pipeline State.
- [x] AC8: No regression / internal consistency — the auto-router respects the #2 gate (green → ship
      gate; gate-block → evidence-repair loop; AC-fail → re-implement loop); `witness` stays mandatory;
      the override is never a loop exit; playbook, system, and CLAUDE.md agree.

## Design Notes

**Why this is safe now (depends on #2).** "Don't stop between agents" only works if pass/fail is
mechanical — otherwise "seamless" means "rubber-stamp." #2's witness gate makes the verdict a
machine check, so the pipeline can self-route: green advances, red loops back. #3 is the routing;
#2 is the judge.

**Two human gates, everything else automatic.** The human decides exactly twice: *approve the
spec* and *ship ("go")*. Between those, spec-approval auto-starts implementation, implementation
auto-runs `/witness`, and witness either presents for ship (pass) or loops back (fail). This is
the "without stopping" Josh asked for, without removing the two decisions that genuinely need him.

**Bounded, from ground truth — not honor system (Chesterton).** The bound is derived by counting
committed bounces (Review History / verification.jsonl fail-lines), not a self-incremented field the
looping agent could forget or reset. A failure surviving 2 rounds is probably a bad spec — a human
decision. And the two red states are NOT the same: a **gate-block** means "capture the missing
evidence and re-witness," an **AC-fail** means "re-implement." Routing both to re-implement burns
retries on non-code problems and pressures the agent toward the `CATALINA_WITNESS_ALLOW` override —
so the override is explicitly *never* a loop exit; escalation to the human is.

**Pipeline State is advisory, ground truth is authoritative (Chesterton).** The block makes a stall
legible on resume (a named next-agent with no following commit) — that's detection, not enforcement.
A resumer reconciles it against labels + verification.jsonl + git log and, on conflict, trusts ground
truth — never skips witness on a stale read.

**Git-as-memory (no new system).** Pipeline State is a block in tracking.md, not a database. A
resumed or compacted session reads `## Pipeline State` to know the current phase, the next agent,
and how many retries have happened. Fits the ILR's "git history is the memory" principle.

**Mostly convention, honestly.** "Never idle without handoff" and the auto-chain are behavioral
contracts, not mechanically enforceable from inside a turn — this issue ships the rules + the
state artifact that make the behavior legible and resumable, not a daemon. Call that out.

**Files touched:** `reference/ilr-playbook.md` (+contract), `reference/ilr-system.md` (+pipeline,
+guardrail, +template block), `commands/spec.md` (+auto-implement, +state block/update),
`commands/witness.md` (+routing, +state update), `CLAUDE.md` (+gates, +never-idle).

## Pipeline State
- Current phase: **witness complete / awaiting ship**
- Next agent: — (human ship gate)
- Bounce count: 0

## Premortem
(Chesterton, ranked by likelihood × cost)

- **Runaway / silent-reset loop — the retry bound isn't honored** — early sign: the same AC or
  gate-block reason appears in 3+ consecutive witness reports; Review History shows >2 bounces while
  Pipeline State still reads a low count. Mitigation: AC3 derives the bound from committed ground
  truth (Review-History bounces / verification.jsonl fail-lines), not a mutable self-incremented
  field; mechanical PreToolUse bound noted as a follow-up.
- **Gate-block routed as re-implement, then override used to escape the loop** (highest cost —
  defeats #2) — early sign: `CATALINA_WITNESS_ALLOW` in history/commits; exit-2 blocks logged as AC
  fails; retries burned on evidence problems while code was fine. Mitigation: AC3 splits routing
  (gate-block → evidence-repair + re-witness; AC-fail → re-implement); override is never a loop exit;
  escalation is the only sanctioned exit; override use is logged.
- **"Seamless" erodes the two gates into rubber stamps** — early sign: ship-gate turnaround → 0;
  witness reports trend to "all green" with thinner evidence; Deming shows falling push-back rate.
  Mitigation: keep the ship gate friction-ful (the witness report must name the single most-likely
  regression, not just a pass tally); track push-back rate as a pipeline-health metric.
- **Auto-implement races a human who wasn't done deciding** — early sign: a follow-up within seconds
  of "approved", or "go" said at the spec gate. Mitigation: AC2 — don't overload "go"; same-turn
  follow-up = amend; emit "starting implementation — last call to amend."
- **Resumed session trusts stale Pipeline State** — early sign: label disagrees with the state block;
  verification.jsonl newer than the block; a worktree exists but main's tracking says spec-phase.
  Mitigation: AC4/AC6 — Pipeline State is advisory; reconcile against labels + verification.jsonl +
  git log; ground truth wins; never skip witness on a bad read.

## Cache Invalidation Plan
None — docs/convention + tracking-template change.

## Review History
{Empty.}

## Witness
- [x] Spec approved
- [x] Implementation complete
- [x] Deployed / runnable
- [x] Witnessed
