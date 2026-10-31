#!/bin/bash
# Catalina Install — It's the f***ing Catalina Wine Mixer
#
# Run from your project root:
#   ~/.catalina/install.sh          # commands linked into the project's .claude/commands
#   ~/.catalina/install.sh --user   # commands linked into ~/.claude/commands instead, for a
#                                   # project worked on in many worktrees (untracked project
#                                   # links don't reach a fresh worktree; user-level commands do)
#
# What it does:
#   1. Points ~/.catalina at this checkout (the git hooks find Catalina there)
#   2. Links commands and ILR reference docs into .claude/ (a project's own rules go in
#      .claude/catalina/<command>.local.md overlays, so a real copy is reported, not replaced)
#   3. Links Claude Code hooks (+ hooks/lib) into ~/.claude/hooks and wires them in
#      ~/.claude/settings.json; removes entries for hooks Catalina no longer ships
#   4. Installs the commit-msg and pre-push git hooks
#   5. Creates the ILR labels via gh (skip with CATALINA_SKIP_LABELS=1)
#
# Update later with: git -C ~/.catalina pull   (everything is linked, so that's all)

set -euo pipefail

CATALINA_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(pwd)"
USER_COMMANDS=0
[ "${1:-}" = "--user" ] && USER_COMMANDS=1
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "=== Catalina Wine Mixer ==="
echo "Installing into: $PROJECT_DIR"
echo ""

# --- ~/.catalina ---
if [ "$(cd "$HOME/.catalina" 2>/dev/null && pwd -P)" != "$(cd "$CATALINA_DIR" && pwd -P)" ]; then
  if [ -e "$HOME/.catalina" ] && [ ! -L "$HOME/.catalina" ]; then
    echo "  SKIP ~/.catalina exists and isn't a link — git hooks will look there, so point it at $CATALINA_DIR yourself"
  else
    ln -sfn "$CATALINA_DIR" "$HOME/.catalina"
    echo "  OK   ~/.catalina -> $CATALINA_DIR"
  fi
fi
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$CATALINA_DIR/bin/catalina" "$HOME/.local/bin/catalina" && echo "  OK   ~/.local/bin/catalina"
fi

# link_into <source> <target>: link, or report a real file that isn't the same.
link_into() {
  local src="$1" target="$2" name
  name="$(basename "$target")"
  if [ -L "$target" ] || [ ! -e "$target" ]; then
    ln -sf "$src" "$target"
    echo "  OK   $name"
  elif cmp -s "$src" "$target"; then
    ln -sf "$src" "$target"
    echo "  OK   $name (identical copy replaced by a link)"
  else
    echo "  SKIP $name — a project copy that differs: move its project rules to the overlay"
    echo "       .claude/catalina/${name%.md}.local.md, then delete it and re-run."
  fi
}

# --- Commands + reference docs ---
mkdir -p "$PROJECT_DIR/.claude/catalina"
if [ "$USER_COMMANDS" = 1 ]; then
  mkdir -p "$HOME/.claude/commands"
  echo "Linking commands into ~/.claude/commands..."
  for cmd in "$CATALINA_DIR/commands/"*.md; do
    name="$(basename "$cmd")"
    link_into "$cmd" "$HOME/.claude/commands/$name"
    p="$PROJECT_DIR/.claude/commands/$name"
    if [ -e "$p" ] && ! { [ -L "$p" ] && [ "$(cd "$(dirname "$p")" && pwd -P)/$(basename "$(readlink "$p")")" = "$(cd "$CATALINA_DIR/commands" && pwd -P)/$name" ]; }; then
      echo "  SKIP $name — the project's copy shadows the user-level command: move its project rules to"
      echo "       .claude/catalina/${name%.md}.local.md, then delete it from the project."
    fi
  done
  echo "  Reference docs stay in $CATALINA_DIR/reference (point CLAUDE.md there)."
else
  mkdir -p "$PROJECT_DIR/.claude/commands" "$PROJECT_DIR/.claude/reference"
  echo "Linking commands..."
  for cmd in "$CATALINA_DIR/commands/"*.md; do link_into "$cmd" "$PROJECT_DIR/.claude/commands/$(basename "$cmd")"; done
  echo "Linking ILR reference docs..."
  for ref in "$CATALINA_DIR/reference/"*.md; do link_into "$ref" "$PROJECT_DIR/.claude/reference/$(basename "$ref")"; done
fi

# --- Claude Code hooks (linked, so `git pull` updates them) ---
HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOKS_DIR/lib"
echo "Linking hooks into $HOOKS_DIR..."
link_hook() {
  local src="$1" target="$2"
  if [ -e "$target" ] && [ ! -L "$target" ] && ! cmp -s "$src" "$target"; then
    mv "$target" "$target.bak-$STAMP"
    echo "  BAK  $(basename "$target") -> $(basename "$target").bak-$STAMP (it differed)"
  fi
  ln -sf "$src" "$target"
}
for hook in "$CATALINA_DIR/hooks/"*.js; do link_hook "$hook" "$HOOKS_DIR/$(basename "$hook")"; done
for lib in "$CATALINA_DIR/hooks/lib/"*.js; do link_hook "$lib" "$HOOKS_DIR/lib/$(basename "$lib")"; done
echo "  OK   hooks linked"
# Hooks Catalina no longer ships: drop our links and identical copies.
for gone in phase-transition.js suggest-compact.js post-edit-console-warn.js retry-gate.js; do
  t="$HOOKS_DIR/$gone"
  if [ -L "$t" ]; then rm "$t"; echo "  DEL  $gone"; elif [ -f "$t" ]; then mv "$t" "$t.bak-$STAMP"; echo "  BAK  $gone (no longer shipped)"; fi
done

