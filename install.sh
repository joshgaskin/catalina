#!/bin/bash
# Catalina Install — It's the f***ing Catalina Wine Mixer
#
# Run from your project root:
#   /path/to/catalina/install.sh
#
# What it does:
#   1. Symlinks commands into .claude/commands/
#   2. Symlinks ILR reference docs into .claude/reference/
#   3. Copies Claude Code hooks (+ hooks/lib) to ~/.claude/hooks/ and auto-wires the
#      witness gate into ~/.claude/settings.json
#   4. Installs the commit-msg git hook (ILR issue-ref enforcement)
#   5. Creates the ILR labels (epic, dev/design, dev/implement, review, blocked) via gh
#   6. Reminds you to add project-specific CLAUDE.md rules

set -euo pipefail

CATALINA_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(pwd)"

echo "=== Catalina Wine Mixer ==="
echo "Installing into: $PROJECT_DIR"
echo ""

# --- Commands ---
mkdir -p "$PROJECT_DIR/.claude/commands"
echo "Linking commands..."
for cmd in "$CATALINA_DIR/commands/"*.md; do
  name=$(basename "$cmd")
  target="$PROJECT_DIR/.claude/commands/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "  SKIP $name (exists and is not a symlink — project override?)"
  else
    ln -sf "$cmd" "$target"
    echo "  OK   $name"
  fi
done

# --- Reference docs ---
mkdir -p "$PROJECT_DIR/.claude/reference"
echo "Linking ILR reference docs..."
for ref in "$CATALINA_DIR/reference/"*.md; do
  name=$(basename "$ref")
  target="$PROJECT_DIR/.claude/reference/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "  SKIP $name (exists and is not a symlink — project override?)"
  else
    ln -sf "$ref" "$target"
    echo "  OK   $name"
  fi
done

# --- Hooks ---
HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOKS_DIR"
echo "Installing hooks to $HOOKS_DIR..."
for hook in "$CATALINA_DIR/hooks/"*.js; do
  name=$(basename "$hook")
  target="$HOOKS_DIR/$name"
  if [ -e "$target" ]; then
    if cmp -s "$hook" "$target"; then
      echo "  OK   $name (already up to date)"
    else
      echo "  DIFF $name (your version differs — not overwriting)"
      echo "       Compare: diff $hook $target"
    fi
  else
    cp "$hook" "$target"
    echo "  OK   $name (copied)"
  fi
done

# hooks/lib — shared modules (verify-witness.js, used by witness-gate.js AND /groom)
if [ -d "$CATALINA_DIR/hooks/lib" ]; then
  mkdir -p "$HOOKS_DIR/lib"
  cp "$CATALINA_DIR/hooks/lib/"*.js "$HOOKS_DIR/lib/" 2>/dev/null && echo "  OK   lib/ (shared hook modules)"
fi

# --- Auto-wire the witness gate into settings.json (idempotent) ---
# Makes the "witness is enforced" claim true by default instead of a dormant reminder.
SETTINGS="$HOME/.claude/settings.json"
if command -v node >/dev/null 2>&1; then
  echo "Wiring witness-gate.js into $SETTINGS..."
  SETTINGS_PATH="$SETTINGS" node <<'NODE' || echo "  warn: could not wire witness-gate (edit settings.json manually)"
const fs = require("fs"), path = require("path");
const p = process.env.SETTINGS_PATH;
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
s.hooks = s.hooks || {};
s.hooks.PreToolUse = s.hooks.PreToolUse || [];
if (JSON.stringify(s.hooks.PreToolUse).includes("witness-gate.js")) {
  console.log("  OK   witness-gate already wired");
} else {
  s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [ { type: "command", command: "node ~/.claude/hooks/witness-gate.js" } ] });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  console.log("  OK   witness-gate wired into PreToolUse(Bash)");
}
NODE
else
  echo "  SKIP witness-gate wiring (node not found) — add it to $SETTINGS manually"
fi

