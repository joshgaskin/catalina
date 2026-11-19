/**
 * Catalina — the red-then-green proof, run for real.
 *
 * The issue's new or changed test files are copied onto a temporary checkout of the
 * merge-base and must FAIL there on an assertion. A load failure is red only when every error names a
 * module (a relative or aliased import) that the change itself adds: the test cannot pass without the
 * change. Any other load error (a syntax error, a missing package, a module the change doesn't touch)
 * is not red. The same files must pass at the shipped commit. A repo's first code is the exception: when the merge-base holds
 * no code at all (greenfield), there is nothing to fail against, so a load failure there counts
 * as red and only the green run decides. Results are cached by base + test-file blobs, box-wide (cacheDirs), so
 * witness pays for the run and pre-push/witness-gate read the cache, from whichever clone they run in.
 *
 * Each checkout is a temp worktree with `red_setup` run in it, or, with `red_pool` set, one kept worktree moved from
 * ref to ref (lib/pool.js): everything but the kept paths is reset between runs, and red_setup runs once.
 *
 * Each test file is judged on its own: one that passes at the base is listed in `basePass` (with more than one file,
 * node-test and exit-code runs are repeated per file to tell them apart).
 *
 * Tests that pin a guard main already has pass at the base by design (#28). For them a witness records a mutant: a
 * patch that breaks the guard. mutantProof replays it in a checkout of the shipped commit and reads each named test's
 * result (so it needs a runner with a per-test JSON report, vitest or jest): every named test passes there, fails with
 * the patch applied, and in each named file some test still passes, so the mutant broke one guard, not the module's
 * loading or everything. Cached by the patch bytes, the blobs of what it touches and of the named test files, red_cmd.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execSync, execFileSync } = require("child_process");
const g = require("./git");
const cfgLib = require("./config");
const gatelog = require("./gatelog");
const pool = require("./pool");

const PREFIX = "catalina-red-";

/**
 * Where verdicts live, first is written: CATALINA_RED_CACHE when set; else the box-wide state dir (beside the gate
 * log), so every clone of the repo on the box shares them (a key is content: the base and the files' blobs), then the
 * clone's own git dir, where they lived before and are still read. A repo with no owner/name keeps the git dir only.
 */
function cacheDirs(cwd, cfg) {
  if (process.env.CATALINA_RED_CACHE) return [process.env.CATALINA_RED_CACHE];
  const own = path.join(g.commonDir(cwd), "catalina", "red-cache");
  try {
    return [path.join(path.dirname(gatelog.logPath(cfgLib.repoSlug(cfg, cwd))), "red-cache"), own];
  } catch {
    return [own];
  }
}

/**
 * Bumped when a cached verdict could read differently now. A failing entry below it is a miss; a green one stays good
 * unless the caller says green entries below `okMin` could read differently too.
 */
const CACHE_VERSION = 5; // 3: kept for #27. 4: basePass (#28). 5: per-file base status, named-test mutants (#28)

function cacheKey(base, sha, files, cwd, greenfield = false) {
  const blobs = files.map((f) => [f, g.blob(sha, f, cwd)]).sort();
  return crypto.createHash("sha256").update(JSON.stringify(greenfield ? { base, blobs, greenfield } : { base, blobs })).digest("hex").slice(0, 32);
}

function readCache(key, cwd, cfg, okMin = 0) {
  for (const dir of cacheDirs(cwd, cfg)) {
    try {
      const hit = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), "utf8"));
      if (hit.v >= CACHE_VERSION || (hit.ok && (hit.v || 0) >= okMin)) return hit;
    } catch {}
  }
  return null;
}

function writeCache(key, result, cwd, cfg) {
  const dir = cacheDirs(cwd, cfg)[0];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ ...result, v: CACHE_VERSION, at: new Date().toISOString() }));
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

/** A signal's name from a shell's 128+n exit status, or null. */
function signalOf(status) {
  if (!(status > 128 && status < 128 + 65)) return null;
  return Object.entries(os.constants.signals).find(([, n]) => n === status - 128)?.[0] || `signal ${status - 128}`;
}

/**
 * Run the tests in dir. → { code, output, json, signal } or { timeout }. The report is deleted first, so a report left
 * in the checkout isn't read as this run's; `signal` names the signal that ended the runner (it gave no verdict, W07).
 */
