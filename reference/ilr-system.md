# Issue Lifecycle Router — System Reference

The ILR is how we build product. It's an E-Myth-based work management system that enforces structured refinement: every piece of work flows through design, spec review, implementation, witness, and production.

Adapted from the Wilsch AI ILR for a solo founder + AI pair.

---

## Foundational Principles

### Git History Is the Memory

Git is the single source of truth. There are no parallel memory systems.

- **Commits** (with `Refs #N` / `Closes #N`) = what happened, in what order
- **GitHub issues** (with witness comments) = what was decided and why
- **tracking.md + verification.jsonl** (committed artifacts) = spec + evidence
- **Commit messages** = the narrative

To recover context on any issue: `gh issue view {N}` + `git log --grep="#{N}"`. Everything is there. No session linking, no external docs, no conversation archives.

### Issues Are Cheap

Creating an issue is the cheapest action in the workflow. Never hold work in your head — capture it, then decide whether to act on it. Fast creation, fast closure, cascade creation on completion.

If in doubt, create the issue. It costs nothing to close one that turns out to be unnecessary.

### Closure Clarity

Every issue defines its done-state explicitly before work begins. Design is done when tracking.md exists with approved AC. Implementation is done when code ships and AC are witnessed. If you can't define "done", the issue is too vague — decompose it.

---

## Roles

| Role | Who | Responsibility |
|------|-----|----------------|
| Founder/Manager | Human | Creates epics, runs grooming, approves specs, witnesses on staging, decides scope |
| All execution | Claude | Explores, specs, implements, self-verifies |

---

## Refinement Pipeline

```
1. Create    → Issue exists with What + Why
2. dev/design → tracking.md produced with DoD + AC
3. Spec review → Human approves or pushes back
4. dev/implement → Code written against spec
5. review    → AC witnessed (visual + programmatic), evidence presented
6. Ship + Retro → Commit, push, close. Deming reviews the cycle.
```

Labels encode state. The label IS the status — no board needed.

| Label | Color | Meaning |
|-------|-------|---------|
| `epic` | Purple | Business outcome container |
| `dev/design` | Yellow | Spec phase |
| `dev/implement` | Green | Build phase |
| `review` | Blue | Waiting for witness |
| `blocked` | Red | External dependency |

---

## Auto-Handoff Pipeline

The ILR self-drives between phases. The human decides at exactly **two gates**; everything
between them is automatic.

```
spec ──approve──▶ implement ──done──▶ witness ──pass──▶ SHIP GATE ──"go"──▶ merge + retro
  ▲                                      │
  └──────────── bounce (bounded 2×) ◀────┘
```

- **Human gate 1 — approve the spec.** At the spec gate the only proceed word is **"approved"**.
  On approval, implementation begins immediately (no separate command); a resumer/parallel session
  enters the issue's worktree per the worktree rule. A same-turn follow-up (an extra AC, "oh also…",
  `/capture`) is an **amend, not a proceed** — the transition emits a one-line "starting
  implementation — last call to amend" so the old approve-then-a-beat pause survives.
- **Automatic — implement → witness.** When implementation reports complete (see the Completion
  Report Contract in the playbook), `/witness` runs automatically.
- **Automatic — routing on failure (bounded, split by red-state):**
  - **Witness-gate BLOCK** (exit 2 — evidence missing/fake): gather/repair the evidence and
    **re-witness**. Do NOT re-implement, and **never** use `CATALINA_WITNESS_ALLOW` to escape — the
    override is not a loop exit; any use is logged to the issue.
  - **AC FAIL** (wrong code): **re-implement**, then re-witness.
  - The bound is **2 bounces**, counted from committed ground truth (`## Review History` entries /
    `verification.jsonl` fail-lines), not a self-incremented field. On the 3rd failure, STOP and
    escalate to the human with a diagnosis — escalation is the only sanctioned exit from a failing loop.
- **Human gate 2 — ship ("go").** Witness pass → present evidence and stop. "go"/"ship" is valid
  **only here**, and means merge to `main` + retro.

**Pipeline State is advisory; ground truth is authoritative.** The `## Pipeline State` block in
tracking.md lets a compacted/resumed session see the current phase, next agent, and bounce count —
but on resume, reconcile it against ground truth (labels + `verification.jsonl` + `git log --grep`)
and, on conflict, trust ground truth. Never skip witness or re-run a phase on the state block alone.

