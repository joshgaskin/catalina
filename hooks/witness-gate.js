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
 * Which repo (#27, hooks/lib/target-repo.js plan()): a cd never moves the gate. A flip whose own gh argv names its repo
 * (an issue URL, else the last -R/--repo, as gh ranks them) and parses cleanly is checked in that repo's local
 * checkouts. Every other flip is checked in the session repo and every repo the command's text mentions (cd/pushd/env -C
 * targets, -R, GH_REPO, issue URLs), and blocks if any of them fails, so it is never looser than the pre-#27 gate. To
 * flip an issue in another repo, run `gh issue edit N -R owner/name --add-label review`.
 *
 * Closed world: the gate stops accidental or sloppy flips by agents, not deliberate obfuscation (the same class as
 * CATALINA_WITNESS_ALLOW). A flip it can't read fully and literally (a flag between `issue` and `edit`, a positional
 * that isn't a plain number or issue/pull URL, any shell expansion in gh's argv, a label the shell builds, a cd target
 * the shell supplies) blocks, and the hook prints target-repo's UNREADABLE hint once.
 *
 * Fails closed: any error, a load failure, or a check past its deadline (CATALINA_GATE_DEADLINE_MS, default 5000) blocks
 * a command that could be a flip. Install it with `"timeout": 15, "onFailure": "block"` (install.sh does).
 *
 * Escape hatch: CATALINA_WITNESS_ALLOW=1 bypasses (prints a loud notice): in the hook's env, or on a simple script
 * itself as a prefix, through `env`, or from an earlier `export`. Written on a complex script it is ignored.
 * Exit 2 = block (PreToolUse convention); exit 0 = allow.
 */

const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const GATE_ERROR = "catalina gate error, blocking";
const MAX_INPUT = 64 * 1024 * 1024;
const MAX_COMMAND = 1024 * 1024;

/** Could this text hold a review flip at all? Loose on purpose: quotes, escapes and $ removed first; any --add-label too. */
const mayFlip = (t) =>
  /review|add-label/i.test(
    String(t)
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\n/g, "")
      .replace(/[$'"\\`]/g, "")
  );

if (isMainThread) main();
else worker();

function main() {
  let data = "";
  let done = false;
  const finish = (code, err) => {
    if (done) return;
    done = true;
    process.exitCode = code;
    if (err) process.stderr.write(err);
    setTimeout(() => process.exit(code), 1000).unref();
    process.stdout.write(data, () => process.exit(code));
  };
  const fail = (msg) => finish(2, `\n[witness-gate] ${GATE_ERROR}: ${msg}\n\n`);
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      if (done) return;
      data += c;
      if (data.length > MAX_INPUT) fail(`hook input over ${MAX_INPUT} bytes`);
    });
    process.stdin.on("error", (e) => fail(e.message));
    process.stdin.on("end", () => {
      if (done) return;
      try {
        if (data.length > MAX_COMMAND) return mayFlip(data) ? fail(`hook input over ${MAX_COMMAND} bytes`) : finish(0);
        let command = "";
        try {
          command = JSON.parse(data).tool_input?.command || "";
        } catch (e) {
          return mayFlip(data) ? fail(`hook input isn't JSON (${e.message})`) : finish(0);
        }
        if (typeof command !== "string") command = String(command);
        if (!command || !mayFlip(command)) return finish(0);
        const allowEnv = process.env.CATALINA_WITNESS_ALLOW === "1";
        const ms = Number(process.env.CATALINA_GATE_DEADLINE_MS) || 5000;
        const w = new Worker(fs.realpathSync(__filename), { workerData: { command, cwd: process.cwd(), env: { ...process.env } } });
        const timer = setTimeout(() => {
          w.terminate();
          fail(`deadline of ${ms}ms passed`);
        }, ms);
        const broke = (msg) => {
          clearTimeout(timer);
          if (allowEnv) return finish(0, `\n[witness-gate] BYPASSED via CATALINA_WITNESS_ALLOW=1 — the gate failed (${msg}); evidence NOT checked.\n\n`);
          fail(msg);
        };
        w.on("message", (m) => {
          clearTimeout(timer);
          finish(m.code, m.err);
        });
        w.on("error", (e) => broke(e && e.message ? e.message : String(e)));
        w.on("exit", (c) => broke(`the check exited (${c}) without a result`));
      } catch (e) {
        fail(e && e.message ? e.message : String(e));
      }
    });
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

