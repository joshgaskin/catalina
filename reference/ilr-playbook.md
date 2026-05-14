# ILR Playbook — Cheat Sheet

## Your 5 Moves

### 1. Create Work

- **Big outcome?** Create an Epic: `gh issue create` using the epic template. Title: `Epic: {outcome}`. Add sub-issues later or tell Claude to decompose.
- **Specific task?** Create a sub-issue: `gh issue create` using the sub-issue template. Fill in What + Why. Don't write AC — that's Claude's job via `/spec`.
- **Tiny fix?** Just say "do X." No issue needed.

### 2. Review the Spec

- **When:** Claude produces a tracking.md and asks you to review
- **Where:** `.claude/tracking/issue-{N}/tracking.md` (or Claude will paste the key parts)
- **What to check:** Do the Definition of Done items match what you actually want? Are the Acceptance Criteria testable and complete? Is anything missing or over-scoped?
- **Your call:** "approved" -> Claude implements. Push back -> Claude revises.
- **Meme equivalent:** "Is this what I ordered?"

### 3. Prioritize (Grooming)

- **When:** Start of a session, or anytime you say `/groom`
- Claude shows you what's in-flight, blocked, and waiting
- **Your call:** What's most important right now? What's blocked that you can unblock? Anything to kill?
- You don't need to manage a board — just tell Claude what to work on next

### 4. Review the Witness (Gemba is Claude's Job)

- **When:** Claude labels an issue `review` and presents visual evidence
- **What Claude did:** Opened staging in Chrome, navigated to the feature, interacted with the UI, captured screenshots/GIFs for each AC. Claude goes to the gemba so you don't have to.
- **What you see:** Verification summary with screenshots/GIFs + pass/fail per AC + verification.jsonl evidence log
- **What to do:** Review the visual evidence. Does it look right? Anything feel off? You can also spot-check staging yourself if you want, but Claude's visual proof is the primary evidence.
- **Your call:** "ship it" -> Claude merges and closes. Push back -> Claude fixes.
- **Trust but verify:** if something looks wrong in the evidence, go look yourself.

### 5. Decide Scope

- **When:** Claude flags via `/capture` that requirements changed or scope grew
- **Your call:** Absorb the extra scope into this issue? Split into a new issue? Cut it entirely?
- **Rule of thumb:** If it doubles the AC count, split it.

---

## The Roster

### Delivery (HOW)

| Name | Role | One-liner |
|------|------|-----------|
| **Brunel** | Developer | Builds fast, cuts what isn't load-bearing |
| **Feynman** | Dev Lead | "You must not fool yourself" — skeptical reviewer |
| **Chesterton** | SA | "Why was this fence here, and how will this fail?" — architectural guardian + premortem on every ticket |
| **Darwin** | JA | Observes everything before theorizing |

### Domain (WHAT)

Define domain agents in your project's CLAUDE.md. The delivery agents are universal; domain agents are project-specific. See `reference/ilr-system.md` for the pattern.

You can invoke them by name: "send in the Feynman", "what would Deming say about this", "Darwin this before we commit."

---

## Labels Cheat Sheet

| You'll see | It means | Your move |
|------------|----------|-----------|
| `dev/design` (yellow) | Claude is speccing it | Wait for spec, then review |
| `dev/implement` (green) | Claude is building it | Wait for witness request |
| `review` (blue) | Ready for you on staging | Review the visual evidence |
| `blocked` (red) | Can't proceed | Unblock it (info, decision, or external action) |
| `epic` (purple) | Business outcome container | Check sub-issue progress |

---

## After You Ship

When you say "ship it", Claude commits, pushes, and closes the issue. Then **Deming** automatically runs a lightweight retro — reviewing the cycle for friction, misdiagnoses, or process gaps, and comparing the issue's premortem against what actually happened (was Chesterton accurate? Did unpredicted failures slip through? Was the premortem overcautious?). Most of the time it's "clean cycle, no observations." When something surfaces — especially recurring premortem misses or systemic overcaution — Deming will either save it as a process improvement or propose a change to the ILR for your approval.

You don't need to do anything — just read Deming's observation if one appears.

---

## What You DON'T Need to Do

- Write acceptance criteria (Claude does this via `/spec`)
- Manage labels (Claude handles lifecycle transitions)
- Track progress on a board (labels + `/groom` replace Kanban)
- Write detailed issue descriptions (What + Why is enough — Claude figures out How)
- Review code (Claude self-reviews via PR + witness)
- Manually test on staging (Claude visually verifies via browser automation — you review the evidence)
