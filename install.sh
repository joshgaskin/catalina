#!/bin/bash
# Catalina Install — It's the f***ing Catalina Wine Mixer
#
# Run from your project root:
#   /path/to/catalina/install.sh
#
# What it does:
#   1. Symlinks commands into .claude/commands/
#   2. Symlinks ILR reference docs into .claude/reference/
#   3. Copies hooks to ~/.claude/hooks/ (if not already there)
#   4. Reminds you to add project-specific CLAUDE.md rules

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

echo ""
echo "=== POW. ==="
echo ""
echo "Catalina is installed. Did we just become best friends?"
echo ""
echo "Next steps:"
echo "  1. Fill in project-specific rules in CLAUDE.md"
echo "  2. Define domain agents if needed (see ilr-system.md for the pattern)"
echo "  3. Check that hooks are wired in ~/.claude/settings.json"
echo "  4. There's so much room for activities"
