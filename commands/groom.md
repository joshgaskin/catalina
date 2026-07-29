---
description: "Triage open issues and recommend next actions"
allowed-tools: Bash, Read, Glob
---

# /groom — Session Triage

Triage open GitHub issues and present a dashboard.

## Input

- Optional issue number to focus on: $ARGUMENTS

## Steps

1. **Fetch all open issues:**
   ```bash
   gh issue list --state open --json number,title,labels,assignees,updatedAt --limit 50
   ```

2. **Fetch open PRs and map them to issues (DO NOT SKIP):**
   ```bash
   gh pr list --state open --json number,title,headRefName,createdAt,body,statusCheckRollup --limit 30
   ```
   Map each PR to its issue via `Closes #N` / `Refs #N` in the body or an `issue-N-*` branch name.

   This step exists because of a recurring failure mode: **a PR gets built (sometimes witnessed), never merged, falls out of view, and a later session re-triages, re-decides, or re-builds the same issue** — occasionally contradicting decisions already embodied in the built PR. An open PR is the single most important fact about an issue. Rules:
   - An issue with an open PR must NEVER be listed under Needs Triage or re-opened for design decisions without the PR called out first — check the PR body/thread for decisions already made there.
   - Before proposing to spec or build anything, confirm nothing in the open-PR list (or a recently-merged PR) already covers it.

3. **Group by label:**
   - `dev/design` — spec in progress
   - `dev/implement` — build in progress
   - `review` — waiting for witness
   - `blocked` — needs unblocking
   - `epic` — business outcome containers
   - Unlabeled — needs triage

4. **Check tracking status:**
   For each non-epic issue, check if `.claude/tracking/issue-{N}/tracking.md` exists. If it does, read it and summarize:
   - How many DoD items are checked?
   - How many AC are checked?
   - Current stage (spec/implement/witness)

   **Check for recent observations:**
   For each issue, check GitHub comments for observation markers from the last 7 days:
   ```bash
   gh issue view {N} --json comments -q '[.comments[] | select(.body | contains("<!-- observation:"))] | length'
   ```
   If observations exist, count them by type (failure/success/friction/insight) for the dashboard indicator.

5. **Witness-evidence sweep (the enforcement guarantee).** For every issue currently labelled
   `review`, run the shared validator. This catches issues that reached `review` by ANY path —
   the `gh` Bash gate, the GitHub MCP tool, `gh api`, or a human hand — not just the hook's path:
   ```bash
   node ~/.claude/hooks/lib/verify-witness.js {N}   # (hooks/lib/verify-witness.js in the Catalina source repo)
   ```
   Exit 0 = evidence valid. Exit 1 = **INVALID** — surface it prominently ("#N is in `review` but
   its verification.jsonl is incomplete or fake: <reasons>") and recommend reverting it to
   `dev/implement` until it's witnessed for real. This is the layer the label-flip hook can't be
   routed around.

6. **If a specific issue number was provided** ($ARGUMENTS), focus the deep dive on that issue — show full tracking.md status, recent activity, and recommended next step.

7. **Present dashboard:**

   ```
   ## Built — waiting to merge (highest leverage: one command from shipped)
   - PR #30 -> #12 Feature X — checks green, 3 days old — merge it or state what's blocking

   ## Review (waiting for witness)
   - #12 Feature X — all AC verified, ready to witness
   - #8 Feature W — STALE (5 days in review) — needs attention

   ## In Flight
   - #15 Feature Y — dev/implement, 3/5 AC done — 2 observations (1 failure)
   - #18 Feature Z — dev/design, tracking.md drafted

   ## Blocked
   - #20 Integration W — waiting on API key from vendor

   ## Epics
   - #10 Epic: Q2 Launch — 2/5 sub-issues closed

   ## Needs Triage
   - #22 Bug report from customer — no label, no tracking
   ```

8. **Flag stale reviews and stale PRs:**
   For any issue with the `review` label, check `updatedAt`. If it's been >2 days, mark it as **STALE** in the dashboard. Stale reviews mean witnessing hasn't happened yet — surface them prominently.
   Apply the same rule to PRs: any open PR with green checks older than 2 days is **STALE — BUILT BUT UNMERGED**. These outrank everything else in the dashboard: the work is already done and rotting, and every day unmerged invites merge conflicts or duplicate effort.

9. **Recommend next action** for each issue. Be direct:
   - "Built and green — merge it (or say what's blocking); do NOT re-open design questions the PR already answers"
   - "Ready for your witness — review the evidence"
   - "STALE — been in review for X days, needs your attention"
   - "Spec drafted — needs your review"
   - "Blocked on X — can you unblock?"
   - "No tracking yet — want me to /spec this?"
