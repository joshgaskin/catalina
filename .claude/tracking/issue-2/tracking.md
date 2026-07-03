# Issue #2: Harden /witness so visual verification can't be skipped

## Definition of Done
- [x] `hooks/witness-gate.js` — a PreToolUse hook that BLOCKS the `dev/implement → review`
      label-flip command unless `verification.jsonl` validates.
- [x] `verification.jsonl` schema gains `observable` (bool) + `artifact` (path) fields, and
      `commands/witness.md` documents them.
- [x] `commands/witness.md` closes the escape hatches (no `pass`+`method:none`; `needs_human`
      names the human action and blocks auto-ship; fail-loud/halt when no browser/runtime),
      requires an on-disk artifact for every observable AC, and spawns Feynman as a genuinely
      separate subagent (only tracking.md + running output).
- [x] `install.sh` hook-wiring reminder lists `witness-gate.js`; `reference/ilr-system.md`
      guardrail reflects that the witness gate is now enforced, not prose.

## Acceptance Criteria

**Architecture pivot (Chesterton).** A PreToolUse Bash gate cannot be the *sole* enforcement —
the `review` flip can bypass it via the GitHub MCP `issue_write` tool, `gh api …/labels`,
wrappers, or quoting variants, and the hook is inert until wired into settings.json. So
enforcement is **two layers**: (1) a **state-based validator** that is the real guarantee — any
issue sitting in `review` must have a valid `verification.jsonl`, checked by a shared module and
run from `/groom` (and optionally a PostToolUse sweep), catching every label-flip path uniformly;
(2) the **PreToolUse gate** as first-line defense-in-depth on the common `gh issue edit` Bash
path. Docs must claim only what's true by default.