function runIn(dir, cfg, files, root) {
  const report = path.join(dir, ".catalina-red-report.json");
  fs.rmSync(report, { force: true });
  const cmd = cfg.red_cmd.replace("{files}", files.map(q).join(" ")).replace("{report}", q(report));
  let code = 0;
  let output = "";
  let signal = null;
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
    signal = e.signal || signalOf(e.status);
    code = e.status ?? 1;
    output = `${e.stdout || ""}${e.stderr || ""}`;
  }
  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(report, "utf8"));
  } catch {}
  return { code, output, json, signal };
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

/** Runners whose JSON report gives each test's result, so a mutant line can name tests (#28). */
const PER_TEST = new Set(["vitest", "jest"]);

/** A report's file name as a path relative to the checkout `dir` (the report may name it through a symlinked tmpdir). */
function relIn(dir, name) {
  if (!path.isAbsolute(name)) return path.normalize(name);
  const roots = [dir];
  try {
    roots.push(fs.realpathSync(dir));
  } catch {}
  for (const r of roots) {
    const rel = path.relative(r, name);
    if (!rel.startsWith("..")) return rel;
  }
  return name;
}

/** A per-test JSON report by file: Map(rel → { status, message, cases: [{ chain, status }] }). Empty when there's no report. */
function caseResults(run, dir) {
  const map = new Map();
  for (const r of run.json?.testResults || []) {
    map.set(relIn(dir, String(r.name || "")), {
      status: r.status,
      message: String(r.message || "").trim(),
      cases: (r.assertionResults || []).map((a) => ({ chain: [...(a.ancestorTitles || []), a.title], status: a.status, messages: (a.failureMessages || []).map(String) })),
    });
  }
  return map;
}

/**
 * Each file's result at the base: "pass", "assertion" or "load", read from the run's report, or (node-test, exit-code)
 * by running each file alone when the run failed with more than one. → { status: {file: kind}, loadRuns } or { timeout }.
 */
