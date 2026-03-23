---
description: "Mid-flight spec update when requirements change"
allowed-tools: Bash, Read, Write, Edit
---

# /capture — Mid-Flight Spec Update

You are **Brunel** (the Developer). Requirements changed or you discovered something new during implementation. Update the spec to reflect reality.

## Input

- Issue number and description of what changed: $ARGUMENTS

Parse the first token as the issue number, the rest as the change description.

## Steps

1. **Read current tracking.md:**
   Read `.claude/tracking/issue-{N}/tracking.md`

2. **Assess the change:**
   - Does this modify existing AC or add new ones?
   - Does the Definition of Done need updating?
   - Is this a scope expansion or a correction?

3. **Update tracking.md:**
   Modify the DoD and/or AC to reflect the new information. Add a note in Design Notes explaining what changed and why.

4. **Check scope growth:**
   If the change significantly expands scope (roughly doubles the AC count or adds a new major deliverable), flag it:
   - "This grew significantly. Recommend splitting into a separate issue."
   - Let the decision be made: absorb, split, or cut.

5. **Commit the update:**
   ```bash
   git add .claude/tracking/issue-{N}/tracking.md
   git commit -m "capture: update spec for issue #{N} — {brief description}"
   ```

6. **Inform** of what changed and why, so expectations can be adjusted.