### Shared validator (the real guarantee)
- [x] AC1: A single reusable validator (`hooks/lib/verify-witness.js` or equivalent) takes an
      issue number, loads `.claude/tracking/issue-<N>/tracking.md` + `verification.jsonl`, and
      returns pass/fail + human-readable reasons enforcing: (a) every AC in tracking.md has a
      matching line; (b) no `result:"pass"` with `method:"none"`; (c) every observable AC is
      `visual`/`both` with an `artifact` that **exists, is non-trivial (>1KB), and isn't
      byte-identical to another AC's artifact** (anti-fakery); (d) no premortem `outcome:"occurred"`;
      (e) `needs_human` lines name a human action and block auto-ship (don't count as pass).
- [x] AC2: **Observable is default-on, and not the builder's to downgrade.** An AC is treated as
      observable unless its line has `observable:false` WITH a non-empty justification; the
      validator additionally flags as suspicious any `observable:false` on AC text matching a UI
      keyword heuristic (render/page/screen/button/visible/browser/UI). The `observable`
      classification is assigned by the independent Feynman subagent, not the implementer.
- [x] AC3: **State sweep** — `/groom` runs the validator against every issue currently labelled
      `review` and surfaces any that fail ("in review but evidence invalid — auto-revert?"),
      independent of how the label was set (MCP, gh api, human). This is the layer that isn't
      bypassable by choosing a different label-setting surface.

### PreToolUse gate (defense-in-depth)
- [x] AC4: `hooks/witness-gate.js` reads PreToolUse JSON (`tool_input.command`), same contract as
      `pre-tool-guardrail.js`. It matches a review-flip robustly — the exact `review` token (not a
      substring, so `in-review`/`reviewed` don't trip it), tolerant of quoting/flag order, and
      extracts `<N>` from positional, `#N`, or URL forms. It calls the AC1 validator and **exits 2**
      on failure, **exit 0** when valid.
- [x] AC5: **Engage only for ILR flips; fail-closed within them.** If `.claude/tracking/issue-<N>/`
      does NOT exist → pass through (not an ILR issue; don't block human/other relabels in a
      portable install). If it exists but `verification.jsonl` is missing/unparseable, OR the
      command is a review-flip whose `<N>` can't be parsed → BLOCK (exit 2). Escape hatch
      `CATALINA_WITNESS_ALLOW=1` overrides, printing a loud "gate bypassed" notice.
- [x] AC6: Witnessed — a fixture issue with a deliberately broken `verification.jsonl` is blocked
      (exit 2 + the right reason) for **each** rule a–e via real hook invocations; a complete one
      passes (exit 0); a non-ILR `gh issue edit … --add-label review` (no tracking dir) passes.

### Command + schema + wiring
- [x] AC7: `commands/witness.md` documents the schema (`observable`, `artifact`) with an example
      and the closed escape hatches: `pass`+`method:none` banned; `needs_human` names the human
      action + why and blocks auto-ship; **no browser/runtime available → HALT ("cannot witness")**,
      never downgrade to programmatic.
- [x] AC8: `commands/witness.md` spawns **Feynman as a separate subagent** when any AC is
      observable — seeded with ONLY tracking.md + running/deployed output, never the build
      transcript — and its tool grant **explicitly includes the `mcp__claude-in-chrome__*` set**
      (subagents don't inherit the command's allowed-tools). If it can't get browser tools, it
      HALTS. It returns per-AC verdicts + the `observable` classification + artifact paths
      (completion-report contract).
- [x] AC9: **Enforcement claim is true by default.** `install.sh` idempotently registers
      `witness-gate.js` as a PreToolUse(Bash) hook in settings.json (not just a printed reminder),
      AND `/witness` step 0 self-checks the hook is registered + warns loudly if not.
      `reference/ilr-system.md` Guardrail 3 states enforcement accurately (state-sweep guarantee +
      hook defense-in-depth), not an over-claim.
- [x] AC10: No regression — `witness.md` keeps its premortem-vs-actual check, programmatic step,
      and gemba/browser step; `node --check` passes for the hook + validator; `bash -n install.sh`
      passes.

## Design Notes

**Two layers, honest about each (Chesterton).** The PreToolUse gate reuses the shipped
`pre-tool-guardrail.js` pattern (reads `tool_input.command`, exit 2 blocks) on the common
`gh issue edit … --add-label review` Bash path — but that path is NOT the only way to set the
label (GitHub MCP `issue_write`, `gh api`, wrappers all bypass it), so the gate is
**defense-in-depth, not a hermetic seal**. The real guarantee is the **state-based validator**
run from `/groom`: it revalidates every issue sitting in `review` no matter how the label got
there, and the same validator module backs the hook so the rules are defined once. Both layers
share `hooks/lib/verify-witness.js`.

**Observable flag drives machine-checkability.** The hook can't infer which AC are UI-observable,
so the schema carries it: each `verification.jsonl` AC line gets `"observable": true|false`.
Observable ones must be `visual`/`both` with an `artifact` path that resolves on disk (relative
to repo root, e.g. `.claude/tracking/issue-<N>/evidence/ac3.png`). "No artifact, no pass" becomes
a file-existence check, not a vibe.

**Fail-closed is the whole point.** Unlike the destructive-command guardrail (which fails OPEN so
it never blocks legit work), a review-flip with missing/garbage evidence must fail CLOSED — that
absence is exactly the failure we're catching.

**Separation made real.** Today `/witness` runs inline in the building session, so "Feynman with
fresh eyes" is nominal. When observable AC exist, spawn a subagent seeded with only tracking.md +
the running output; it returns verdicts + artifact paths. The gate then validates those artifacts.

**Wiring (auto, per Josh).** `install.sh` now idempotently registers `witness-gate.js` as a
PreToolUse(Bash) hook in `~/.claude/settings.json` (node-based merge — preserves existing hooks
+ config), so the gate is live by default rather than dormant. `/witness` step 0 also self-checks
the registration and warns loudly if it's missing (e.g. a hand-install).

**Enables #3.** Once pass/fail is mechanical (this gate), the pipeline can self-route green→review
/ red→back without human adjudication — the prerequisite for #3's seamless handoff.

## Premortem
(Chesterton, ranked by likelihood × cost)

- **Gate shipped but never wired — everyone believes visual verification is enforced; it isn't**
  — early sign: a `review`-labelled issue with a missing/`method:none` verification.jsonl sails
  through, or `grep witness-gate .claude/settings.json` is empty on a real install. Mitigation:
  AC9 — auto-wire idempotently in install.sh + `/witness` step-0 self-check; never let
  ilr-system.md claim enforcement the default lacks.
- **Agent flips the label off the Bash path (MCP `issue_write` / `gh api` / wrapper) — gate never
  sees it** — early sign: issues reach `review` with no corresponding block event. Mitigation:
  AC3 state sweep in `/groom` revalidates every `review` issue regardless of how the label was set;
  the PreToolUse gate is explicitly defense-in-depth, not the guarantee.
- **Separate Feynman subagent can't actually witness — spawned without the claude-in-chrome tools**
  — early sign: subagent returns `needs_human`/`method:none` for every observable AC, or no
  screenshots, on the first UI run. Mitigation: AC8 pins `mcp__claude-in-chrome__*` into the
  subagent's grant (verify inheritance explicitly) and HALTS if unavailable; AC6 fixture asserts
  artifacts were actually captured.
- **`observable:false` becomes the new escape hatch** — early sign: verification.jsonl trends to
  all-`observable:false`/all-programmatic even on UI-heavy issues. Mitigation: AC2 default-observable
  + required justification + UI-keyword heuristic + classification assigned by the independent
  subagent, not the builder.
- **Artifact-existence check passes on a committed-but-fake file** — early sign: 0-byte/identical/
  stale artifacts. Mitigation: AC1 checks non-trivial size + non-identical across ACs; the
  fresh-eyes subagent generates them during the real browser run so a hand-planted file is
  out-of-band. (Existence is necessary, not sufficient — call this out honestly.)

## Cache Invalidation Plan
None — tooling/hook + docs change. No derived-data cache affected.

## Review History
{Empty.}

## Witness
- [x] Spec approved
- [x] Implementation complete
- [x] Deployed / runnable
- [x] Witnessed
