#!/usr/bin/env node
/**
 * PreToolUse Hook: Witness Gate (defense-in-depth)
 *
 * Blocks the `dev/implement -> review` label flip on the common `gh issue edit` Bash
 * path unless the issue's verification.jsonl passes hooks/lib/verify-witness.js.
 *
 * This is ONE layer. It is NOT a hermetic seal — the label can also be set via the
 * GitHub MCP tool, `gh api`, or a wrapper, none of which are Bash `gh issue edit`.
 * The real guarantee is the state sweep in /groom, which revalidates every `review`
 * issue regardless of how the label was set. Both share the validator module.
 *
 * Engages ONLY for ILR issues (a .claude/tracking/issue-N/ dir exists), so it never
 * blocks ordinary human/other relabels in a repo that doesn't use the ILR.
 *
 * Escape hatch: CATALINA_WITNESS_ALLOW=1 bypasses (prints a loud notice).
 * Exit 2 = block (PreToolUse convention); exit 0 = allow.
 */

const fs = require("fs");
const path = require("path");

let mod;
try {
  mod = require("./lib/verify-witness");
} catch {
  // If the validator can't load, fail open (don't wedge the session) but say so.
  process.stderr.write("[witness-gate] validator module not found — gate inactive\n");
}

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  if (data.length < 1024 * 1024) data += c;
});

process.stdin.on("end", () => {
  const passthrough = (code) => {
    process.stdout.write(data);
    process.exit(code);
  };

  let command = "";
  try {
    command = JSON.parse(data).tool_input?.command || "";
  } catch {
    return passthrough(0); // unrelated parse failure → fail open
  }
  if (!command || !mod) return passthrough(0);

  // Is this a `gh issue edit` that ADDS the `review` label?
  if (!/\bgh\s+issue\s+edit\b/.test(command)) return passthrough(0);
  const labelMatch = command.match(/--add-label(?:=|\s+)(['"]?)([^'"\s]+)\1/);
  if (!labelMatch) return passthrough(0);
  const labels = labelMatch[2].split(",").map((s) => s.trim());
  if (!labels.includes("review")) return passthrough(0); // exact token, not substring

  // It's a review-flip. Extract the issue number: positional, #N, or issues/N URL.
  const nMatch =
    command.match(/\/issues\/(\d+)/) ||
    command.match(/gh\s+issue\s+edit\s+#?(\d+)/) ||
    command.match(/#(\d+)/);
  const n = nMatch ? nMatch[1] : null;

  // Escape hatch
  if (process.env.CATALINA_WITNESS_ALLOW === "1") {
    process.stderr.write(
      `\n[witness-gate] BYPASSED via CATALINA_WITNESS_ALLOW=1 — evidence NOT checked for issue ${n || "?"}.\n\n`
    );
    return passthrough(0);
  }

  // Fail-closed: review-flip whose number can't be parsed.
  if (!n) {
    process.stderr.write(
      "\n[witness-gate] BLOCKED: this looks like a flip to `review` but the issue number couldn't be parsed.\n" +
        "  Use `gh issue edit <N> --add-label review` so the gate can verify issue N's evidence.\n\n"
    );
    return passthrough(2);
  }

  // Only engage for ILR issues.
  const dir = path.join(process.cwd(), ".claude", "tracking", `issue-${n}`);
  if (!fs.existsSync(dir)) return passthrough(0); // not an ILR issue → don't block

  const { ok, reasons, needsHuman } = mod.verifyWitness(n, { repoRoot: process.cwd() });
  if (ok) {
    if (needsHuman) {
      process.stderr.write(
        `[witness-gate] issue ${n}: ${needsHuman} needs_human item(s) — allowed into review, but a human must confirm before ship.\n`
      );
    }
    return passthrough(0);
  }

  process.stderr.write(
    `\n[witness-gate] BLOCKED: issue ${n} cannot enter \`review\` — witness evidence is incomplete:\n` +
      reasons.map((r) => `  - ${r}`).join("\n") +
      `\n\n  Fix the evidence in .claude/tracking/issue-${n}/verification.jsonl (go to the gemba — capture real artifacts),\n` +
      `  or override with CATALINA_WITNESS_ALLOW=1 if you truly must.\n\n`
  );
  return passthrough(2);
});