# --- Git commit-msg hook (ILR issue-ref enforcement) ---
echo "Installing commit-msg git hook..."
if git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  core_hooks_path="$(git -C "$PROJECT_DIR" config --get core.hooksPath || true)"
  if [ -n "$core_hooks_path" ]; then
    case "$core_hooks_path" in
      /*) hooks_dir="$core_hooks_path" ;;
      *)  hooks_dir="$PROJECT_DIR/$core_hooks_path" ;;
    esac
  else
    # --git-path resolves the real hooks dir even under worktrees/submodules
    # (where .git is a file, not a directory).
    hooks_dir="$(git -C "$PROJECT_DIR" rev-parse --git-path hooks)"
    case "$hooks_dir" in
      /*) ;;
      *)  hooks_dir="$PROJECT_DIR/$hooks_dir" ;;
    esac
  fi
  src_hook="$CATALINA_DIR/hooks/commit-msg"
  target_hook="$hooks_dir/commit-msg"
  mkdir -p "$hooks_dir"
  if [ -e "$target_hook" ] && ! cmp -s "$src_hook" "$target_hook"; then
    echo "  DIFF commit-msg (a different hook is already installed — not overwriting)"
    echo "       Compare: diff \"$src_hook\" \"$target_hook\""
    if [ -n "$core_hooks_path" ]; then
      echo "       Note: core.hooksPath=$core_hooks_path — a hook manager (e.g. Husky) may own this."
    fi
  else
    cp "$src_hook" "$target_hook"
    chmod +x "$target_hook"
    echo "  OK   commit-msg -> $target_hook"
  fi
else
  echo "  SKIP commit-msg (not a git repository)"
fi

# --- Tracking directory ---
mkdir -p "$PROJECT_DIR/.claude/tracking"

# --- CLAUDE.md check ---
echo ""
if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
  echo "CLAUDE.md exists. Make sure it references Catalina's universal rules."
  echo "Add this near the top if not already there:"
  echo ""
  echo '  ## OS Rules'
  echo '  See `.claude/reference/ilr-system.md` for the full ILR system.'
  echo '  Universal coding conventions are in the Catalina OS.'
else
  echo "No CLAUDE.md found. Creating a starter..."
  cat > "$PROJECT_DIR/CLAUDE.md" << 'TEMPLATE'
# Project Name — Rules

## OS (Catalina)
See `.claude/reference/ilr-system.md` for the ILR system.
Universal coding conventions are inherited from the Catalina OS.

## Project-Specific

<!-- Add your project's stack, DB refs, API rules, nav conventions, domain agents, etc. -->
TEMPLATE
  echo "  Created CLAUDE.md — fill in the project-specific section."
fi

# --- ILR labels (created via gh; runs LAST so a network/auth hiccup can't strand the install) ---
echo ""
echo "Creating ILR labels..."
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  # name|color|description  (colors mirror reference/ilr-system.md)
  ilr_labels=(
    "epic|8957E5|Business-outcome container"
    "dev/design|FBCA04|Spec phase"
    "dev/implement|0E8A16|Build phase"
    "review|1D76DB|Waiting for witness"
    "blocked|B60205|External dependency"
  )
  for entry in "${ilr_labels[@]}"; do
    IFS='|' read -r lname lcolor ldesc <<< "$entry"
    if gh label create "$lname" --color "$lcolor" --description "$ldesc" --force >/dev/null 2>&1; then
      echo "  OK   $lname"
    else
      echo "  warn: could not create label '$lname' (gh error — skipping)"
    fi
  done
else
  echo "  SKIP labels (gh not found or not authenticated)."
  echo "       Create manually: epic, dev/design, dev/implement, review, blocked"
fi

echo ""
echo "=== POW. ==="
echo ""
echo "Catalina is installed. Did we just become best friends?"
echo ""
echo "Installed the commit-msg git hook (rejects issue-* commits with no Refs #N)"
echo "and the ILR labels (if gh was available)."
echo ""
echo "Next steps:"
echo "  1. Fill in project-specific rules in CLAUDE.md"
echo "  2. Define domain agents if needed (see ilr-system.md for the pattern)"
echo "  3. Check that hooks are wired in ~/.claude/settings.json:"
echo ""
echo "     PreToolUse hooks needed:"
echo "       - phase-transition.js on Edit|Write|Bash (replaces suggest-compact.js)"
echo "       - pre-tool-guardrail.js on Bash"
echo "     PostToolUse hooks needed:"
echo "       - post-edit-format.js on Edit"
echo "       - post-edit-typecheck.js on Edit"
echo "       - post-edit-console-warn.js on Edit"
echo ""
echo "  4. There's so much room for activities"
