# Catalina

> "It's the f***ing Catalina Wine Mixer."

The operational OS for running projects with Claude Code. This is where we keep our rules, skills, hooks, and workflows — so every new project starts with so much room for activities.

## What's in the Box

| Directory | What it Does |
|---|---|
| `commands/` | Reusable skills (/spec, /witness, /ship, /bug, etc.) — the Prestige Worldwide of slash commands |
| `reference/` | ILR system docs, playbooks — did we just become best friends? |
| `hooks/` | Post-edit formatting, type checking, lint guards — because this is a house of learned doctors |
| `CLAUDE.md` | Universal project rules — non-negotiable, like a drum set |

## The Rules

1. **No touching.** Don't edit Catalina files inside a project. Change them here, pull downstream.
2. **Visually verify everything.** We're not going to just assume it works because the code "looks right." That's how you end up buried alive.
3. **Small batch first.** You don't go full send on day one. You prove it works on 1–3 items like a responsible adult with a bunk bed.
4. **Tests first.** If you're changing behavior without a test, you're basically sleepwalking.

## Install

```bash
# From your project root — it's happening, it's the wine mixer
./catalina/install.sh
```

## Update

```bash
# When we optimise the system — hey, we're getting better
git submodule update --remote .claude/os
```

## The Issue Lifecycle (ILR)

Our workflow. It's not complex. It's elegant. Like a fine wine. At a mixer.

```
Create issue → /spec → approve → implement → /witness → ship → retro
```

Every issue flows through this. No shortcuts. No "it's probably fine." This is the Catalina Wine Mixer of development workflows and we will not half-ass it.

## Philosophy

This repo exists because we kept solving the same problems across projects and that's insanity. Now we solve them once, put them here, and every project gets the benefit.

It's a management system. Born of experience. Forged in production incidents. Named after the biggest event in entertainment history.

**POW.**