function worker() {
  const { command, cwd, env } = workerData;
  const dir = path.dirname(fs.realpathSync(__filename));
  // Through the real path: an install links hooks/lib files one by one, so a new module isn't linked until it re-runs.
  const mod = require(path.join(dir, "lib", "verify-witness"));
  const target = require(path.join(dir, "lib", "target-repo"));
  let catalina = null;
  let cfgLib = null;
  try {
    // Linked install: ~/.claude/hooks/witness-gate.js -> <catalina>/hooks/witness-gate.js, so ../lib is the package.
    const pkg = path.join(dir, "..", "lib");
    catalina = require(`${pkg}/check`);
    cfgLib = require(`${pkg}/config`);
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
    catalina = null;
  }
  let err = "";
  const say = (t) => (err += t);

  const p = target.plan(command, { cwd, env });
  if (!p.flip) return parentPort.postMessage({ code: 0, err });
  const numbers = [...new Set([...p.gates.map((g) => g.n), ...p.bypassed, ...p.unchecked.flatMap((u) => u.numbers)])];

  // Escape hatch in the hook's env: bypasses everything, as it always has.
  if (env.CATALINA_WITNESS_ALLOW === "1") {
    say(`\n[witness-gate] BYPASSED via CATALINA_WITNESS_ALLOW=1 — evidence NOT checked for issue ${numbers.join(", ") || "?"}.\n\n`);
    return parentPort.postMessage({ code: 0, err });
  }
  for (const note of p.notes) say(`[witness-gate] note: ${note}\n`);
  // Written on a simple script as a prefix or export (a prefix doesn't reach a hook's env); plan ignores it elsewhere.
  if (p.bypassed.length) say(`\n[witness-gate] BYPASSED via CATALINA_WITNESS_ALLOW=1 — evidence NOT checked for issue ${p.bypassed.join(", ")}.\n\n`);
  let blocked = false;
  for (const why of p.block) {
    say(`\n[witness-gate] BLOCKED: ${why}.\n`);
    if (/couldn't be parsed/.test(why)) say("  Use `gh issue edit <N> --add-label review` so the gate can verify issue N's evidence.\n");
    say("\n");
    blocked = true;
  }
  for (const u of p.unchecked) {
    say(`[witness-gate] issue ${u.numbers.join(", ") || "?"} in ${u.repo} NOT checked: ${u.why}. Run the flip from that checkout to gate it.\n`);
  }
  for (const { n, dir: d } of p.gates) if (!gateOne(n, d)) blocked = true;
  if (p.unreadable) say(`[witness-gate] ${target.UNREADABLE}\n`);
  if (blocked && p.hint && !p.unreadable) say(`[witness-gate] ${target.HINT}.\n`);
  parentPort.postMessage({ code: blocked ? 2 : 0, err });

  /** Check issue n in repo d; false when it must not enter review. */
  function gateOne(n, d) {
    // Only engage for ILR issues.
    if (!fs.existsSync(path.join(d, ".claude", "tracking", `issue-${n}`))) return true; // not an ILR issue → don't block
    const where = path.resolve(d) === path.resolve(cwd) ? "" : ` in ${d}`;

    // Projects that adopted Catalina (.catalina/config.json on the default branch) get the full
    // check, reading the red proof from its cache only — a hook must finish fast, and the red
    // run belongs to `catalina check --witness`. Others keep the evidence-only validator.
    let adopted = null;
    try {
      adopted = catalina && cfgLib.load(d);
    } catch {}
    const { ok, reasons, needsHuman = 0 } = adopted
      ? catalina.check(n, { cwd: d, source: "worktree", red: "cache", config: adopted })
      : mod.verifyWitness(n, { repoRoot: d });
    if (ok) {
      if (needsHuman) say(`[witness-gate] issue ${n}${where}: ${needsHuman} needs_human item(s) — allowed into review, but a human must confirm before ship.\n`);
      return true;
    }
    say(
      `\n[witness-gate] BLOCKED: issue ${n}${where} cannot enter \`review\` — witness evidence is incomplete:\n` +
        reasons.map((r) => `  - ${r}`).join("\n") +
        `\n\n  Fix the evidence in .claude/tracking/issue-${n}/verification.jsonl (go to the gemba — capture real artifacts),\n` +
        `  or override with CATALINA_WITNESS_ALLOW=1 if you truly must.\n\n`
    );
    return false;
  }
}