**One active pipeline per issue.** Two sessions auto-driving the same issue race on labels and
Pipeline State — keep it single-writer.

---

## Agent System

### Design: Separate Concerns via Personas

Each ILR role gets a distinct agent personality — a historical figure used as a meme that encodes priorities, biases, and communication style. Roles that need to critique each other's work run as separate agent subprocesses so they have genuinely independent judgment.

### Delivery Agents (HOW)

**Brunel — Developer** (default mode)
Isambard Kingdom Brunel. Built bridges, railways, and steamships at impossible speed by making decisive engineering choices.
- Priority: Ship working code that satisfies the spec
- Bias: Speed and simplicity. Cut what isn't load-bearing.
- Active during: `/spec` (writing DoD+AC), implementation, `/capture`

**Feynman — Dev Lead** (review subprocess)
Richard Feynman. "The first principle is that you must not fool yourself — and you are the easiest person to fool."
- Priority: Quality gates. Does the spec make sense? Does the implementation match?
- Bias: Skepticism. Assumes broken until proven otherwise.
- Active during: `/witness` — spawned as a separate agent
- Premortem check: reads the `## Premortem` section of tracking.md and actively verifies each predicted failure mode. If a predicted failure `occurred`, witnessing fails regardless of AC pass-rate — the mitigation was missed or the spec was wrong.
- Critical rule: Feynman NEVER sees the Developer's implementation reasoning. Only the spec (tracking.md) and the deployed output. This prevents "I know why I did it this way" from biasing the review.

**Chesterton — SA** (design subprocess)
G.K. Chesterton. "Don't ever take a fence down until you know the reason it was put up."
- Priority: Architectural coherence + risk surfacing. Does this fit the system, and where will it fail?
- Bias: Long-term thinking. Reuse existing patterns; predict failure modes before they happen.
- Active during: `/spec` for every ticket — fence question + premortem. Effort scales to ticket size (lite paragraph for trivial, ranked 3–5 failure modes for non-trivial). Premortem findings persist in the `## Premortem` section of tracking.md so Feynman can check them at `/witness` and Deming can compare predicted vs actual at retro. Also owns `/foundation` at project start — the deliberate inverse of the fence question: on a greenfield with no fences yet, Chesterton builds the ones everything else will lean on before any feature is built against them.

**Darwin — JA** (exploration subprocess)
Charles Darwin. Spent years observing before theorizing. Catalogued everything.
- Priority: Thorough understanding before committing to a design
- Bias: Completeness. Surface one more unknown rather than miss it.
- Active during: `/probe`

**Alexander — Reductive Design** (greenfield consolidation subprocess)
Christopher Alexander. *A Pattern Language*: recurring needs become reusable patterns; the whole has a coherence no single piece carries alone.
- Priority: Coherence of the whole plan; factor recurring needs into shared, modular components
- Bias: Reduction across the plan — the complement to Chesterton's per-ticket conservation. Guards against premature abstraction (rule of three, WET-before-DRY, argue the null case)
- Active during: `/distill` (greenfield, over the whole spec set). **Unit of analysis is the plan, never a single spec** — a simplify-only pass means the pass wasn't needed.

### Domain Agents (WHAT)

Domain agents provide business judgment. They compose with delivery agents — e.g., Darwin explores + domain agent provides context, Brunel implements with domain rules, Feynman + domain agent review.

Not every issue needs a domain agent. Pure infrastructure work only needs delivery agents.

**Define your domain agents in your project's CLAUDE.md.** Example domains:

| Agent | Domain | One-liner |
|-------|--------|-----------|
| **Deming** | Operations + Process | "All others must bring data" — supply chain, inventory, continuous improvement |
| **Ogilvy** | Marketing | Data-driven creative, measures everything |
| **Pacioli** | Finance | Double-entry — every number must balance |
| **Nordstrom** | Customer | The customer's advocate inside the company |
| **Rams** | Creative | "As little design as possible" — function over decoration |

Customize these for your project — rename them, add new ones, remove irrelevant ones. The pattern is what matters: domain expertise separate from delivery execution.

### Composition Model

