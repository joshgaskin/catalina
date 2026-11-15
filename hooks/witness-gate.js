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
 * Reads the repo gh edits, not the session cwd (#27): a leading `cd <dir>`, `-R/--repo owner/name`, an issue URL or
 * GH_REPO (hooks/lib/target-repo.js plan()), but only in a simple script: a flat list of simple commands joined by &&
 * or ; whose every cd runs and resolves. A named repo with no local checkout is let through with a notice. Anything
 * else (a heredoc, a comment, a function, control flow, `||`, eval, popd, a cd that may not run, a flip the parser
 * can't read) is checked in the session repo and every repo its text could reach, and blocks if any of them fails, so
 * it is never looser than the pre-#27 gate.
 *
 * Escape hatch: CATALINA_WITNESS_ALLOW=1 bypasses (prints a loud notice): in the hook's env, or on a simple script
 * itself as a prefix, through `env`, or from an earlier `export`. Written on a complex script it is ignored.
 * Exit 2 = block (PreToolUse convention); exit 0 = allow.
 */

const fs = require("fs");
const path = require("path");

let mod, catalina, cfgLib, target;
try {
  mod = require("./lib/verify-witness");
} catch {
  // If the validator can't load, fail open (don't wedge the session) but say so.
  process.stderr.write("[witness-gate] validator module not found — gate inactive\n");
}
try {
  // Linked install: ~/.claude/hooks/witness-gate.js -> <catalina>/hooks/witness-gate.js, so ../lib is the package.
  const pkg = require("path").join(require("fs").realpathSync(__filename), "..", "..", "lib");
  catalina = require(`${pkg}/check`);
  cfgLib = require(`${pkg}/config`);
} catch {}
try {
  // Through the real path: an install links hooks/lib files one by one, so a new module isn't linked until it re-runs.
  target = require(path.join(fs.realpathSync(__filename), "..", "lib", "target-repo"));
} catch {
  process.stderr.write("[witness-gate] target-repo module not found — gate inactive\n");
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
  if (!command || !mod || !target) return passthrough(0);

  // Each `gh issue edit` that ADDS the `review` label (exact token, not substring), and the repos to check it in (#27).
  const p = target.plan(command, { cwd: process.cwd(), env: process.env });
  if (!p.flip) return passthrough(0);
  const numbers = [...new Set([...p.gates.map((g) => g.n), ...p.bypassed, ...p.unchecked.flatMap((u) => u.numbers)])];

  // Escape hatch in the hook's env: bypasses everything, as it always has.
  if (process.env.CATALINA_WITNESS_ALLOW === "1") {
    process.stderr.write(`\n[witness-gate] BYPASSED via CATALINA_WITNESS_ALLOW=1 — evidence NOT checked for issue ${numbers.join(", ") || "?"}.\n\n`);
    return passthrough(0);
  }
  for (const note of p.notes) process.stderr.write(`[witness-gate] note: ${note}\n`);
  // Written on a simple script as a prefix or export (a prefix doesn't reach a hook's env); plan ignores it elsewhere.
  if (p.bypassed.length) {
    process.stderr.write(`\n[witness-gate] BYPASSED via CATALINA_WITNESS_ALLOW=1 — evidence NOT checked for issue ${p.bypassed.join(", ")}.\n\n`);
  }
  let blocked = false;
  if (p.block.length) {
    // Fail-closed: review-flip whose number can't be parsed.
    process.stderr.write(
      "\n[witness-gate] BLOCKED: this looks like a flip to `review` but the issue number couldn't be parsed.\n" +
        "  Use `gh issue edit <N> --add-label review` so the gate can verify issue N's evidence.\n\n"
    );
    blocked = true;
  }
  for (const u of p.unchecked) {
    process.stderr.write(`[witness-gate] issue ${u.numbers.join(", ") || "?"} in ${u.repo} NOT checked: ${u.why}. Run the flip from that checkout to gate it.\n`);
  }
  for (const { n, dir } of p.gates) if (!gateOne(n, dir)) blocked = true;
  return passthrough(blocked ? 2 : 0);
});

/** Check issue n in repo dir; false when it must not enter review. */
function gateOne(n, dir) {
  // Only engage for ILR issues.
  if (!fs.existsSync(path.join(dir, ".claude", "tracking", `issue-${n}`))) return true; // not an ILR issue → don't block
  const where = path.resolve(dir) === path.resolve(process.cwd()) ? "" : ` in ${dir}`;

  // Projects that adopted Catalina (.catalina/config.json on the default branch) get the full
  // check, reading the red proof from its cache only — a hook must finish fast, and the red
  // run belongs to `catalina check --witness`. Others keep the evidence-only validator.
  let adopted = null;
  try {
    adopted = catalina && cfgLib.load(dir);
  } catch {}
  const { ok, reasons, needsHuman = 0 } = adopted
    ? catalina.check(n, { cwd: dir, source: "worktree", red: "cache", config: adopted })
    : mod.verifyWitness(n, { repoRoot: dir });
  if (ok) {
    if (needsHuman) {
      process.stderr.write(
        `[witness-gate] issue ${n}${where}: ${needsHuman} needs_human item(s) — allowed into review, but a human must confirm before ship.\n`
      );
    }
    return true;
  }

  process.stderr.write(
    `\n[witness-gate] BLOCKED: issue ${n}${where} cannot enter \`review\` — witness evidence is incomplete:\n` +
      reasons.map((r) => `  - ${r}`).join("\n") +
      `\n\n  Fix the evidence in .claude/tracking/issue-${n}/verification.jsonl (go to the gemba — capture real artifacts),\n` +
      `  or override with CATALINA_WITNESS_ALLOW=1 if you truly must.\n\n`
  );
  return false;
}
