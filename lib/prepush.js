/**
 * Catalina — the pre-push gate. git passes `<remote> <url>` as args and one line per ref
 * on stdin: `<local ref> <local sha> <remote ref> <remote sha>`.
 *
 * Only pushes to the remote's default branch are gated. In the pushed range:
 *   - commits touching only .claude/tracking/** pass (spec, evidence, lessons)
 *   - a commit referencing an issue >= enforce_from → that issue must pass `catalina check`
 *   - any other commit is quick: it passes unless it touches a no_undo path
 * Shadow mode never blocks: it logs what it would have blocked to the git common dir,
 * which every worktree of the repo shares.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const g = require("./git");
const cfgLib = require("./config");
const { matcher } = require("./glob");
const { check, TRACKING_ONLY } = require("./check");

/** Reasons a set of commits fails the gate: [] when it passes. */
function gate(commits, cfg, cwd, tip) {
  const reasons = [];
  const noUndo = matcher(cfg.no_undo);
  const issues = new Set();
  for (const c of commits) {
    const changed = c.files.filter((f) => !TRACKING_ONLY.test(f));
    if (!changed.length) continue;
    const enforced = g.issueRefs(c.message).filter((n) => n >= cfg.enforce_from);
    if (enforced.length) enforced.forEach((n) => issues.add(n));
    else for (const f of changed.filter(noUndo)) reasons.push(`${c.sha.slice(0, 7)} touches ${f} (no_undo) — needs an issue that passes catalina check`);
  }
  for (const n of issues) {
    const r = check(n, { cwd, sha: tip, source: "commit", red: "miss", config: cfg });
    for (const reason of r.reasons) reasons.push(`#${n}: ${reason}`);
  }
  return reasons;
}

function shadowLog(cwd) {
  return path.join(g.commonDir(cwd), "catalina", "shadow.log");
}

function run(argv, stdin, cwd = process.cwd()) {
  const remote = argv[0] || "origin";
  const say = (s) => process.stderr.write(`${s}\n`);
  let cfg;
  try {
    cfg = cfgLib.load(cwd, remote);
  } catch (e) {
    say(`[catalina] push blocked: ${e.message}`);
    return 1;
  }
  if (!cfg) return 0; // project hasn't adopted Catalina
  const defaultHead = `refs/heads/${cfg.defaultRef.slice(remote.length + 1)}`;

  const reasons = [];
  let tipSha = null;
  try {
    for (const line of stdin.split("\n").filter((l) => l.trim())) {
      const [, lsha, rref, rsha] = line.trim().split(/\s+/);
      if (g.ZERO.test(lsha) || rref !== defaultHead) continue; // delete, or not the default branch
      const base = !g.ZERO.test(rsha) && g.tryGit(["cat-file", "-e", `${rsha}^{commit}`], cwd) !== null ? rsha : g.mergeBase(lsha, cfg.defaultRef, cwd);
      tipSha = lsha;
      reasons.push(...gate(g.commits(base, lsha, cwd), cfg, cwd, lsha));
    }
  } catch (e) {
    reasons.push(`catalina couldn't check this push: ${e.message.split("\n")[0]}`);
  }
  if (!reasons.length) return 0;

  if (cfg.mode === "shadow") {
    const file = shadowLog(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), remote, sha: tipSha, reasons }) + "\n");
    say(`[catalina] shadow mode: this push would be blocked (logged, allowed):\n${reasons.map((r) => `  - ${r}`).join("\n")}`);
    return 0;
  }
  say(`[catalina] push blocked:\n${reasons.map((r) => `  - ${r}`).join("\n")}`);
  return 1;
}

module.exports = { run, gate, shadowLog };
