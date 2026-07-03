# Catalina — Universal Project Rules

> These rules apply to every project that uses the Catalina OS.
> Project-specific rules go in the project's own CLAUDE.md.

## Beliefs

These encode how we think. Specific rules follow from these.

1. **Go to the Gemba.** Verify at the source. Don't trust reports, API responses, or "it looks right." Go look. _(Taiichi Ohno)_
2. **General rules over specific prohibitions.** Principles scale; one-liners don't. "Verify at the source" beats a list of 50 "don't do X."
3. **The conversation is the codebase.** Rules, personas, and observations are production code for AI behavior. Treat them with the same rigor.
4. **Small batch, then scale.** Prove it on 1–3 items before going wide. The cost of a wrong mass operation is catastrophic; the cost of a small test is nothing.
5. **Observe, don't assume.** When something goes wrong (or right), capture it with `/observe`. Without data, retros are guesswork.

## Coding Behavior

- State assumptions and surface tradeoffs before writing code
- Ask when uncertain; push back on suboptimal approaches
- Convert tasks into verifiable success criteria before starting
- Write tests first when adding or changing behavior
- For multi-step work, outline steps with verification checkpoints

### Asking the user

- **Always use the AskUserQuestion tool for clarifying questions**, not inline prose. This includes ILR interrogation phase (`/spec`), ambiguity resolution, decision points, and preference collection. Exception: follow-up clarification to a single answer that came back unclear — one-line prose is fine.
- Batch questions in a single AskUserQuestion call (tool supports up to 4). Don't trickle questions across turns.
- When you have more than 4 open questions, pick the 4 highest-leverage decisions and default sensibly on the rest — tell the user what you defaulted to.

### Small Batch First, Then Scale _(Belief 4)_
- For ANY bulk/mass operation, ALWAYS prove the approach works on 1-3 items first
- Visually verify the small batch is correct before scaling up
- Never run a mass operation assuming it will work because the code "looks right"

### Visual Verification Required _(Belief 1: Go to the Gemba)_
- NEVER claim something is "verified", "working", or "done" based on API responses, DB queries, or script output alone
- Always visually confirm changes in the browser (or have the user confirm) before declaring success
- If you can't visually verify, say so honestly

## Code Quality
- Always create documentation and tests for new or revised features
- Run linters/formatters before committing
- No unused imports or dead code
- Clean up throwaway scripts (debug, check, audit, fix) before moving on

## Development
- Always tell me which local port you're running the app on so I can test
- Don't ask me again for anything other than PRs or clarifying questions
- Always run database queries for me (don't just show them)
- For migrations, run them after creating
- NEVER modify production data without explicit user approval

## Issue Lifecycle (ILR)

Work flows through GitHub Issues with labels encoding state. Full system design: `.claude/reference/ilr-system.md`. Cheat sheet: `.claude/reference/ilr-playbook.md`.

**Flow:** Create -> `/spec` (dev/design) -> Josh approves -> implement (dev/implement) -> `/witness` (review) -> Josh ships -> Deming retro

**"Ship it" — or just "Go" — means merge to remote `main` immediately** — not just pushing a branch or opening a PR. "Ship", "ship it", and "go" are interchangeable ship triggers.

**The pipeline self-drives between two gates.** Josh decides at exactly two points — **approve the spec** and **ship ("go")**. On "approved", implementation starts automatically → `/witness` runs automatically → it stops for the ship decision. "Approved" is the only proceed word at the spec gate; **"go" means ship and is valid only at the ship gate.** On witness failure the pipeline auto-loops back — bounded to 2 bounces (counted from committed history), then escalates — and `CATALINA_WITNESS_ALLOW` is never a loop exit. Full design: `.claude/reference/ilr-system.md` (Auto-Handoff Pipeline). **Never idle without handoff:** an agent ends a turn by handing off to the next agent, escalating via `AskUserQuestion`, or posting a completion report — never a silent stop.

**Always (any change, any size):**
- Visually verify every change in the browser before declaring done
- Git history is the memory — no parallel tracking systems
- Update the project's `RELEASE_NOTES.md` (where it keeps one) in the **same commit** as the change — never a follow-up commit

**ILR issues (complex work, Josh creates an issue or says /spec):**
- `/witness` is mandatory — never skip it, never ask to skip it
- Commits on `issue-*` branches must include `Refs #N` or `Closes #N` (hook-enforced)
- Branch from `main` as `issue-{N}-brief-slug`
- **ALWAYS work in a dedicated git worktree** at `.claude/worktrees/issue-{N}` — never the main repo dir, since parallel Claude sessions step on each other. Create with `git worktree add .claude/worktrees/issue-{N} issue-{N}-brief-slug` and symlink the project's env file (e.g. `.env.local`) into it. Remove with `git worktree remove .claude/worktrees/issue-{N}` once merged.
- Tracking artifacts: `.claude/tracking/issue-{N}/tracking.md` + `verification.jsonl`
- After "ship it"/"go": Deming reviews the cycle for process gaps

**Quick tasks (Josh says "just do X"):**
- Make the change, visually verify in browser, done. No issue, no tracking artifacts.
