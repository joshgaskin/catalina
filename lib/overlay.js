/**
 * Catalina — project overlays for core commands.
 *
 * A core command is linked into the project unchanged. Its project-specific rules live in
 * `.claude/catalina/<command>.local.md`, pulled in at the command's `<!-- overlay -->`
 * marker by Claude Code's `!`cmd`` expansion, so the core can update without
 * clobbering a project's rules. `resolve` reproduces that expansion for tests and doctor.
 */
const OVERLAY_LINE = /^!`cat \.claude\/catalina\/[\w-]+\.local\.md 2>\/dev\/null \|\| true`$/m;

function resolve(coreText, overlayText) {
  return coreText.replace(OVERLAY_LINE, () => (overlayText == null ? "" : String(overlayText).trim()));
}

module.exports = { resolve, OVERLAY_LINE };