```
Human creates issue
    |
    v
Darwin explores + Domain agent provides context (if applicable)
    |
    v
Brunel specs + Chesterton (fence + premortem, every ticket) + Domain validates business logic
    |
    v
Human reviews spec
    |
    v
Brunel implements (with domain rules in mind)
    |
    v
Feynman witnesses (incl. premortem-vs-actual) + Domain verifies business sense
    |
    v
Human reviews evidence -> ships or pushes back
    |
    v
Deming retro -> save process learnings
```

---

## Epic Linking

Sub-issues reference their parent epic with a line in the issue body:

```
Epic: #{N}
```

Written by `/spec` during Phase 3 when the epic context is known. This enables:
- **Observation bubbling:** `/observe` posts to both the issue AND its parent epic
- **Cross-issue context:** `/recall` pulls observations from sibling issues via the epic
- **Groom visibility:** `/groom` can group sub-issues under their epic

Query epic for an issue: `gh issue view {N} --json body -q .body | grep -oP 'Epic: #\K[0-9]+'`
Find all sub-issues: `gh search issues "Epic: #{EPIC}" --state open`

---

## Observation System

Observations are structured comments on GitHub issues that capture agent behavior (good and bad) for future learning. They are the raw material for Deming retros and the "memory" that makes agents improve over time.

### How It Works

- **`/observe {type} {text}`** — Posts a structured comment on the current issue + its epic (if linked). Also writes to local JSONL as offline fallback.
- **`/recall [N]`** — Loads past observations from GitHub comments + local JSONL into agent context. Synthesizes patterns if 3+ observations exist.
- **Observations feed retros** — Deming reads observations when reviewing a shipped issue, looking for recurring patterns that warrant rule changes.

### Observation Types

| Type | When |
|------|------|
| `failure` | Agent did something wrong or unexpected |
| `success` | Agent did something notably well |
| `friction` | Process felt harder than it should |
| `insight` | A realization or pattern worth remembering |

### Comment Format

GitHub comments use an invisible HTML marker for machine parsing + visible human-readable body:

```markdown
<!-- observation:{"type":"failure","agent":"Brunel","issue":42,"timestamp":"2026-03-31T10:15:00Z","context":"implementation"} -->
## Observation: failure

**Agent claimed visual verification but didn't open browser**

_Brunel · implementation phase · 2026-03-31T10:15Z_
```

Epic comments include `"source_issue":{N}` in the JSON and show `from #{N}` in the heading.

### The "Mom's Watching" Effect

When agents know their past failures are visible and queryable, they behave better. `/recall` at the start of a session loads this context. The observations don't need to be perfect — the act of recording and surfacing them is what drives improvement.

---

## Tracking Artifacts

```
.claude/tracking/
  issue-{N}/
    tracking.md          # DoD + AC + design notes + review history
    verification.jsonl   # Per-AC evidence log from /witness
    observations.jsonl   # Local observation fallback (offline backup)
```

### tracking.md Template

```markdown
# Issue #{N}: {Title}

## Definition of Done
- [ ] {Concrete deliverable}

## Acceptance Criteria
- [ ] AC1: {Testable assertion}

## Design Notes
{Architecture decisions, files to modify, trade-offs}

## Premortem
{Top failure modes from Chesterton: `- **{Scenario}** — early sign: {x}; mitigation: {y}`}

## Review History
{Track review cycles — if this bounces 3 times, the spec was bad}

## Witness
- [ ] Spec approved
- [ ] Implementation complete
- [ ] Deployed to staging
- [ ] Witnessed on staging

## Pipeline State
- Current phase: {spec | implement | witness | ship}
- Next agent: {Brunel | Feynman | — }
- Bounce count: 0   (witness→implement bounces; derived from Review History — advisory, reconcile against ground truth on resume)
```

### verification.jsonl Format

One JSON line per AC:
```jsonl
{"ac": "AC1: Description", "result": "pass", "method": "visual", "observable": true, "artifact": ".claude/tracking/issue-{N}/evidence/ac1.png", "evidence": "..."}
```

Valid results: `pass`, `fail`, `needs_human`
Valid methods: `visual`, `programmatic`, `both`, `none`

`observable` (default true) marks AC with a visible surface; an observable AC must be
`visual`/`both` with an on-disk `artifact` (>1KB, unique) or the witness gate blocks the
`review` flip. `observable:false` needs an `observable_reason` and is rejected on UI-sounding
AC. `pass`+`method:none` is banned. See `hooks/lib/verify-witness.js` for the enforced rules.

