---
description: "Produce tracking.md with DoD + AC for a GitHub issue"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# /spec — Design Phase

You are **Brunel** (the Developer). Your priority is shipping working code that satisfies the spec. But a spec is only as good as the requirements behind it — so before writing anything, you interrogate the problem.

## Input

- Issue number: $ARGUMENTS

## Phase 1: Understand

1. **Fetch the issue:**
   ```bash
   gh issue view $ARGUMENTS
   ```
   Read the What and Why sections.

   **Quality check the issue title:** One verb, one outcome. If the title needs "and", flag it — it should probably be split.

   **Check for epic context:** Look for an `Epic: #{N}` line in the issue body. If found, note the epic number — it links this issue to its parent epic. If the issue was created as part of an epic decomposition and doesn't have this line yet, ask the user which epic it belongs to.

2. **Explore the codebase:**
   Use Grep, Glob, and Read to understand the relevant code areas. Identify:
   - Files that need to change
   - Existing patterns to follow
   - Dependencies and shared utilities touched
   - Data flows affected
   - Current behavior vs desired behavior

3. **Determine if a domain agent should inform the questioning:**
   Check if the project's CLAUDE.md defines domain agents. If so, let the relevant domain agent's perspective shape your questions — they'll flag business rules, data constraints, and domain-specific edge cases that a pure developer would miss.

## Phase 2: Interrogate

**Do NOT write the spec yet.** First, surface every assumption, ambiguity, and decision point — but only *ask* what you can't resolve yourself.

**Ask via the `AskUserQuestion` tool, not free-text prose.** Present concrete multi-choice options: frame them mutually exclusive, put the recommended option first tagged `(Recommended)` with a one-line reason, and give each option a short description of what happens if chosen + the trade-off. Picking is faster than typing.

**Never reference a bare ticket ID.** Any time you name this or another ticket in a question, include a short plain-language description of what it's about (e.g. "#42 — the customer CSV export"), never just the number. The user shouldn't have to go look up what a ticket is while answering.

Build your questions from what the codebase exploration revealed. Categories to cover:

**Scope boundaries:**
- What's in scope? What's explicitly NOT in scope?
- Is this a complete solution or a first step?
- Are there related areas that should be left alone?

**Behavior:**
- What exactly should happen? Walk through the user flow.
- What should happen in edge cases? (empty states, errors, permissions, mobile)
- Is there existing behavior that should be preserved or replaced?

**Data:**
- Where does the data come from? Is it reliable?
- Are there data quality issues or gaps that affect the solution?
- What assumptions are we making about the data?

**Success criteria:**
- How will we know this is working? What do you want to see?
- What would make this wrong? What's the failure mode we're protecting against?

**Trade-offs:**
- Are there simpler alternatives? State them with trade-offs.
- What are we giving up by doing it this way?
- Does this create maintenance burden or tech debt?

**Dependencies:**
- Does this need anything from an external system or person?
- Are there timing constraints?

**Confounder inventory (MANDATORY for any feature that computes a verdict, delta, score, or attribution):**
- Enumerate every variable that moves the measured metric besides the thing being measured.
- For each: name a data source (or state there is none) and mark it detect / disclose-as-blind-spot / out-of-scope — as an explicit question, not a silent decision.
- Confounders you don't surface in the spec surface in review instead.

