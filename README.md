# Catalina

> "It's the f***ing Catalina Wine Mixer."

The operational OS for running projects with Claude Code. This is where we keep our rules, skills, hooks, and workflows — so every new project starts with so much room for activities.

## What's in the Box

| Directory | What it Does |
|---|---|
| `commands/` | Reusable skills (/spec, /witness, /ship, /bug, etc.) — the Prestige Worldwide of slash commands |
| `reference/` | ILR system docs, playbooks — did we just become best friends? |
| `hooks/` | Guardrails, the witness gate, the `pre-push` gate, formatting, type checking — because this is a house of learned doctors |
| `bin/catalina` + `lib/` | The gate in code: `check`, `pre-push`, `audit`, `recall`, `doctor` |
| `CLAUDE.md` | Universal project rules — non-negotiable, like a drum set |

## The Rules

1. **No touching.** Don't edit Catalina files inside a project. Change them here, pull downstream.
2. **Visually verify everything.** We're not going to just assume it works because the code "looks right." That's how you end up buried alive.
3. **Small batch first.** You don't go full send on day one. You prove it works on 1–3 items like a responsible adult with a bunk bed.
4. **Tests first.** If you're changing behavior without a test, you're basically sleepwalking.

## Install

```bash
# Once per machine
git clone https://github.com/joshgaskin/catalina ~/.catalina

# From your project root — it's happening, it's the wine mixer
~/.catalina/install.sh
```

Everything is linked to the checkout, not copied. A project's own rules for a command go in
`.claude/catalina/<command>.local.md`; the command pulls them in at its `<!-- overlay -->` marker.

Then adopt the gate: commit `.catalina/config.json` to your default branch in `"mode": "shadow"`,
watch `catalina audit --shadow-report` for a few days, and switch to `"enforce"`. Run
`catalina audit` hourly from a cron. Details: `reference/ilr-system.md`, "The Gate".

## Update

```bash
# When we optimise the system — hey, we're getting better
git -C ~/.catalina pull
catalina doctor   # lists any copy that drifted from the package
```

## The Issue Lifecycle (ILR)

Our workflow. It's not complex. It's elegant. Like a fine wine. At a mixer.

```
Create issue → /spec → approve → implement → /witness → ship → retro
```

Every issue flows through this. No shortcuts. No "it's probably fine." This is the Catalina Wine Mixer of development workflows and we will not half-ass it.

And not because a prompt says so: `catalina check` holds every push to the default branch to the
spec, the premortem, the witness evidence and a test that really failed before the fix. Quick
tasks pass unless they touch a `no_undo` path. Each shipped issue's `## Lessons` feeds the next
`/spec` through `catalina recall` — the tracking files are the memory.

## Philosophy

This repo exists because we kept solving the same problems across projects and that's insanity. Now we solve them once, put them here, and every project gets the benefit.

It's a management system. Born of experience. Forged in production incidents. Named after the biggest event in entertainment history.

**POW.**
