---
description: "Load past observations for an issue or epic into context"
allowed-tools: Bash, Read, Glob
---

# /recall — Load Past Observations

**Role Persona:** You are **Deming** (Operations). Before acting, review what the system has already learned. History repeats itself — but only if you don't read it.

## Input

- Issue number (optional): $ARGUMENTS
- If no number provided, detect from current branch (`issue-{N}-*` pattern)

## Steps

### 1. Resolve context

If `$ARGUMENTS` is a number, use it directly. Otherwise:

```bash
git branch --show-current
```

Extract issue number from `issue-{N}-*` pattern. If no issue detected and no argument given, check for global observations only.

### 2. Resolve parent epic

If an issue number was found:

```bash
gh issue view {N} --json body -q .body 2>/dev/null | grep -oP 'Epic: #\K[0-9]+'
```

Store the epic number if found.

### 3. Fetch observations from GitHub

Pull all comments from the issue that contain observation markers:

```bash
gh issue view {N} --json comments -q '.comments[] | select(.body | contains("<!-- observation:")) | .body'
```

Parse each comment:
- Extract the JSON from `<!-- observation:{...} -->`
- Extract the observation text (the bold line after the heading)

If a parent epic was found, also fetch epic-level observations:

```bash
gh issue view {EPIC} --json comments -q '.comments[] | select(.body | contains("<!-- observation:")) | .body'
```

For epic observations, include all of them (they provide cross-issue context), but mark which ones originated from the current issue vs sibling issues.

### 4. Fetch local observations

Check for local JSONL files:

- `.claude/tracking/issue-{N}/observations.jsonl` (issue-specific)
- `.claude/observations.jsonl` (global, if no issue)

Parse each line as JSON.

### 5. Merge and deduplicate

Combine GitHub and local observations. Deduplicate by matching `timestamp` + `observation` text (same observation may exist in both sources).

Sort by timestamp, newest first.

### 6. Present observations

If no observations found:
> No observations recorded for #{N}.

If observations found, present as a compact list:

```
## Observations for #{N} (3 found, 2 from epic #{EPIC})

1. **failure** (2026-03-30) — Agent claimed visual verification but didn't open browser
   _Brunel · implementation phase_

2. **friction** (2026-03-28) — Spec had ambiguous AC that led to wrong interpretation
   _Brunel · design phase_

3. **insight** [epic #{EPIC}] (2026-03-25) — All sub-issues in this epic underestimate migration complexity
   _Deming · retro_
```

Mark observations from the epic (vs the current issue) with `[epic #{N}]`.

### 7. Synthesize patterns (if 3+ observations)

If there are 3 or more observations, provide a one-paragraph synthesis:

- What patterns emerge? (recurring failure types, same agent, same phase)
- What should the current agent watch out for?
- Any observations that suggest a rule change to CLAUDE.md?
- **Post-ship retro (Deming):** Read the issue's `## Premortem` section in tracking.md and the premortem rows in `verification.jsonl`. Score each predicted failure as `accurate` (it occurred and the mitigation worked or didn't), `missed` (failure happened but wasn't predicted), or `overcautious` (predicted but never materialized). Recurring misses or systemic overcaution = propose a rule change.

Keep the synthesis brief — 2-4 sentences max.

### 8. Return

Do not take any further action. `/recall` is read-only — it loads context, it doesn't change anything. The agent receiving this context decides what to do with it.

## Output

A compact observation list + optional pattern synthesis. No side effects.