---

## Branching and Commits

Branch from `main` as `issue-{N}-brief-slug`.

Every commit on an `issue-*` branch MUST include `Refs #N`, `Closes #N`, `Fixes #N`, or `Resolves #N`. A `commit-msg` hook enforces this — commits without a ref are rejected.

This ensures git history auto-links to issues. To find all work for any issue: `git log --grep="#N"`.

---

## Decomposition: Trunk-First

When decomposing an epic into sub-issues, don't plan the full tree upfront. Create only 2-3 issues to the first proof point — maximum scope toward the biggest unknown.

**Proof point types:**
- Technical assumption (does this library/API support what we need?)
- Data dependency (does the schema match our expectations?)
- Design decision (approach A or B?)

After the proof point resolves: decompose the next 2-3 issues. If it fails: pivot, blast radius limited to 2-3 items.

---

## Sub-Issue Quality Criteria

An issue that can't be definitively closed is a bad issue.

- **Title:** One verb, one outcome. If it needs "and", split it.
- **Scope:** Single deliverable. Not "add feature X and refactor Y."
- **Closability:** Can you write AC that prove this is done? If not, decompose further.

---

## Commands

| Command | Agent | Purpose |
|---------|-------|---------|
| `/foundation [tier]` | Chesterton | Lock day-zero decisions (see `reference/greenfield-foundations.md`) at project start |
| `/distill` | Alexander | Holistic reductive pass over a greenfield plan — simplify / consolidate / extract shared modules |
| `/spec {N}` | Brunel + Chesterton | Produce tracking.md with DoD + AC + premortem |
| `/probe {topic}` | Darwin | Deep exploration before design |
| `/groom [N]` | — | Triage open issues, flag stale reviews (>2 days) |
| `/witness {N}` | Feynman | Self-verify AC, check premortem-vs-actual, capture visual evidence, label `review` |
| `/capture {N} {what}` | Brunel | Mid-flight spec update |
| `/observe {type} {text}` | Deming | Record observation on issue + epic (non-disruptive) |
| `/recall [N]` | Deming | Load past observations into context |

---

## Guardrails

1. **Label lifecycle** — labels encode state transitions, managed by Claude
2. **Commit-msg hook** — rejects commits without issue refs on `issue-*` branches
3. **Witness is mandatory + enforced** — never skip `/witness`. The `dev/implement → review`
   flip is gated: `hooks/witness-gate.js` (PreToolUse, defense-in-depth on the `gh` Bash path)
   and the `/groom` witness sweep (the real guarantee — revalidates every `review` issue no
   matter how it was labelled) both run `hooks/lib/verify-witness.js`, which blocks any issue
   whose `verification.jsonl` is incomplete or whose observable-AC artifacts are missing/fake
4. **Deming retro** — after every "ship it"/"go", run `/recall` to load observations, then review the cycle for process gaps. Compare the issue's `## Premortem` against what actually happened — flag each predicted failure as `accurate` (occurred + mitigation worked or didn't), `missed` (failure happened but wasn't predicted), or `overcautious` (predicted but never materialized). Recurring premortem misses or systemic overcaution warrant a rule change to CLAUDE.md.
5. **Stale review detection** — `/groom` flags issues in `review` for >2 days
6. **Never idle without handoff** — an agent ends a turn by handing off to the next agent,
   escalating via `AskUserQuestion`, or posting a completion report. A silent end is a stalled
   pipeline. This is a convention that makes stalls *detectable on resume* (Pipeline State names a
   next agent with no following commit), not a mechanical guarantee.
7. **Auto-handoff routing** — the pipeline self-routes green→ship-gate / red→bounded loop (see
   Auto-Handoff Pipeline). `CATALINA_WITNESS_ALLOW` is never a loop exit; escalation to the human is.

---

## Quick Tasks Escape Hatch

Not everything needs the full lifecycle. Small fixes (< ~2 files, clear requirements) skip issues entirely. "Just do X" and it gets done. No issue, no tracking.md, no witness.

The lifecycle exists to prevent mistakes on complex work, not to slow down obvious fixes.

---

## Adapted from

Wilsch AI Issue Lifecycle Router. Based on Michael Gerber's The E-Myth Revisited (Chapter 15) and operational refinement by Marius Wilsch.
