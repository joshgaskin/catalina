/**
 * Catalina — the red-then-green proof, run for real.
 *
 * The issue's new or changed test files are copied onto a temporary checkout of the
 * merge-base and must FAIL there on an assertion (a missing module is not red — it
 * proves the file is new, not that the test can catch the bug). The same files must
 * pass at the shipped commit. Results are cached by base + test-file blobs in the git
 * common dir, so witness pays for the run and pre-push/witness-gate read the cache.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const g = require("./git");

const PREFIX = "catalina-red-";

function cacheDir(cwd) {
  return path.join(g.commonDir(cwd), "catalina", "red-cache");
}

function cacheKey(base, sha, files, cwd) {
  const blobs = files.map((f) => [f, g.blob(sha, f, cwd)]).sort();
  return crypto.createHash("sha256").update(JSON.stringify({ base, blobs })).digest("hex").slice(0, 32);
}

function readCache(key, cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir(cwd), `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(key, result, cwd) {
  fs.mkdirSync(cacheDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(cacheDir(cwd), `${key}.json`), JSON.stringify({ ...result, at: new Date().toISOString() }));
}

/** Remove leftover red worktrees older than the timeout (a killed run never cleans up). */
function prune(cwd, maxAgeMs) {
  const list = g.out(["worktree", "list", "--porcelain"], cwd);
  for (const m of list.matchAll(/^worktree (.+)$/gm)) {
    const wt = m[1];
    if (!path.basename(wt).startsWith(PREFIX)) continue;
    let stale = true;
    try {
      stale = Date.now() - fs.statSync(wt).mtimeMs > maxAgeMs;
    } catch {}
    if (stale) g.tryGit(["worktree", "remove", "--force", wt], cwd);
  }
  g.tryGit(["worktree", "prune"], cwd);
}

/** The project's own env, minus anything that makes a nested test runner report to its parent. */
function childEnv(root) {
  const env = { ...process.env, CATALINA_ROOT: root };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function runIn(dir, cfg, files, root) {
  const report = path.join(dir, ".catalina-red-report.json");
  const cmd = cfg.red_cmd.replace("{files}", files.map(q).join(" ")).replace("{report}", q(report));
  let code = 0;
  let output = "";
  try {
    output = execSync(cmd, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: cfg.red_timeout_s * 1000,
      env: childEnv(root),
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") return { timeout: true };
    code = e.status ?? 1;
    output = `${e.stdout || ""}${e.stderr || ""}`;
  }
  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(report, "utf8"));
  } catch {}
  return { code, output, json };
}

/** Classify a run at the merge-base: "assertion" (red), "load" (not red), or "pass". */
function classify(run, parser) {
  if (run.code === 0) return "pass";
  if (parser === "vitest" || parser === "jest") {
    if (!run.json) return "load";
    const results = run.json.testResults || [];
    const asserted = results.some((r) => (r.assertionResults || []).some((a) => a.status === "failed"));
    return asserted ? "assertion" : "load";
  }
  if (parser === "node-test") return /AssertionError|ERR_ASSERTION/.test(run.output) ? "assertion" : "load";
  return "assertion"; // exit-code: can't tell a load error from a failed assertion
}

function checkout(cwd, ref, cfg, root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  fs.rmdirSync(dir);
  g.git(["worktree", "add", "-q", "--detach", dir, ref], cwd);
  if (cfg.red_setup) execSync(cfg.red_setup, { cwd: dir, stdio: "ignore", env: childEnv(root), shell: "/bin/sh" });
  return dir;
}

/**
 * mode: "run" (always run), "miss" (run only on a cache miss), "cache" (never run).
 * Returns {ok, reason, cached}.
 */
function redProof({ cwd, base, sha, files, cfg, mode = "miss" }) {
  if (!cfg.red_cmd) return { ok: false, cached: false, reason: "red proof needs red_cmd in .catalina/config.json" };
  prune(cwd, cfg.red_timeout_s * 1000 + 60000);
  const key = cacheKey(base, sha, files, cwd);
  const hit = mode !== "run" && readCache(key, cwd);
  if (hit) return { ok: hit.ok, reason: hit.reason, cached: true };
  if (mode === "cache") return { ok: false, cached: false, reason: "red proof not run yet — run `catalina check --witness <N>`" };

  const root = g.topLevel(cwd);
  const dirs = [];
  let result;
  try {
    const red = checkout(cwd, base, cfg, root);
    dirs.push(red);
    for (const f of files) {
      const p = path.join(red, f);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, g.showBuffer(sha, f, cwd));
    }
    const atBase = runIn(red, cfg, files, root);
    const kind = atBase.timeout ? "timeout" : classify(atBase, cfg.red_parser);
    if (kind === "timeout") result = { ok: false, reason: `red proof timed out at the merge-base after ${cfg.red_timeout_s}s — red not proven` };
    else if (kind === "pass") result = { ok: false, reason: `${files.join(", ")} already passes on main, proves nothing — the test must fail before the fix` };
    else if (kind === "load") result = { ok: false, reason: `the tests failed to load, not an assertion, on main (a new module isn't a red test): ${files.join(", ")}` };
    else {
      const green = checkout(cwd, sha, cfg, root);
      dirs.push(green);
      const atSha = runIn(green, cfg, files, root);
      if (atSha.timeout) result = { ok: false, reason: `green run timed out after ${cfg.red_timeout_s}s` };
      else if (atSha.code !== 0) result = { ok: false, reason: `the tests fail at ${sha.slice(0, 7)} — not green: ${files.join(", ")}` };
      else result = { ok: true, reason: null };
    }
  } catch (e) {
    result = { ok: false, reason: `red proof could not run: ${e.message.split("\n")[0]}` };
  } finally {
    for (const d of dirs) g.tryGit(["worktree", "remove", "--force", d], cwd);
  }
  if (!/could not run|timed out/.test(result.reason || "")) writeCache(key, result, cwd);
  return { ...result, cached: false };
}

module.exports = { redProof, classify, cacheKey, PREFIX };