function baseStatus(run, dir, cfg, files, root) {
  if (run.timeout) return { timeout: true };
  const all = (kind) => Object.fromEntries(files.map((f) => [f, kind]));
  if (run.code === 0) return { status: all("pass"), loadRuns: [] };
  if (PER_TEST.has(cfg.red_parser)) {
    if (!run.json) return { status: all("load"), loadRuns: [run] };
    const results = caseResults(run, dir);
    const status = {};
    for (const f of files) {
      const r = results.get(f);
      if (!r) status[f] = "load";
      else if (r.cases.some((c) => c.status === "failed")) status[f] = "assertion";
      else status[f] = r.status === "failed" ? "load" : "pass";
    }
    const missing = files.filter((f) => !results.has(f));
    return { status, loadRuns: [run], missing };
  }
  if (files.length === 1) return { status: { [files[0]]: classify(run, cfg.red_parser) }, loadRuns: [run] };
  const status = {};
  const loadRuns = [];
  for (const f of files) {
    const one = runIn(dir, cfg, [f], root);
    if (one.timeout) return { timeout: true };
    status[f] = classify(one, cfg.red_parser);
    if (status[f] === "load") loadRuns.push(one);
  }
  return { status, loadRuns };
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

/**
 * The checkouts of one proof. `at(ref)` gives a dir holding that ref's tree and what red_setup made, nothing else:
 * the run's pool slot moved to the ref (red_pool; the dir `at` gave before is that same dir, so use one at a time),
 * or a new temp worktree. `done()` frees the slot and removes the temp worktrees.
 */
function workspace(cwd, cfg, root) {
  const setup = (dir) => {
    if (cfg.red_setup) execSync(cfg.red_setup, { cwd: dir, stdio: "ignore", env: childEnv(root), shell: "/bin/sh" });
  };
  const slot = pool.acquire(cwd, cfg);
  const temps = [];
  return {
    at(ref) {
      if (slot) return pool.prepare(slot, ref, { cwd, cfg, root, setup });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
      fs.rmdirSync(dir);
      temps.push(dir);
      g.git(["worktree", "add", "-q", "--detach", dir, ref], cwd);
      setup(dir);
      return dir;
    },
    done() {
      if (slot) pool.release(slot);
      for (const d of temps) g.tryGit(["worktree", "remove", "--force", d], cwd);
    },
  };
}

/**
 * mode: "run" (always run), "miss" (run only on a cache miss), "cache" (never run).
 * greenfield: the merge-base holds no code, so a load failure there counts as red.
 * Returns {ok, reason, cached, basePass?}: basePass lists the files that pass at the base (the rest are red there and
 * green at sha); a mutant line can prove those (#28).
 */
function redProof({ cwd, base, sha, files, cfg, mode = "miss", greenfield = false }) {
  if (!cfg.red_cmd) return { ok: false, cached: false, reason: "red proof needs red_cmd in .catalina/config.json" };
  prune(cwd, cfg.red_timeout_s * 1000 + 60000);
  const key = cacheKey(base, sha, files, cwd, greenfield);
  // A green verdict over one file reads the same now; over several, a file that passed at the base may have hidden
  // behind another's red before v5.
  const hit = mode !== "run" && readCache(key, cwd, cfg, files.length > 1 ? CACHE_VERSION : 0);
  if (hit) return { ok: hit.ok, reason: hit.reason, via: hit.via, basePass: hit.basePass, cached: true };
  if (mode === "cache") return { ok: false, cached: false, reason: "red proof not run yet — run `catalina check --witness <N>`" };

  const root = g.topLevel(cwd);
  let ws = null;
  const passes = (list) => `${list.join(", ")} already passes on main, proves nothing — the test must fail before the fix`;
  let result;
  try {
    ws = workspace(cwd, cfg, root);
    const red = ws.at(base);
    for (const f of files) {
      const p = path.join(red, f);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, g.showBuffer(sha, f, cwd));
    }
    const at = baseStatus(runIn(red, cfg, files, root), red, cfg, files, root);
    const passing = at.timeout ? [] : files.filter((f) => at.status[f] === "pass");
    const loading = at.timeout ? [] : files.filter((f) => at.status[f] === "load");
    let load = null;
    if (at.timeout) result = { ok: false, reason: `red proof timed out at the merge-base after ${cfg.red_timeout_s}s — red not proven` };
    else if (passing.length === files.length) result = { ok: false, basePass: files, reason: passes(files) };
    else if (loading.length && !greenfield) {
      const missing = (at.missing || []).filter((f) => loading.includes(f));
      const checks = missing.length ? [{ ok: false, why: `${missing.join(", ")} isn't in the run's report` }] : at.loadRuns.map((r) => loadIsNewModule(r, red, { base, sha, cfg, cwd }));
      const bad = checks.find((c) => !c.ok);
      if (bad) result = { ok: false, reason: `the tests failed to load, not an assertion, on main, and not because of a module this change adds (${bad.why}): ${loading.join(", ")}` };
      else load = { added: [...new Set(checks.flatMap((c) => c.added))] };
    }
    if (!result) {
      const green = ws.at(sha);
      const atSha = runIn(green, cfg, files, root);
      const via = load ? { via: `loads only after the change adds ${load.added.join(", ")}` } : {};
      if (atSha.timeout) result = { ok: false, reason: `green run timed out after ${cfg.red_timeout_s}s` };
      else if (atSha.code !== 0) result = { ok: false, reason: `the tests fail at ${sha.slice(0, 7)} — not green: ${files.join(", ")}` };
      else if (passing.length) result = { ok: false, basePass: passing, reason: passes(passing), ...via };
      else result = { ok: true, reason: null, ...via };
    }
  } catch (e) {
    result = { ok: false, reason: `red proof could not run: ${e.message.split("\n")[0]}` };
  } finally {
    ws?.done();
  }
  if (!/could not run|timed out/.test(result.reason || "")) writeCache(key, result, cwd, cfg);
  return { ...result, cached: false };
}