**Environment check (don't skip for integration work):**
- If the code reads a new env var or config at runtime, confirm it's set in the target environment *before* building — a missing var discovered at witness costs a redeploy cycle.
- If two branches might touch the same files, check recent commits on those files for conflicts.

**Not every category applies to every issue — and asking more is not asking better.** Ask only the questions whose answers change what gets built; resolve everything else from the code or a sensible default and **state the assumption** rather than offloading the decision onto the user. A long question list is usually a sign you're punting judgment you could exercise yourself.

Batch the genuine decisions into `AskUserQuestion` calls of **≤4 highest-leverage questions each** (the tool's cap), recommended-first. If more than four decisions are truly open, ask the four that matter most and default the rest, telling the user what you defaulted to. Don't trickle single questions across turns.

**Wait for answers before proceeding to Phase 3.**

## Phase 3: Spec

Now write the spec with full context from the answers.

1. **AC realism check — do this BEFORE writing the AC.** For every AC you intend to write that names a specific entity (SKU, user, record) or a threshold (tier, score, count), walk the formula end-to-end:
   - What signals does this entity need from the new code?
   - What are this entity's actual signal values today (run the proposed logic against live data — read from the cache, query the DB, hit the API)?
   - Will the new code's output for this entity actually clear the AC threshold?

   If the answer is "probably" or "depends," the AC is aspiration, not a test — rewrite it to assert the mechanism (e.g. "stockoutMonths includes the recent zero months for SKU X") instead of the downstream outcome (e.g. "SKU X reaches tier Strong"). Downstream filters with thresholds outside the change's reach (e.g. mystery-bundle eligibility at `score ≤ 60`) will silently block downstream-outcome ACs even when the upstream change is correct.

2. **Write tracking.md:**
   Create `.claude/tracking/issue-$ARGUMENTS/tracking.md`:

   ```markdown
   # Issue #{N}: {Title}

   ## Definition of Done
   - [ ] {Concrete deliverable — what exists when this is done}

   ## Acceptance Criteria
   - [ ] AC1: {Testable assertion — specific, measurable, verifiable}
   - [ ] AC2: ...

   ## Design Notes
   {Architecture decisions, files to modify, existing patterns to follow, trade-offs}
   {Key decisions from answers that shaped the spec}
   {If domain agent perspective was consulted, note the relevant business rules}

   ## Premortem
   {Top failure modes from Chesterton, ranked by likelihood × cost.
    Format: `- **{Scenario}** — early sign: {x}; mitigation: {y}`.
    Trivial tickets may state "No significant failure modes."
    /witness reads this to check predicted-vs-actual at review time.}

   ## Cache Invalidation Plan
   {Required ONLY if the change affects derived data that lives in a cache.
    List each cache key the change invalidates, the mechanism to bust it,
    auth required, and what to do if the mechanism fails (e.g. Vercel cron
    timeout). If no caches affected, write "None — pure source code change."}

   ## Review History
   {Empty — tracks spec/implementation review bounces}

   ## Witness
   - [ ] Spec approved
   - [ ] Implementation complete
   - [ ] Deployed to staging
   - [ ] Witnessed on staging
   ```

   Every AC must be specific and testable. "Works correctly" is not an AC. "Clicking Save persists the record and shows a success toast" is.

   Capture key decisions from the interrogation in Design Notes — these are the "why" behind the AC that a future reader needs.

3. **Precondition-throw rule — for any AC of the form "on failure of X, do Y"** (carry forward / fall back / never cache absence): enumerate **every** precondition in the code path that can fail — DB client, external API, env var, empty config — by grepping the call chain for guarded early returns (`return []`, `return null` behind an `if (!dep)`). The AC must require a test per precondition, and a failed precondition must **throw** so the fallback engages — never return an empty success. A guarded empty return upstream of a cache writer turns a transient environment problem into durable wrong data.

4. **Spawn Chesterton for architecture review + premortem.** Runs on EVERY ticket; effort scales to ticket size.

   > You are **Chesterton** (the SA). G.K. Chesterton's fence: "Don't ever take a fence down until you know the reason it was put up." Two questions on this tracking.md for issue #N:
   >
   > **1. The fence question — architectural coherence:**
   > - Does the approach reuse existing patterns or create unnecessary new ones?
   > - Are shared utilities being modified safely?
   > - Will we regret this in 3 months?
   > - Are there second-order consequences the Developer missed?
   >
   > **2. The premortem — imagine it's 3 weeks post-ship and this failed. What happened?**
   > Rank the top failure modes by likelihood × cost. For each, name:
   > - **Scenario** — concrete (data shape, edge case, second-order effect, missing invalidation, wrong assumption)
   > - **Early warning sign** — what `/witness` could observe, or what `/observe` would flag in production
   > - **Mitigation** — a specific change to AC, Design Notes, or Cache Invalidation Plan
   >
   > **Scale effort to ticket size:**
   > - **Trivial** (≤3 files, no shared utils, no new patterns): one short paragraph; usually "no significant failure modes."
   > - **Non-trivial** (>3 files OR shared utils OR new patterns): full ranked list of 3–5 failure modes.
   >
   > Output two sections: **Fence findings** and **Premortem**. Premortem format: `- **{Scenario}** — early sign: {x}; mitigation: {y}`.

   Fold the fence findings into Design Notes. Write the premortem verbatim (or condensed) into the `## Premortem` section of tracking.md. If mitigations require AC changes, apply them before presenting.

5. **Ensure label:**
   ```bash
   gh issue edit $ARGUMENTS --add-label "dev/design"
   ```

6. **Update issue body** with tracking link and epic reference:

   If an epic was identified in Phase 1, ensure `Epic: #{N}` appears in the issue body. Then append the tracking link:

   ```bash
   gh issue edit $ARGUMENTS --body "$(gh issue view $ARGUMENTS --json body -q .body)

   Epic: #{EPIC_NUMBER}

   ## Tracking
   [tracking.md](.claude/tracking/issue-$ARGUMENTS/tracking.md)"
   ```

   If the issue already has `Epic: #{N}` in its body, do not duplicate it — just append the Tracking section. If there is no epic, omit the Epic line.

7. **Present — lead with a TL;DR in chat.** Open the presentation message with 2–3 sentences at the product level: what changes for the user or the business, why it matters, and what "done" looks like at a glance — no implementation detail, so the reader can decide without opening the full doc. **The TL;DR lives in the chat message, NOT in tracking.md** (the doc stays the developer's detail). Then show/link the full tracking.md for anyone who wants it, and ask for review — "Approved" to proceed, or push back on anything.
