# Issue #1: Port general-purpose enhancements from the Catalina build spec

## Definition of Done
- [x] `commands/foundation.md` exists — the `/foundation` day-zero-decisions command,
      Chesterton-voiced, using `AskUserQuestion`.
- [x] `reference/greenfield-foundations.md` exists — the tiered day-zero checklist the
      command walks.
- [x] `hooks/commit-msg` exists (executable) — rejects `issue-*` commits with no `Refs #N`.
- [x] `install.sh` installs the commit-msg hook into the target project's git hooks AND
      creates the 5 ILR labels (idempotent, gh-guarded).
- [x] The 5 ILR labels (`epic`, `dev/design`, `dev/implement`, `review`, `blocked`) exist in
      `joshgaskin/catalina`.
- [x] `commands/spec.md` uses `AskUserQuestion`, forbids bare ticket IDs, presents a
      product-level TL;DR in chat, and carries the confounder-inventory + precondition-throw
      rules — without losing its existing premortem / cache-invalidation / AC-realism content.
- [x] `reference/ilr-system.md` command table lists `/foundation`; docs no longer claim a
      commit-msg hook / labels that don't ship.

## Acceptance Criteria

### Labels out of the box
- [x] AC1: All 5 labels resolve via `get_label` in `joshgaskin/catalina` (created this cycle;
      `dev/design` already exists). **Color assertion (Chesterton P#4):** the 4 MCP-created
      labels land gray, so as a manual post-step this cycle, run the install.sh label block
      against `joshgaskin/catalina` itself to color them to match the doc — AC asserts the
      canonical repo's labels are the documented colors, not merely present. Runtime color =
      `needs_human` until Josh runs it (no gh this session).
- [x] AC2: `install.sh` contains an idempotent label-creation block: for each of the 5
      labels it runs `gh label create "<name>" --color <hex> --description "<d>" --force`.
      **Non-fatal + placed LAST (Chesterton fence + P#1):** guard with `command -v gh` AND
      `gh auth status`; each create is individually non-fatal (`|| echo "warn: ..."`) so a
      `set -e` abort can't strand the install mid-run; block sits at the end of install.sh.
      `bash -n install.sh` passes. Real install-time color/creation = `needs_human` (no gh
      this session).

### commit-msg hook
- [x] AC3: On a branch named `issue-*`, `git commit` with a message lacking any of
      `Refs/Closes/Fixes/Resolves #N` is **rejected** (non-zero exit, guidance printed).
      Verified by driving a real commit on a scratch `issue-*` branch.
- [x] AC4: On the same `issue-*` branch, a commit whose message includes `Refs #N` is
      **accepted**. On a non-`issue-*` branch, the hook exits 0 regardless of message.
- [x] AC5: `install.sh` installs `hooks/commit-msg` into the git-hooks dir **resolved via
      `git rev-parse --git-path hooks` (Chesterton fence + P#2)** — NOT hard-coded `.git/hooks/`,
      which silently no-ops under submodule/worktree (where `.git` is a file) and ignores
      `core.hooksPath`. It `chmod +x`es the hook and **reuses install.sh's existing `cmp`
      three-way idempotency logic** (ours-current → OK; ours-stale → update; foreign hook →
      warn+skip, never overwrite). If `core.hooksPath` points at a hook manager (Husky), warn
      instead of writing. `bash -n install.sh` passes.

### /foundation + greenfield-foundations
- [x] AC6: `commands/foundation.md` exists with valid frontmatter (`AskUserQuestion` in
      allowed-tools), is voiced as **Chesterton** (this repo's Architect), and instructs use
      of `AskUserQuestion` with recommended-first options + the never-bare-ticket-ID rule.
- [x] AC7: `reference/greenfield-foundations.md` exists with the 4 tiers (every row / every
      user / every page / operational spine) and the "10,000 rows / 500 users" test.
- [x] AC8: `reference/ilr-system.md` reflects `/foundation` in **both** the Commands table
      **and** Chesterton's "Active during" line (Chesterton fence) — framed as "Chesterton
      building the fence deliberately on greenfield," so the persona scope-expansion (reactive
      critic → proactive greenfield voice) is documented, not silently inconsistent.

### /spec discipline upgrades
- [x] AC9: `commands/spec.md` Phase 2 mandates the `AskUserQuestion` tool (recommended-first,
      mutually-exclusive options). **Reframe, not just substitute (Chesterton P#3 + Josh):**
      delete the "ask as many as necessary… fifteen… all at once, numbered, don't trickle"
      wording — it both contradicts AskUserQuestion's 4×4 cap AND rewards over-asking
      (offloading judgment onto the human). Replace with the *leverage* rule: ask only the
      questions whose answers change what gets built; resolve the rest from the code or a
      sensible default and **state the assumption**. Batch the genuine decisions into
      AskUserQuestion calls of ≤4 highest-leverage each, matching CLAUDE.md. Add
      `AskUserQuestion` to the frontmatter `allowed-tools`.
- [x] AC10: `commands/spec.md` contains the never-reference-a-bare-ticket-ID rule and a
      product-level **TL;DR-in-chat** presentation step — a **distinct beat** from the existing
      "present the full tracking.md" step (Chesterton), explicitly NOT written into tracking.md.
- [x] AC11: `commands/spec.md` contains a **confounder inventory** step (mandatory for
      verdict/delta/score/attribution features), an **environment-check** bullet (new env
      var/config confirmed set before building), and a **precondition-throw** rule (a failed
      precondition throws so the fallback engages — never cache an empty success as fact).
- [x] AC12: No-regression + coherence. `grep` confirms `commands/spec.md` still contains its
      premortem/Chesterton spawn, Cache Invalidation Plan, and AC-realism sections; that
      Phase 3 is **cleanly renumbered** (no duplicate "2." headers — Chesterton P#3); and that
      `AskUserQuestion` is present in `allowed-tools`.

## Design Notes

**Framing.** This is the "mine the build spec for general-purpose enhancements" issue, NOT the
`templates/` + `INSTALL.md` re-architecture (explicitly out of scope — decided with Josh).
The repo stays the pull-downstream OS; we only fill gaps and align commands with the repo's
own CLAUDE.md.

**Persona mapping.** The build spec uses `{{ARCH_AGENT}}` etc. This repo uses fixed
historical personas — Brunel (Dev), Feynman (Dev Lead), Chesterton (SA/Architect), Darwin
(JA/Explorer). `/foundation` → Chesterton. No `{{PLACEHOLDER}}` markers land in the repo;
everything is resolved to this repo's names/voice. `/foundation` references the user
generically ("you"/"the user"), matching the existing commands (which carry no founder name).

**Labels — two-layer delivery.** (1) *Now, in this repo:* create the 4 remaining labels by
assigning-then-resetting issue #1's label set (issue_write auto-creates them). They land gray
because no MCP tool sets label color/description. (2) *Out of the box / canonical:* `install.sh`
gains a gh-guarded, `--force` (idempotent) creation block with the colors + descriptions from
ilr-system.md. install.sh already lives in a gh-assuming world (the ILR commands use `gh`), so
this dependency is consistent. `bash -n` is the only runtime check available this session — gh
isn't installed here, so the install-time run is a `needs_human` (or verified next time Josh
runs install).

**Label definitions** (from ilr-system.md): epic=`8957E5` "Business-outcome container";
dev/design=`FBCA04` "Spec phase"; dev/implement=`0E8A16` "Build phase"; review=`1D76DB`
"Waiting for witness"; blocked=`B60205` "External dependency".

**commit-msg hook.** Bash hook from the build spec: only enforces on `issue-*` branches;
accepts Refs/Closes/Close/Fixes/Fix/Resolves/Resolve `#N` case-insensitively; exits 0 on all
other branches. `install.sh` installs it into `.git/hooks/commit-msg` (or `core.hooksPath`),
preserving/【warning on】an existing hook rather than silently overwriting. Also install it into
THIS repo's `.git/hooks` so it's live and testable here. It won't block this cycle's commits —
we're on `claude/new-session-bzcxmc`, not an `issue-*` branch — so AC3/AC4 are exercised on a
throwaway `issue-verify` branch (Josh chose: stay on the session branch, test on a scratch one).

**/spec upgrades — additive, not a rewrite.** spec.md is already strong (premortem, cache
invalidation, AC-realism). We ADD: (a) Phase 2 switches to `AskUserQuestion`; (b) the
never-bare-ticket-ID rule; (c) a confounder-inventory bullet; (d) an environment-check bullet;
(e) Phase 3 precondition-throw rule; (f) Phase 3 TL;DR-in-chat presentation. We REMOVE only the
"present numbered questions as prose" instruction that now contradicts CLAUDE.md. Add
`AskUserQuestion` to the command's allowed-tools frontmatter.

**No redundant link logic for the new files (Chesterton fence).** install.sh already globs
`commands/*.md` and `reference/*.md`, so `commands/foundation.md` and
`reference/greenfield-foundations.md` symlink downstream automatically. The ONLY install.sh
code additions are the label block and the commit-msg block — do not invent bespoke wiring for
the two content files.

**Files touched:** new — `commands/foundation.md`, `reference/greenfield-foundations.md`,
`hooks/commit-msg`; edited — `install.sh` (label block + commit-msg install + header/next-steps
comments), `commands/spec.md`, `reference/ilr-system.md` (commands table + Chesterton
"Active during" + reality-align the hook/label phrasing). Root `CLAUDE.md` left alone (its
rules already mandate the disciplines we're propagating).

## Premortem
(Chesterton, ranked by likelihood × cost)

- **install.sh label block aborts or silently no-ops where it matters** — early sign:
  installer exits before the "=== POW ===" banner, or labels missing when gh is
  present-but-unauthed / repo has no GitHub remote; witness must require a real install run in
  a scratch project. Mitigation: AC2 — per-label non-fatal, `gh auth status` guard, block last,
  `needs_human` until a real install is witnessed.
- **commit-msg hook doesn't install (`.git` is a file) or clobbers a Husky dispatcher** — early
  sign: bad commit on a scratch `issue-*` branch is *accepted* (hook never installed), or a
  project's `.husky/commit-msg` stops firing. Mitigation: AC5 — resolve via
  `git rev-parse --git-path hooks`, `cmp` three-way warn-and-skip, warn on `core.hooksPath`
  hook manager.
- **spec.md becomes self-contradictory or mis-numbered** — early sign: `grep` finds both
  "ask fifteen, numbered" and "use AskUserQuestion (max 4)", or Phase 3 keeps duplicate "2."
  headers. Mitigation: AC9 reconciles the batching guidance; AC12 grep-guards clean numbering +
  allowed-tools.
- **Gray labels contradict the documented colors → users distrust the system** — early sign:
  repo Labels page shows gray while docs/install promise Purple/Yellow/Green/Blue/Red.
  Mitigation: AC1 — run the label block against `joshgaskin/catalina` itself this cycle; assert
  color, not just existence.
- **The assign-then-reset label-creation trick strips issue #1's live `dev/design`** — early
  sign: issue #1 ends on the wrong label set. Mitigation: after create-by-assignment, re-assert
  issue #1's final label state = exactly `dev/design`.

## Doc-consistency sweep (Chesterton)
- `install.sh` header comment (the "What it does" list) and "Next steps" hook list must be
  updated to include the labels + commit-msg steps — no under-claiming after the edit.
- `reference/ilr-system.md` lines that state a commit-msg hook / labels already exist become
  TRUE only after this issue ships — keep phrasing consistent with the new reality (hook +
  labels now delivered), not aspirational.

## Cache Invalidation Plan
None — pure repo-content / tooling change. No derived-data cache is affected.

## Review History
{Empty — tracks spec/implementation review bounces.}

## Witness
- [x] Spec approved
- [x] Implementation complete
- [x] Deployed / runnable
- [x] Witnessed
