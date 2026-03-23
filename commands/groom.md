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

2. **Group by label:**
   - `dev/design` — spec in progress
   - `dev/implement` — build in progress
   - `review` — waiting for witness
   - `blocked` — needs unblocking
   - `epic` — business outcome containers
   - Unlabeled — needs triage

3. **Check tracking status:**
   For each non-epic issue, check if `.claude/tracking/issue-{N}/tracking.md` exists. If it does, read it and summarize:
   - How many DoD items are checked?
   - How many AC are checked?
   - Current stage (spec/implement/witness)

4. **If a specific issue number was provided** ($ARGUMENTS), focus the deep dive on that issue — show full tracking.md status, recent activity, and recommended next step.

5. **Present dashboard:**

   ```
   ## Review (waiting for witness)
   - #12 Feature X — all AC verified, ready to witness
   - #8 Feature W — STALE (5 days in review) — needs attention

   ## In Flight
   - #15 Feature Y — dev/implement, 3/5 AC done
   - #18 Feature Z — dev/design, tracking.md drafted

   ## Blocked
   - #20 Integration W — waiting on API key from vendor

   ## Epics
   - #10 Epic: Q2 Launch — 2/5 sub-issues closed

   ## Needs Triage
   - #22 Bug report from customer — no label, no tracking
   ```

6. **Flag stale reviews:**
   For any issue with the `review` label, check `updatedAt`. If it's been >2 days, mark it as **STALE** in the dashboard. Stale reviews mean witnessing hasn't happened yet — surface them prominently.

7. **Recommend next action** for each issue. Be direct:
   - "Ready for your witness — review the evidence"
   - "STALE — been in review for X days, needs your attention"
   - "Spec drafted — needs your review"
   - "Blocked on X — can you unblock?"
   - "No tracking yet — want me to /spec this?"
