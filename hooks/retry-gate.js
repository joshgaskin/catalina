#!/usr/bin/env node
/**
 * PreToolUse Hook: Retry Gate (mechanical teeth for the auto-handoff bound)
 *
 * Blocks a 3rd `dev/implement` re-entry for an issue, so the implement↔witness
 * auto-loop (see the Auto-Handoff Pipeline in ilr-system.md) can't run forever.
 *
 * Ground truth = committed `- BOUNCE:` markers in the issue's tracking.md
 * `## Review History` (witness.md appends one on each fail-route). NOT a
 * self-incremented field — the looping agent can't quietly reset it.
 *
 * The bound: at most 2 retries (3 build attempts). Each build cycle STARTS by
 * (re-)asserting `--add-label dev/implement` — witness.md's fail-route does this
 * to begin the next cycle, so the gated action genuinely recurs per bounce (the
 * initial spec→implement flip is just cycle 1). Each witness fail appends a
 * `- BOUNCE:` marker. Walk it:
 *   cycle1 flip (0 markers, allow) → fail → marker1
 *   cycle2 flip (1 marker,  allow) → fail → marker2   (retry 1)
 *   cycle3 flip (2 markers, allow) → fail → marker3   (retry 2)
 *   cycle4 flip (3 markers, BLOCK) → escalate         (3rd retry refused)
 * So block when count >= 3. Markers are counted ONLY inside the
 * `## Review History` section (line-leading), so `- BOUNCE:` strings mentioned
 * in Design Notes / prose don't false-trip the gate.
 *
 * NOTE: the count is read from the working-tree tracking.md, not git history —
 * a rewrite of Review History (e.g. a careless /capture) could reset it. Strong,
 * not cryptographic. Mirrors witness-gate.js otherwise (ILR-only, exact-token
 * match, fail-closed on unparseable N, loud escape hatch).
 *
 * Escape hatch: CATALINA_RETRY_ALLOW=1 (emergency only; logged loudly).
 * Exit 2 = block; exit 0 = allow.
 */

const fs = require("fs");
const path = require("path");

const BOUND = 3; // block the 4th build cycle (i.e. the 3rd retry) — 2 retries allowed

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
    return passthrough(0);
  }
  if (!command) return passthrough(0);

  // gh issue edit that ADDS the dev/implement label?
  if (!/\bgh\s+issue\s+edit\b/.test(command)) return passthrough(0);
  const labelMatch = command.match(/--add-label(?:=|\s+)(['"]?)([^'"\s]+)\1/);
  if (!labelMatch) return passthrough(0);
  const labels = labelMatch[2].split(",").map((s) => s.trim());
  if (!labels.includes("dev/implement")) return passthrough(0);

  const nMatch =
    command.match(/\/issues\/(\d+)/) ||
    command.match(/gh\s+issue\s+edit\s+#?(\d+)/) ||
    command.match(/#(\d+)/);
  const n = nMatch ? nMatch[1] : null;

  if (process.env.CATALINA_RETRY_ALLOW === "1") {
    process.stderr.write(
      `\n[retry-gate] BYPASSED via CATALINA_RETRY_ALLOW=1 — retry bound NOT enforced for issue ${n || "?"}.\n\n`
    );
    return passthrough(0);
  }

  if (!n) {
    process.stderr.write(
      "\n[retry-gate] BLOCKED: a flip to `dev/implement` with an unparseable issue number.\n" +
        "  Use `gh issue edit <N> --add-label dev/implement` so the retry bound can be checked.\n\n"
    );
    return passthrough(2);
  }

  const trackingPath = path.join(process.cwd(), ".claude", "tracking", `issue-${n}`, "tracking.md");
  if (!fs.existsSync(trackingPath)) return passthrough(0); // not an ILR issue

  let bounces = 0;
  try {
    const md = fs.readFileSync(trackingPath, "utf8");
    // Count line-leading "- BOUNCE:" ONLY within the ## Review History section,
    // so mentions of the marker in Design Notes / prose don't false-trip the gate.
    let inRH = false, section = "";
    for (const line of md.split("\n")) {
      if (/^##\s+/.test(line)) inRH = /^##\s+Review History\b/i.test(line);
      else if (inRH) section += line + "\n";
    }
    bounces = (section.match(/^\s*-\s*BOUNCE:/gim) || []).length;
  } catch {
    return passthrough(0); // can't read → don't wedge
  }

  if (bounces >= BOUND) {
    process.stderr.write(
      `\n[retry-gate] BLOCKED: issue ${n} has ${bounces} recorded witness failures (- BOUNCE markers).\n` +
        `  The auto-loop allows 2 retries; a failure surviving that is probably a bad spec —\n` +
        `  STOP and escalate to the human with a diagnosis instead of starting another build.\n` +
        `  (Emergency override: CATALINA_RETRY_ALLOW=1 — record it as a '- BYPASS:' line in Review History.)\n\n`
    );
    return passthrough(2);
  }

  return passthrough(0);
});