/** git apply, with the patch on stdin. Throws with git's message when it refuses. */
function apply(args, patch, cwd) {
  return execFileSync("git", ["apply", ...args], { cwd, input: patch, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

const gitError = (e) => String(e.stderr || e.message).split("\n").map((l) => l.trim()).filter(Boolean)[0] || "git apply failed";

/**
 * The files a patch touches, as git apply reads it (renames give both paths), and whether it changes a line.
 * → { files, changes, binary } or { error } when git can't read it as a patch. An empty or blank patch is { files: [] }.
 */
function patchTouched(patch, cwd) {
  if (!String(patch).trim()) return { files: [], changes: 0, binary: [] };
  let out;
  try {
    out = apply(["--numstat", "-z"], patch, cwd);
  } catch (e) {
    return { error: gitError(e) };
  }
  const parts = out.split("\0");
  const files = [];
  const binary = [];
  let changes = 0;
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    if (m[1] === "-" || Number(m[1]) + Number(m[2]) > 0) changes++;
    const these = m[3] ? [m[3]] : [parts[++i], parts[++i]]; // a rename: "\0old\0new"
    files.push(...these);
    if (m[1] === "-") binary.push(these[these.length - 1]);
  }
  return { files: [...new Set(files.filter(Boolean))], changes, binary };
}

/** The paths a patch gives a symlink mode (120000): a mutant that makes a link points a test somewhere else. */
function patchSymlinks(patch) {
  const links = [];
  let file = null;
  for (const l of String(patch).split("\n")) {
    const h = l.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (h) file = h[2];
    else if (file && /^(?:new file mode|deleted file mode|old mode|new mode) 120000\s*$|^index [0-9a-f]+\.\.[0-9a-f]+ 120000\s*$/.test(l)) links.push(file);
  }
  return [...new Set(links)];
}

/**
 * The mutant verdict's key (witness D3): what the replay reads, not the sha it ran at — the patch bytes, the blobs at
 * sha of the files it touches and of the named test files, the named tests, and the runner. A tracking-only commit
 * after the witness hits; a change to any of those misses.
 */
function mutantKey({ sha, touched, files, named, patch, cfg, cwd }) {
  const blobs = (list) => [...new Set(list)].map((f) => [f, g.blob(sha, f, cwd)]).sort();
  const mutant = crypto.createHash("sha256").update(patch).digest("hex");
  const runner = { red_cmd: cfg.red_cmd, red_parser: cfg.red_parser, red_setup: cfg.red_setup || null };
  const body = { v: CACHE_VERSION, rules: MUTANT_RULES, mutant, touched: blobs(touched), tests: blobs(files), named: [...named].sort(), runner };
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
}

// The rules a mutant verdict was judged by (witness 2: crash, specificity; witness 3: fresh runs, a clean pair that
// agrees, a killed runner, at least half). A change to them misses every cached verdict.
const MUTANT_RULES = 3;

// A cached mutant verdict names its patch by this token; a hit fills in the name the record uses now (F5).
const PATCH_TOKEN = "\u0000patch\u0000";
const fillName = (text, name) => (text == null ? text : String(text).split(PATCH_TOKEN).join(name));

/** Each named test's statuses in a report: the results whose chain is the test's (a loop can report a name twice). */
function statuses(results, t) {
  const cases = results.get(t.file)?.cases || [];
  return cases.filter((c) => c.chain.length === t.chain.length && c.chain.every((x, i) => x === t.chain[i])).map((c) => c.status);
}

const caseKey = (c) => JSON.stringify(c.chain);
const EXIT = /process\.exit(?: unexpectedly)? called/;

/**
 * Why the file `f` crashed under the mutant rather than failing on an assertion, or null. A crash: the file reported
 * no test; a test it reported at the sha without the mutant is missing (the run ended early, A21); it failed with no
 * failed test (a load error; jest sets the file's message whenever a test fails, so a message alone isn't one, D-J);
 * or a test failed because the code called process.exit (vitest's message for it, A21).
 */
function crashOf(f, before, after) {
  const a = after.get(f);
  if (!a?.cases.length) return "it reported no test";
  const left = new Map();
  for (const c of a.cases) left.set(caseKey(c), (left.get(caseKey(c)) || 0) + 1);
  const base = before.get(f)?.cases || [];
  const missing = base.filter((c) => {
    const n = left.get(caseKey(c)) || 0;
    if (n) left.set(caseKey(c), n - 1);
    return !n;
  });
  if (missing.length) return `${missing.length} of its ${base.length} tests didn't run (${missing.map((c) => c.chain[c.chain.length - 1]).join(", ")})`;
  const failed = a.cases.filter((c) => c.status === "failed");
  if (!failed.length && (a.message || a.status === "failed")) return "it failed with no failed test";
  const exit = failed.find((c) => c.messages.some((m) => EXIT.test(m)));
  if (exit) return `${exit.chain[exit.chain.length - 1]} called process.exit`;
  return null;
}

/**
 * Whether the mutant breaks one guard in `f`, not everything (AC7): of the file's other tests that pass at the sha
 * without it (not named), at least half still pass with it. → a reason it isn't, or null. A file padded with trivial
 * tests passes this whatever the mutant breaks; the reviewer reads the patch (W04).
 */
function unspecific(f, named, before, after, P) {
  const isNamed = (c) => named.some((t) => t.file === f && t.chain.length === c.chain.length && t.chain.every((x, i) => x === c.chain[i]));
  const others = (before.get(f)?.cases || []).filter((c) => c.status === "passed" && !isNamed(c));
  if (!others.length) return `mutant ${P} is not specific: ${f} has no other test that passes without it, so nothing shows it breaks one guard rather than everything — add a test it should leave alone`;
  const passing = new Map();
  for (const c of after.get(f).cases) if (c.status === "passed") passing.set(caseKey(c), (passing.get(caseKey(c)) || 0) + 1);
  const still = others.filter((c) => {
    const n = passing.get(caseKey(c)) || 0;
    if (n) passing.set(caseKey(c), n - 1);
    return n > 0;
  }).length;
  if (still * 2 >= others.length) return null;
  if (!still) return `mutant ${P} is not specific: every test in ${f} fails under it, so it breaks loading or everything, not one guard`;
  return `mutant ${P} is not specific: only ${still} of the ${others.length} other tests in ${f} that pass without it still pass with it — a mutant that breaks one guard leaves at least half of the others passing`;
}

/** Each case's statuses by chain in a report's file f: Map(chain key → sorted statuses). */
function caseMap(results, f) {
  const m = new Map();
  for (const c of results.get(f)?.cases || []) m.set(caseKey(c), [...(m.get(caseKey(c)) || []), c.status].sort());
  return m;
}

/** The files whose two clean runs differ, each with the tests that differ: [[f, titles]] (W11). */
function disagree(files, a, b, runA, runB) {
  const out = [];
  for (const f of files) {
    const [x, y] = [caseMap(a, f), caseMap(b, f)];
    const keys = [...new Set([...x.keys(), ...y.keys()])].filter((k) => JSON.stringify(x.get(k)) !== JSON.stringify(y.get(k)));
    if (keys.length) out.push([f, keys.map((k) => JSON.parse(k).at(-1))]);
  }
  if (!out.length && runA.code !== runB.code) out.push([files.join(", "), ["its exit code"]]);
  return out;
}

const EXIT_HINT = 'If the guard is that the code doesn\'t exit, have the test spy on process.exit (vi.spyOn(process, "exit") or jest.spyOn, made to throw or return) and assert it isn\'t called, so the mutant fails an assertion';

/**
 * For tests that pin a guard main already has (#28): every named test ({ name, file, chain }) passes in two fresh
 * checkouts of sha that agree on every test (a flaky pair proves nothing and is never cached, W11), and in a third
 * fresh checkout with the mutant `patch` applied every one fails on an assertion (no crash, see crashOf; a runner
 * killed by a signal gives no verdict, W07), while at least half of each named file's other passing tests still pass
 * (unspecific; witness D2, AC7). Each run starts from a clean tree (a new worktree, or the pool slot reset to the sha
 * with only red_pool's kept paths left), so nothing a run leaves behind (W01) or writes where the report goes reaches
 * the next. The caller has checked the names and what the patch touches (`touched`).
 * `name` is how the record names the patch. Same modes as redProof. Returns {ok, reason, via, cached}.
 */
function mutantProof({ cwd, sha, tests, patch, touched, name, cfg, mode = "miss" }) {
  if (!cfg.red_cmd) return { ok: false, cached: false, reason: "red proof needs red_cmd in .catalina/config.json" };
  const files = [...new Set(tests.map((t) => t.file))];
  prune(cwd, cfg.red_timeout_s * 1000 + 60000);
  const key = mutantKey({ sha, touched, files, named: tests.map((t) => t.name), patch, cfg, cwd });
  const hit = mode !== "run" && readCache(key, cwd, cfg, CACHE_VERSION);
  if (hit) return { ok: hit.ok, reason: fillName(hit.reason, name), via: fillName(hit.via, name), cached: true };
  if (mode === "cache") return { ok: false, cached: false, reason: `mutant ${name} not run yet — run \`catalina check --witness <N>\`` };

  const root = g.topLevel(cwd);
  const short = sha.slice(0, 7);
  const P = PATCH_TOKEN;
  let ws = null;
  const fresh = () => ws.at(sha);
  let result;
  let keep = true; // whether the verdict may be cached
  try {
    ws = workspace(cwd, cfg, root);
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const d = fresh();
      runs.push({ dir: d, run: runIn(d, cfg, files, root) });
    }
    const [one, two] = runs.map((x) => x.run);
    const timedOut = runs.find((x) => x.run.timeout);
    const killed = runs.find((x) => x.run.signal);
    const before = timedOut || killed ? null : caseResults(one, runs[0].dir);
    const flaky = before ? disagree(files, before, caseResults(two, runs[1].dir), one, two) : [];
    const notGreen = before ? tests.filter((t) => { const s = statuses(before, t); return !s.length || s.some((x) => x !== "passed"); }) : [];
    if (timedOut) result = { ok: false, reason: `green run timed out after ${cfg.red_timeout_s}s` };
    else if (killed) {
      keep = false; // a signal can come from outside the run (the OOM killer): run it again next time
      result = { ok: false, reason: `mutant ${P}: the test run without the mutant was killed (${killed.run.signal}), so there's no clean result to compare` };
    } else if (flaky.length) {
      keep = false;
      result = { ok: false, reason: `mutant ${P}: ${flaky.map(([f, ts]) => `${f} gives a different result each run without the mutant (${ts.join(", ")})`).join("; ")}, so a failure under it proves nothing — make the tests deterministic` };
    } else if (one.code !== 0) result = { ok: false, reason: `the tests fail at ${short} without the mutant — not green: ${files.join(", ")}` };
    else if (notGreen.length) result = { ok: false, reason: `mutant ${P}: ${notGreen.map((t) => t.name).join(", ")} didn't run and pass at ${short} without the mutant, so it can't be shown red` };
    else {
      const dir = fresh();
      let applied = null;
      try {
        apply(["--check"], patch, dir);
        if (!patchTouched(patch, dir).changes) result = { ok: false, reason: `mutant ${P} is empty — it changes no line of code` };
        else applied = apply([], patch, dir);
      } catch (e) {
        result = { ok: false, reason: `mutant ${P} doesn't apply at ${short}: ${gitError(e)}` };
      }
      if (applied !== null) {
        const mutated = runIn(dir, cfg, files, root);
        const after = mutated.timeout || mutated.signal ? null : caseResults(mutated, dir);
        const forged = after && mutated.code === 0 && files.some((f) => (after.get(f)?.cases || []).some((c) => c.status === "failed"));
        if (mutated.timeout) result = { ok: false, reason: `mutant ${P} run timed out after ${cfg.red_timeout_s}s — red not proven` };
        else if (mutated.signal) {
          keep = false;
          result = { ok: false, reason: `under mutant ${P} the test run was killed (${mutated.signal}): a run that doesn't finish gives no verdict, whatever report it leaves — a mutant breaks the guard, not the runner` };
        } else if (forged) result = { ok: false, reason: `under mutant ${P} the runner exited 0 but the report has failed tests, so the report isn't the run's` };
        else {
          const crashed = files.map((f) => [f, crashOf(f, before, after)]).filter(([, why]) => why);
          const survivors = tests.filter((t) => { const s = statuses(after, t); return !s.length || s.some((x) => x !== "failed"); });
          const loose = crashed.length || survivors.length ? [] : files.map((f) => unspecific(f, tests, before, after, P)).filter(Boolean);
          // vitest names the exit; under node:test a real exit ends the file before it reports a test.
          const exits = crashed.some(([, why]) => / called process\.exit$|^it reported no test$/.test(why));
          if (crashed.length) result = { ok: false, reason: `under mutant ${P} ${crashed.map(([f, why]) => `${f} failed to load or crashed: ${why}`).join("; ")} — not an assertion in a test, and breaking the build isn't breaking the guard${exits ? `. ${EXIT_HINT}` : ""}` };
          else if (survivors.length) result = { ok: false, reason: `mutant ${P} survives: ${survivors.map((t) => t.name).join(", ")} still passes with it applied, so the test doesn't pin what it breaks` };
          else if (loose.length) result = { ok: false, reason: loose.join("; ") };
          else result = { ok: true, reason: null, via: `red under mutant ${P}: ${tests.map((t) => t.name).join(", ")} fails with it, passes without it` };
        }
      }
    }
  } catch (e) {
    result = { ok: false, reason: `mutant ${P} could not run: ${e.message.split("\n")[0]}` };
  } finally {
    ws?.done();
  }
  if (keep && !/could not run|timed out/.test(result.reason || "")) writeCache(key, result, cwd, cfg);
  return { ok: result.ok, reason: fillName(result.reason, name), via: fillName(result.via, name), cached: false };
}

module.exports = { redProof, mutantProof, patchTouched, patchSymlinks, classify, caseResults, PER_TEST, cacheKey, missingImport, PREFIX };
