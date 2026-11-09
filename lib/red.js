/**
 * Catalina — the red-then-green proof, run for real.
 *
 * The issue's new or changed test files are copied onto a temporary checkout of the
 * merge-base and must FAIL there on an assertion. A load failure is red only when every error names a
 * module (a relative or aliased import) that the change itself adds: the test cannot pass without the
 * change. Any other load error (a syntax error, a missing package, a module the change doesn't touch)
 * is not red. The same files must pass at the shipped commit. A repo's first code is the exception: when the merge-base holds
 * no code at all (greenfield), there is nothing to fail against, so a load failure there counts
 * as red and only the green run decides. Results are cached by base + test-file blobs in the git
 * common dir, so witness pays for the run and pre-push/witness-gate read the cache.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const g = require("./git");

const PREFIX = "catalina-red-";

/** Shared by every worktree of the repo; CATALINA_RED_CACHE shares it across clones too (a merge bot's own clone). */
function cacheDir(cwd) {
  return process.env.CATALINA_RED_CACHE || path.join(g.commonDir(cwd), "catalina", "red-cache");
}

/** Bumped when a cached verdict could read differently now; a failing entry without it is a miss (a green never goes stale). */
const CACHE_VERSION = 2;

function cacheKey(base, sha, files, cwd, greenfield = false) {
  const blobs = files.map((f) => [f, g.blob(sha, f, cwd)]).sort();
  return crypto.createHash("sha256").update(JSON.stringify(greenfield ? { base, blobs, greenfield } : { base, blobs })).digest("hex").slice(0, 32);
}

function readCache(key, cwd) {
  try {
    const hit = JSON.parse(fs.readFileSync(path.join(cacheDir(cwd), `${key}.json`), "utf8"));
    return hit.ok || hit.v >= CACHE_VERSION ? hit : null;
  } catch {
    return null;
  }
}

function writeCache(key, result, cwd) {
  fs.mkdirSync(cacheDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(cacheDir(cwd), `${key}.json`), JSON.stringify({ ...result, v: CACHE_VERSION, at: new Date().toISOString() }));
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

const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** The text of each load error in a run: a test file that failed without a failed assertion. [] when the run can't say. */
function loadErrors(run, parser) {
  if (parser === "vitest" || parser === "jest") {
    return (run.json?.testResults || [])
      .filter((r) => r.status === "failed" && !(r.assertionResults || []).some((a) => a.status === "failed"))
      .map((r) => String(r.message || "").trim() || "(the test file failed with no message)");
  }
  if (parser === "node-test") return [String(run.output || "")];
  return [];
}

/** The module a load error says it can't find: {spec, from} (from = the importing file), or null for any other error. */
function missingImport(text) {
  const t = String(text);
  const m =
    t.match(/Cannot find (?:module|package) '([^']+)' imported from '?([^'\s]+)'?/) || // vitest, node ESM
    t.match(/Failed to resolve import "([^"]+)" from "([^"]+)"/) || // vite
    t.match(/Cannot find module '([^']+)' from '([^']+)'/) || // jest
    t.match(/Cannot find module '([^']+)'\s+Require stack:\s+- (\S+)/); // node CJS
  return m ? { spec: m[1], from: m[2] } : null;
}

/** The file the change adds that `spec` (imported from `from`) resolves to, or null: a package, a file the base has, or nothing at sha. */
function addedByChange({ spec, from }, dirs, base, sha, cfg, cwd) {
  const alias = Object.entries(cfg.import_aliases || {}).find(([prefix]) => spec.startsWith(prefix));
  const rels = [];
  for (const root of dirs) {
    const fromAbs = path.isAbsolute(from) ? from : path.join(root, from);
    if (spec.startsWith(".")) rels.push(path.relative(root, path.resolve(path.dirname(fromAbs), spec)));
    else if (path.isAbsolute(spec)) rels.push(path.relative(root, spec));
  }
  if (alias) rels.push(path.normalize(alias[1] + spec.slice(alias[0].length)));
  const isFile = (ref, f) => g.tryGit(["cat-file", "-t", `${ref}:${f}`], cwd)?.trim() === "blob";
  for (const rel of [...new Set(rels)].filter((r) => r && !r.startsWith(".."))) {
    const stem = rel.replace(/\.(?:m|c)?js$/, "");
    const files = [rel, ...SOURCE_EXTS.map((e) => rel + e), ...SOURCE_EXTS.map((e) => `${rel}/index${e}`), ...(stem !== rel ? SOURCE_EXTS.map((e) => stem + e) : [])];
    const f = files.find((c) => isFile(sha, c));
    if (f) return isFile(base, f) ? null : f;
  }
  return null;
}

/** The line of a load error worth showing: the first that names an Error, else the first. */
function errorLine(text) {
  const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /Error|Cannot find/.test(l)) || lines[0] || "").slice(0, 200);
}

/**
 * A load failure at the merge-base is red only when each error is a missing import of a file this change adds.
 * → { ok: true, added } or { ok: false, why } (the first error nothing explains).
 */
function loadIsNewModule(run, dir, { base, sha, cfg, cwd }) {
  const errors = loadErrors(run, cfg.red_parser);
  if (!errors.length) return { ok: false, why: "no load error to read" };
  const added = [];
  for (const text of errors) {
    const imp = missingImport(text);
    const file = imp && addedByChange(imp, [...new Set([dir, fs.realpathSync(dir)])], base, sha, cfg, cwd);
    if (!file) return { ok: false, why: errorLine(text) };
    added.push(file);
  }
  return { ok: true, added: [...new Set(added)] };
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
 * greenfield: the merge-base holds no code, so a load failure there counts as red.
 * Returns {ok, reason, cached}.
 */
function redProof({ cwd, base, sha, files, cfg, mode = "miss", greenfield = false }) {
  if (!cfg.red_cmd) return { ok: false, cached: false, reason: "red proof needs red_cmd in .catalina/config.json" };
  prune(cwd, cfg.red_timeout_s * 1000 + 60000);
  const key = cacheKey(base, sha, files, cwd, greenfield);
  const hit = mode !== "run" && readCache(key, cwd);
  if (hit) return { ok: hit.ok, reason: hit.reason, via: hit.via, cached: true };
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
    else {
      const load = kind === "load" && !greenfield ? loadIsNewModule(atBase, red, { base, sha, cfg, cwd }) : null;
      if (load && !load.ok) result = { ok: false, reason: `the tests failed to load, not an assertion, on main, and not because of a module this change adds (${load.why}): ${files.join(", ")}` };
      else {
        const green = checkout(cwd, sha, cfg, root);
        dirs.push(green);
        const atSha = runIn(green, cfg, files, root);
        if (atSha.timeout) result = { ok: false, reason: `green run timed out after ${cfg.red_timeout_s}s` };
        else if (atSha.code !== 0) result = { ok: false, reason: `the tests fail at ${sha.slice(0, 7)} — not green: ${files.join(", ")}` };
      else result = { ok: true, reason: null, ...(load ? { via: `loads only after the change adds ${load.added.join(", ")}` } : {}) };
      }
    }
  } catch (e) {
    result = { ok: false, reason: `red proof could not run: ${e.message.split("\n")[0]}` };
  } finally {
    for (const d of dirs) g.tryGit(["worktree", "remove", "--force", d], cwd);
  }
  if (!/could not run|timed out/.test(result.reason || "")) writeCache(key, result, cwd);
  return { ...result, cached: false };
}

module.exports = { redProof, classify, cacheKey, missingImport, PREFIX };
