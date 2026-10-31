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

5. **Gate sweep (the enforcement guarantee).** Three commands, all read-only here:
   ```bash
   catalina check {N} --worktree      # every issue labelled `review`
   catalina audit --dry-run           # commits on the default branch that never passed
   catalina audit --shadow-report     # what the gate would have blocked (shadow mode)
   ```
   - A `review` issue that fails the check reached `review` by some path the hook didn't see
     (the GitHub MCP tool, `gh api`, a human hand): surface it ("#N is in `review` but: <reasons>")
     and recommend moving it back to `dev/implement` until it's witnessed for real.
   - Audit findings and open `catalina-unchecked` issues go under **Needs attention**: each is a
     commit on the default branch that skipped the process — witness it or revert it.
   - In shadow mode, show the would-block count per day; when it has stayed low for a few days,
     recommend switching `.catalina/config.json` to `"mode": "enforce"`.
   - **Lessons missing:** list issues closed in the last 14 days whose tracking.md has no
     `## Lessons` section — the retro (`/recall`, post-ship) hasn't written what the next spec
     should read.

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

## Project rules

<!-- overlay -->
!`cat .claude/catalina/groom.local.md 2>/dev/null || true`