# --- settings.json: wire the hooks, drop retired ones, keep everything else ---
SETTINGS="$HOME/.claude/settings.json"
if command -v node >/dev/null 2>&1; then
  echo "Wiring hooks into $SETTINGS..."
  SETTINGS_PATH="$SETTINGS" HOOKS_DIR="$HOOKS_DIR" node <<'NODE'
const fs = require("fs"), path = require("path");
const p = process.env.SETTINGS_PATH, dir = process.env.HOOKS_DIR;
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
s.hooks = s.hooks || {};
const RETIRED = ["phase-transition.js", "suggest-compact.js", "post-edit-console-warn.js", "retry-gate.js"];
const OURS = ["pre-tool-guardrail.js", "witness-gate.js", "post-edit-format.js", "post-edit-typecheck.js"];
const mentions = (e, names) => names.some((n) => JSON.stringify(e).includes(n));
// Drop retired hooks and every entry of ours (re-added below with the current matchers).
for (const ev of Object.keys(s.hooks)) {
  s.hooks[ev] = s.hooks[ev]
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !mentions(h, [...RETIRED, ...OURS])) }))
    .filter((e) => e.hooks.length);
  if (!s.hooks[ev].length) delete s.hooks[ev];
}
const add = (ev, matcher, file) => {
  s.hooks[ev] = s.hooks[ev] || [];
  const entry = { hooks: [{ type: "command", command: `node ${path.join(dir, file)}` }] };
  s.hooks[ev].push(matcher ? { matcher, ...entry } : entry);
};
add("PreToolUse", "Bash", "pre-tool-guardrail.js");
add("PreToolUse", "Bash", "witness-gate.js");
add("PostToolUse", "Edit|Write", "post-edit-format.js");
add("PostToolUse", "Edit|Write", "post-edit-typecheck.js");
add("Stop", null, "post-edit-typecheck.js");
fs.mkdirSync(path.dirname(p), { recursive: true });
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
console.log("  OK   guardrail + witness gate (PreToolUse Bash), format (Edit|Write), typecheck (once per turn, at Stop)");
NODE
else
  echo "  SKIP settings (node not found) — wire the hooks in $SETTINGS by hand"
fi

# --- Git hooks: commit-msg (issue refs) + pre-push (catalina check on the default branch) ---
echo "Installing git hooks..."
if git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  core_hooks_path="$(git -C "$PROJECT_DIR" config --get core.hooksPath || true)"
  if [ -n "$core_hooks_path" ]; then
    case "$core_hooks_path" in /*) hooks_dir="$core_hooks_path" ;; *) hooks_dir="$PROJECT_DIR/$core_hooks_path" ;; esac
  else
    hooks_dir="$(git -C "$PROJECT_DIR" rev-parse --git-path hooks)"
    case "$hooks_dir" in /*) ;; *) hooks_dir="$PROJECT_DIR/$hooks_dir" ;; esac
  fi
  mkdir -p "$hooks_dir"
  for h in commit-msg pre-push; do
    src="$CATALINA_DIR/hooks/$h" target="$hooks_dir/$h"
    if [ -e "$target" ] && ! cmp -s "$src" "$target"; then
      echo "  DIFF $h (a different hook is installed — not overwriting; compare: diff \"$src\" \"$target\")"
    else
      cp "$src" "$target" && chmod +x "$target" && echo "  OK   $h -> $target"
    fi
  done
  if [ -n "$core_hooks_path" ]; then
    echo "       core.hooksPath=$core_hooks_path is in the repo: commit the hooks so every clone and worktree has them."
  fi
else
  echo "  SKIP git hooks (not a git repository)"
fi

mkdir -p "$PROJECT_DIR/.claude/tracking"

# --- CLAUDE.md ---
echo ""
if [ ! -f "$PROJECT_DIR/CLAUDE.md" ]; then
  cat > "$PROJECT_DIR/CLAUDE.md" << 'TEMPLATE'
# Project Name — Rules

## OS (Catalina)
See `.claude/reference/ilr-system.md` for the ILR system.
Universal coding conventions are inherited from the Catalina OS.

## Project-Specific

<!-- Add your project's stack, DB refs, API rules, nav conventions, domain agents, etc. -->
TEMPLATE
  echo "Created CLAUDE.md — fill in the project-specific section."
fi

# --- ILR labels (last, so a network/auth hiccup can't strand the install) ---
echo ""
if [ "${CATALINA_SKIP_LABELS:-}" = "1" ]; then
  echo "Skipping labels (CATALINA_SKIP_LABELS=1)"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "Creating ILR labels..."
  for entry in "epic|8957E5|Business-outcome container" "dev/design|FBCA04|Spec phase" "dev/implement|0E8A16|Build phase" "review|1D76DB|Waiting for witness" "blocked|B60205|External dependency" "catalina-unchecked|B60205|On the default branch without passing catalina check"; do
    IFS='|' read -r lname lcolor ldesc <<< "$entry"
    gh label create "$lname" --color "$lcolor" --description "$ldesc" --force >/dev/null 2>&1 && echo "  OK   $lname" || echo "  warn: could not create label '$lname'"
  done
else
  echo "Skipping labels (gh not found or not authenticated)"
fi

echo ""
echo "=== POW. ==="
echo ""
echo "Next steps:"
echo "  1. Adopt the gate: add .catalina/config.json (see reference/ilr-system.md, \"The gate\"),"
echo "     starting in \"mode\": \"shadow\". Commit it to the default branch."
echo "  2. Watch a few days of would-blocks: catalina audit --shadow-report; then switch to \"enforce\"."
echo "  3. Run the audit hourly somewhere: catalina audit (files catalina-unchecked issues)."
echo "  4. Check for drifted copies any time: catalina doctor"
echo ""
echo "  There's so much room for activities"
