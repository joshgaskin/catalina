# Issue #5: Add mechanical teeth to the auto-retry bound (PreToolUse hook)

## Definition of Done
- [x] `hooks/retry-gate.js` — a PreToolUse hook that BLOCKS a 3rd `dev/implement` re-entry for an
      issue, counting bounces from committed ground truth.
- [x] `commands/witness.md` logs a **machine-countable** bounce marker to `## Review History` on each
      fail-route; `reference/ilr-system.md` documents the marker + that the bound is now hook-enforced.
- [x] `install.sh` idempotently wires `retry-gate.js` into settings.json.

## Acceptance Criteria
- [x] AC1: `hooks/retry-gate.js` reads PreToolUse JSON (`tool_input.command`), same contract as
      `witness-gate.js`. On a match of `gh issue edit <N> … --add-label dev/implement`, it counts
      line-leading `- BOUNCE:` markers **only within the `## Review History` section** of
      `.claude/tracking/issue-<N>/tracking.md` and **exits 2 (block)** when the count is **≥3**
      (the 3rd retry), else **exit 0**. Non-matching commands pass through.
- [x] AC2: **Recurring choke point (Chesterton — the inert-gate fix).** The gated action must recur
      per bounce, else the gate never fires (on a witness FAIL the issue *stays* `dev/implement`). So
      `commands/witness.md`'s fail-route (a) appends `- BOUNCE: {reason}` to `## Review History`, then
      (b) **re-asserts `gh issue edit <N> --add-label dev/implement`** to begin the next cycle — that
      re-assert is what the gate fires on.
- [x] AC3: **Correct threshold, disambiguated (Chesterton off-by-one).** "2 retries (3 build
      attempts)": cycle1 flip@0 markers, cycle2@1, cycle3@2 all pass; cycle4@3 blocks. Block at ≥3.
      `reference/ilr-system.md` states this exactly so Feynman's #3-equivalence check agrees.
- [x] AC4: **Section-scoped counting (Chesterton false-positive fix).** Only line-leading `- BOUNCE:`
      inside `## Review History` counts — mentions in Design Notes / prose / code fences do NOT (else
      the gate would block issue #5's own first transition). Proven on a fixture whose Design Notes
      contains the literal marker.
- [x] AC5: **Engage only for ILR; robust match; honest override.** No `.claude/tracking/issue-<N>/`
      → pass through. Exact `dev/implement` token (quoting/flag-order tolerant), `<N>` from
      positional/`#N`/URL, fail-closed if a dev/implement flip's `<N>` won't parse.
      `CATALINA_RETRY_ALLOW=1` overrides with a loud stderr notice; docs say the hook prints stderr
      only (does NOT post to the issue) and require a `- BYPASS:` line in Review History for audit.
- [x] AC6: `install.sh` idempotently registers `retry-gate.js` (+ `witness-gate.js`) as PreToolUse(Bash)
      hooks in settings.json; `retry-gate.js` copied by the `hooks/*.js` glob.
- [x] AC7: Witnessed — fixtures at 0/1/2/3 markers (allow/allow/allow/BLOCK), false-positive guard
      (Design-Notes marker not counted), non-ILR passthrough, unparseable-N fail-closed, escape hatch.
      `node --check` + `bash -n install.sh` pass. **Honest limitation documented:** the count is
      working-tree text, not git history — a Review-History rewrite could reset it (strong, not
      cryptographic); git-history derivation is a future hardening.

## Design Notes

**Mirrors `witness-gate.js` (proven pattern).** Same PreToolUse contract, same "engage only for ILR
issues", same exact-token match + N-extraction + fail-closed + loud escape hatch. The only new logic is
counting bounces.

**Bound from Review-History markers, and the recurring choke point (Chesterton's fixes).** The
countable signal is line-leading `- BOUNCE:` markers **inside `## Review History`** (verification.jsonl
is rewritten each witness so it can't carry history; Review History accumulates). Two fixes were
load-bearing: (1) **recurring choke point** — a witness FAIL doesn't flip the label (the issue stays
`dev/implement`), so the gated action wouldn't recur and the gate would be inert; witness.md's fail-route
therefore re-asserts `--add-label dev/implement` each cycle, and the gate fires on that. (2) **threshold**
— block at **≥3** markers = 2 retries allowed (cycle1@0, cycle2@1, cycle3@2 pass; cycle4@3 blocks),
matching #3's "2 retries, 3rd failure stops."

**Honest about the guarantee.** The count reads working-tree `tracking.md`, not git history — a careless
Review-History rewrite could reset it (strong, not cryptographic). Deriving from git-history BOUNCE
additions is a future hardening. Section-scoping the count (Review History only, line-leading) prevents
false-positives from marker mentions in Design Notes / prose.

**Files touched:** new `hooks/retry-gate.js`; edited `commands/witness.md` (BOUNCE marker),
`reference/ilr-system.md` (marker + guardrail), `install.sh` (wire + copy).

## Premortem
(Chesterton, ranked by likelihood × cost — all mitigated in the fixed design)

- **Gate inert — the re-implement never re-adds the label** — early sign: a real 3-bounce loop sails
  past with no BLOCK while fixtures pass. Mitigation (AC2): witness.md's fail-route explicitly
  re-asserts `--add-label dev/implement` each cycle so the gate has a recurring action to fire on.
- **Off-by-one escalates a cycle early** — early sign: escalates after 2 failures when a 3rd build was
  expected; Feynman's #3-equivalence check disagrees. Mitigation (AC3): block at ≥3 markers = 2 retries
  allowed; ilr-system pins "2 retries (3 attempts)".
- **First spec→implement blocked by marker false-positive** — early sign: issue #5's own dogfooding
  blocks because Design Notes contains `- BOUNCE:`. Mitigation (AC4): count only line-leading markers
  inside `## Review History`; proven on a fixture with the marker in Design Notes.
- **Count silently reset, bound disabled** — early sign: bounce count drops after a `/capture` /
  tracking rewrite. Mitigation: honest documentation (AC7) that the count is working-tree text, strong
  not cryptographic; git-history derivation filed as future hardening.
- **Double-bypass forces a bad ship with no trace** — early sign: `CATALINA_RETRY_ALLOW=1` +
  `CATALINA_WITNESS_ALLOW=1` both set, only stderr scrolls by. Mitigation (AC5): docs correct the
  "logged to issue" over-claim (hooks print stderr only) and require a committed `- BYPASS:` line in
  Review History for Deming's retro.

## Cache Invalidation Plan
None — hook + docs.

## Review History
- Chesterton (spec review) bounced the first design as **inert**: gating `--add-label dev/implement`
  fails because that flip doesn't recur per bounce (the issue stays `dev/implement`). Also flagged an
  off-by-one (block-at-≥2 = only 1 retry) and a false-positive risk (counting `- BOUNCE:` mentions
  outside Review History). Fixed: recurring choke point via re-assert (AC2), block-at-≥3 (AC3),
  section-scoped counting (AC4). (Recorded as prose, not a `- BOUNCE:` marker — this was a spec bounce,
  not a witness bounce.)

## Pipeline State
- Current phase: **witness complete / awaiting ship**
- Next agent: — (human ship gate)
- Bounce count: 0

## Witness
- [x] Spec approved
- [x] Implementation complete
- [x] Deployed / runnable
- [x] Witnessed
