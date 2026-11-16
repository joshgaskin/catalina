/**
 * Catalina — `catalina check <N>`: is issue N done the ILR way?
 *
 * Reads tracking.md + verification.jsonl from a COMMIT (source "commit", the default:
 * pre-push and audit grade what is shipped, not what is on disk) or from the working
 * tree (source "worktree": /witness before the evidence is committed, and the
 * witness-gate hook). Builds on hooks/lib/verify-witness.js and adds:
 *   - Definition of Done, Premortem (IDs or Trivial), Lessons applied
 *   - a verification line per premortem ID
 *   - the witnessed sha: every AC line names it; issue commits after it touch only tracking. A witnessed sha that
 *     left the history (rebased after the witness, or squash-merged) counts where a commit carries its patch-id
 *   - the red-then-green proof (lib/red.js), or an exemption on a diff with no code; tests that already pass at the
 *     base (they pin a guard main has) prove red with a replayed mutant line instead (#28); a record
 *     written after its fix merged names `Red base: <sha>`, accepted only as the parent of the
 *     first commit referencing the issue (the merge-base already has the fix)
 *   - with --witness: an attempt record; the same failure at a new sha escalates (exit 3)
 *
 * Exit: 0 pass, 1 fail, 3 escalate. Any missing input fails — never passes on absence.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const g = require("./git");
const t = require("./tracking");
const cfgLib = require("./config");
const { matcher } = require("./glob");
const { redProof, mutantProof, patchTouched, patchSymlinks, PER_TEST } = require("./red");
const { changedTest, baseBodies, mask, SEP } = require("./testcases");
const { verifyWitness } = require("../hooks/lib/verify-witness");

const TRACKING_ONLY = /^\.claude\/tracking\//;
const refsIssue = (message, n) => g.issueRefs(message).includes(Number(n));

/** Each directory above rel, nearest the root first: "a/b/c.patch" → ["a", "a/b"]. */
const parents = (rel) => rel.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"));

/**
 * kind(rel): "file", "dir", "symlink" or null — a mutant patch must be a plain file (witness D6). linkParent(rel): the
 * first directory above rel that is a symlink, or null: a patch under a linked directory is read from outside the
 * repo (W10c, W10w), so both readers check every parent.
 */
function commitReader(sha, cwd) {
  const kind = (rel) => {
    const m = (g.tryGit(["ls-tree", sha, "--", rel], cwd) || "").match(/^(\d+) (\w+) /);
    if (!m) return null;
    return m[1] === "120000" ? "symlink" : m[2] === "tree" ? "dir" : m[2] === "blob" ? "file" : null;
  };
  const linkParent = (rel) => parents(rel).find((d) => kind(d) === "symlink") || null;
  return { text: (rel) => g.show(sha, rel, cwd), buf: (rel) => g.showBuffer(sha, rel, cwd), kind, linkParent };
}

function diskReader(root) {
  const abs = (rel) => path.join(root, rel);
  const kind = (rel) => {
    try {
      const st = fs.lstatSync(abs(rel));
      return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
    } catch {
      return null;
    }
  };
  const linkParent = (rel) => parents(rel).find((d) => kind(d) === "symlink") || null;
  return { text: (rel) => (fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), "utf8") : null), buf: (rel) => (fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel)) : null), kind, linkParent };
}

const MUTANT_LINE = `{"red_green":"mutant","patch":"evidence/<name>.patch","tests":["<file>${SEP}<describe>${SEP}<test>"],"reason":"…"}`;

/**
 * Test infrastructure a mutant must not touch (witness D5, N20–N22, W05): what the tests run on rather than the code
 * they test. → (file) → what it is, or null. Mocks, test and fixture dirs, setup and global setup files (`*.setup.*`,
 * `*-setup.*`, `setupTests.*`; not a plain `setup.*`, which is code), test utilities, `*.mock(s).*`, `*.fixture(s).*`
 * and `*.helper(s).*` files, runner config, and test_helper_glob. A name it misses is the reviewer's to catch.
 */
function infraMatcher(cfg) {
  const extra = matcher(cfg.test_helper_glob || []);
  const DIRS = [
    [["__mocks__", "mocks"], "a mocks directory"],
    [["__tests__", "test", "tests"], "a test directory"],
    [["fixtures", "__fixtures__"], "a fixtures directory"],
    [["test-utils", "testutils", "test_utils", "test-helpers", "test_helpers"], "a test utilities directory"],
  ];
  const JS = String.raw`\.[cm]?[jt]sx?$`;
  const FILES = [
    [/^(?:vite|vitest|jest|ava|playwright|cypress|karma)\.(?:config|workspace|preset)\.|^vitest\.workspace\.|^karma\.conf\.|^\.mocharc|^\.c8rc|^\.nycrc/, "runner config"],
    [new RegExp(String.raw`[.-]setup\.|^setup(?!\.)[^/]*${JS}|(?:^|[.\-_])global[-_]?setup\.`, "i"), "a test setup file"],
    [/^test[-_]?(?:utils|helpers)\.|\.(?:fixtures?|helpers?|mocks?)\./i, "a test helper"],
  ];
  return (f) => {
    const dirs = f.split("/").slice(0, -1);
    const base = path.posix.basename(f);
    for (const [names, what] of DIRS) if (dirs.some((d) => names.includes(d))) return what;
    for (const [re, what] of FILES) if (re.test(base)) return what;
    return extra(f) ? "test_helper_glob" : null;
  };
}

/** Modules a mutant's code must not load (witness V4, N14, W06): test runners, assertion and spy libraries. */
const RUNNER_MODULE = /^(?:vitest|vitest\/.*|@vitest\/.*|jest|jest\/.*|@jest\/.*|node:test|node:test\/.*|assert|assert\/strict|node:assert|node:assert\/strict|chai|chai\/.*|expect|sinon|sinon\/.*|should|should\/.*|@testing-library\/jest-dom|@testing-library\/jest-dom\/.*)$/;
/** The runner's globals, as a name a mutant could reach them by (`globalThis.x`, `globalThis["x"]`). */
const RUNNER_GLOBALS = new Set(["expect", "assert", "vi", "jest", "describe", "suite", "test", "it", "beforeEach", "afterEach", "beforeAll", "afterAll", "__vitest_worker__"]);
/** Runner globals a mutant's code must not use, in code (not comments or strings). */
const RUNNER_USE = /(?<![\w$])(?:(?:beforeEach|afterEach|beforeAll|afterAll|__vitest_worker__)(?![\w$])|onTest[A-Z][\w$]*\s*\(|import\s*\.\s*meta\s*\.\s*vitest(?![\w$])|(?:expect|assert|vi|jest)\s*\.|(?:globalThis|global)\s*\.\s*(?:expect|assert|vi|jest|describe|suite|test|it)(?![\w$]))/;
/** `globalThis["x"]`, `global['x']`, or `globalThis, "x"` (defineProperty, Reflect): the string at the match's end names the global. */
const GLOBAL_BY_STRING = /(?<![\w$.])(?:globalThis|global)\s*(?:\[\s*|,\s*)(?=['"`])/g;
const LOADS = /(?<![\w$.])(?:require\s*\(\s*|import\s*\(\s*|import\s+|from\s+)(?=['"`])/g;

/**
 * The first line each file's added lines use to reach into the test runner: an import or require of a runner,
 * assertion or spy module, a runner hook or `onTest…` callback, `import.meta.vitest`, vitest's worker state, a runner
 * global by name or by string, or `expect.`/`assert.`/`vi.`/`jest.` in code. → [{ file, line }]. A mutant that changes
 * what the test runner does can fail any test for a reason that has nothing to do with the code (V4: a `beforeEach`
 * that throws for some test names). It reads the text: an obfuscated reach (a computed name, `module.constructor`) is
 * the reviewer's to catch.
 */
function runnerReach(patch) {
  const added = new Map();
  let file = null;
  let hunk = false;
  for (const line of patch.toString("utf8").split("\n")) {
    if (line.startsWith("diff --git ")) {
      hunk = false;
      file = null;
    } else if (!hunk && line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "").replace(/\t.*$/, "");
    else if (line.startsWith("@@")) hunk = true;
    else if (hunk && file && line.startsWith("+")) added.set(file, [...(added.get(file) || []), line.slice(1)]);
  }
  const found = [];
  for (const [f, lines] of added) {
    const { masked, strings } = mask(lines.join("\n"));
    let off = 0;
    for (const line of lines) {
      const code = masked.slice(off, off + line.length);
      const named = (re, test) => [...code.matchAll(re)].some((m) => test(strings.get(off + m.index + m[0].length) ?? ""));
      const loads = named(LOADS, (s) => RUNNER_MODULE.test(s));
      const global = named(GLOBAL_BY_STRING, (s) => RUNNER_GLOBALS.has(s));
      if (loads || global || RUNNER_USE.test(code)) {
        found.push({ file: f, line: line.trim() });
        break;
      }
      off += line.length + 1;
    }
  }
  return found;
}

/**
 * Why a file a mutant touches is outside the code the base tracks, or null (W09): it sits under node_modules (a
 * dependency the checkout copies in, red_setup), git ignores it, or the base doesn't track it.
 */
function outsideBase(f, base, cwd) {
  if (f.split("/").includes("node_modules")) return "under node_modules";
  if (g.tryGit(["check-ignore", "-q", "--no-index", "--", f], cwd) !== null) return "ignored";
  if (!g.blob(base, f, cwd)) return "not tracked at the base";
  return null;
}

/**
 * The red proof for tests that already pass at the base (#28): each `red_green: "mutant"` line names a patch under the
 * issue's tracking dir that breaks the guard its named tests pin, and must hold (see mutantProof). Checked here before
 * anything runs: a runner with per-test results, a reason, a plain file in the tracking dir, tests named as
 * `<file> > <describe…> > <title>` that are new or changed since the base, a patch that changes code the base tracks
 * only (not node_modules, ignored or added files) and doesn't reach into the runner. Then every
 * file in `basePass` (it passes at the base) needs a line that names a test in it (witness D4). → { reasons, red }.
 */
function mutantRed(n, lines, { cwd, base, sha, tests, basePass, cfg, mode, read, isCode, isTest }) {
  const dir = `.claude/tracking/issue-${n}`;
  if (!PER_TEST.has(cfg.red_parser)) {
    const reason = `mutant lines need per-test results, and red_parser "${cfg.red_parser}" can't give them: run the tests with a JSON report (red_parser vitest or jest), or make the test fail on main`;
    return { reasons: [reason], red: { ok: false, reason, cached: false } };
  }
  const infra = infraMatcher(cfg);
  let bodies = null;
  const atBase = () => (bodies ??= baseBodies(base, isTest, cwd));
  const reasons = [];
  const vias = [];
  const covered = new Set();
  let cached = true;
  for (const l of lines) {
    const raw = typeof l.patch === "string" ? l.patch.trim() : "";
    if (!raw) {
      reasons.push(`a {"red_green":"mutant"} line needs "patch": a file under ${dir}/`);
      continue;
    }
    const name = raw;
    if (typeof l.reason !== "string" || !l.reason.trim()) {
      reasons.push(`mutant ${name} needs a "reason": the guard it breaks, as text`);
      continue;
    }
    const rel = path.posix.normalize(raw.startsWith(`${dir}/`) ? raw : path.posix.join(dir, raw));
    if (path.posix.isAbsolute(raw) || path.isAbsolute(raw) || !rel.startsWith(`${dir}/`)) {
      reasons.push(`mutant ${name}: the patch must be a file under ${dir}/`);
      continue;
    }
    const link = read.linkParent(rel);
    if (link) {
      reasons.push(`mutant ${name} sits under a symlink (${link}); commit the patch itself under ${dir}/`);
      continue;
    }
    const kind = read.kind(rel);
    if (kind === "dir") {
      reasons.push(`mutant ${name} is a directory, not a patch file`);
      continue;
    }
    if (kind === "symlink") {
      reasons.push(`mutant ${name} is a symlink; commit the patch itself under ${dir}/`);
      continue;
    }
    const patch = kind === "file" ? read.buf(rel) : null;
    if (patch === null) {
      reasons.push(`mutant ${name}: no such file in ${dir}/`);
      continue;
    }
    const names = l.tests == null ? [] : [].concat(l.tests);
    if (!names.length) {
      reasons.push(`mutant ${name} names no test: list each as "<file>${SEP}<describe>${SEP}<test>"`);
      continue;
    }
    const resolved = names.map((x) => changedTest(x, { tests, base, sha, atBase, cwd }));
    const bad = resolved.filter((r) => r.error);
    if (bad.length) {
      reasons.push(...bad.map((r) => `mutant ${name}: ${r.error}`));
      continue;
    }
    for (const r of resolved) covered.add(r.file); // a line refused below has its own reason; don't add "no line names it"
    const touched = patchTouched(patch, cwd);
    if (touched.error) {
      reasons.push(`mutant ${name} isn't a patch git can read: ${touched.error}`);
      continue;
    }
    if (!touched.files.length || !touched.changes) {
      reasons.push(`mutant ${name} is empty — it changes no line of code`);
      continue;
    }
    if (touched.binary.length) {
      reasons.push(`mutant ${name} changes ${touched.binary.join(", ")} as binary: a mutant is a text diff a reviewer can read`);
      continue;
    }
    const links = patchSymlinks(patch);
    if (links.length) {
      reasons.push(`mutant ${name} touches ${links.join(", ")} as a symlink: a mutant changes code only`);
      continue;
    }
    const tests_ = touched.files.filter((f) => TRACKING_ONLY.test(f) || isTest(f));
    const infras = touched.files.filter((f) => !tests_.includes(f) && infra(f));
    const other = touched.files.filter((f) => !tests_.includes(f) && !infras.includes(f) && !isCode(f));
    if (tests_.length || infras.length || other.length) {
      const list = [...tests_, ...infras.map((f) => `${f} (test infrastructure: ${infra(f)})`), ...other];
      reasons.push(`mutant ${name} touches ${list.join(", ")}: a mutant changes the code under test only, never tests, test infrastructure, tracking or other files`);
      continue;
    }
    const untracked = touched.files.map((f) => [f, outsideBase(f, base, cwd)]).filter(([, why]) => why);
    if (untracked.length) {
      reasons.push(`mutant ${name} touches ${untracked.map(([f, why]) => `${f} (${why})`).join(", ")}: a mutant changes code the base tracks, never a dependency, a generated file or a file the change adds`);
      continue;
    }
    const reach = runnerReach(patch);
    if (reach.length) {
      reasons.push(`mutant ${name} reaches into the test runner: ${reach.map((x) => `${x.file} adds \`${x.line.length > 80 ? `${x.line.slice(0, 77)}...` : x.line}\``).join("; ")}. A mutant breaks the code, never the runner or its assertions, or any test can fail for a reason that isn't the guard`);
      continue;
    }
    const r = mutantProof({ cwd, sha, tests: resolved, patch, touched: touched.files, name, cfg, mode });
    cached = cached && r.cached;
    if (r.ok) vias.push(r.via);
    else reasons.push(r.reason);
  }
  for (const f of basePass) {
    if (!covered.has(f)) reasons.push(`${f} already passes on main and no mutant line names a test in it — make it fail before the fix, or add a mutant line for it`);
  }
  const ok = reasons.length === 0;
  return { reasons, red: { ok, reason: reasons[0] || null, ...(ok ? { via: vias.join("; ") } : {}), cached } };
}

/** The parent of the first commit up to sha that mentions #N, or null. */
function fixParent(n, sha, cwd) {
  const first = g.commits(null, sha, cwd, ["-E", `--grep=#${n}([^0-9]|$)`])[0];
  return first ? g.tryGit(["rev-parse", "--verify", "--quiet", `${first.sha}^`], cwd)?.trim() || null : null;
}

/** The base for issue N at sha: merge-base with the default branch, or (already merged) the parent of its first commit. */
function issueBase(n, sha, cfg, cwd) {
  const mb = g.mergeBase(sha, cfg.defaultRef, cwd);
  if (mb !== sha) return mb;
  const first = g.commits(null, sha, cwd, ["-E", `--grep=#${n}([^0-9]|$)`])[0];
  if (!first) throw new Error(`no commit references #${n} up to ${sha.slice(0, 7)}`);
  return g.tryGit(["rev-parse", `${first.sha}^`], cwd)?.trim() || first.sha;
}

/**
 * Is `resolved` the conflicted file (git's merge with conflict markers) with every conflict resolved by keeping both
 * sides, in either order, and nothing else changed? A side that is empty (one side deleted the lines) is a choice, not
 * both; a file with no conflict isn't a resolution (#31).
 */
function keptBoth(conflicted, resolved) {
  if (conflicted == null || resolved == null) return false;
  const segs = [];
  let hunk = null;
  let side = null;
  for (const line of conflicted.split("\n")) {
    if (!hunk) {
      if (line.startsWith("<<<<<<< ")) [hunk, side] = [{ ours: [], theirs: [] }, "ours"];
      else segs.push(line);
    } else if (line.startsWith("||||||| ")) side = "base"; // diff3 style: the merge base's lines, kept by neither side
    else if (line === "=======") side = "theirs";
    else if (line.startsWith(">>>>>>> ")) {
      segs.push(hunk);
      hunk = null;
    } else if (side !== "base") hunk[side].push(line);
  }
  const hunks = segs.filter((x) => typeof x !== "string");
  if (hunk || !hunks.length || hunks.some((h) => !h.ours.length || !h.theirs.length)) return false;
  const res = resolved.split("\n");
  const at = (p, lines) => lines.every((l, i) => res[p + i] === l);
  let pos = new Set([0]);
  for (const x of segs) {
    const next = new Set();
    for (const p of pos) {
      if (typeof x === "string") res[p] === x && next.add(p + 1);
      else for (const lines of [[...x.ours, ...x.theirs], [...x.theirs, ...x.ours]]) at(p, lines) && next.add(p + lines.length);
    }
    if (!next.size) return false;
    pos = next;
  }
  return pos.has(res.length);
}

/**
 * Where a witnessed sha's change sits in sha's history when the witnessed sha itself doesn't: the branch was rebased
 * after the witness, or the PR was squash-merged (plus2 #2214). The image is the latest commit X from the witnessed
 * sha's fork point whose diff from base (a rebased branch, X in base..sha) or whose own diff (a squash) has the
 * witnessed change's patch-id, tracking excluded. When main moved under the change, the squash or rebase differs from
 * the witnessed diff wherever git merged the two for it, so the second test is the merge itself (#20): X's tree is the
 * clean three-way merge of the witnessed commit onto X's parent side, except in files that are neither code nor tests
 * (RELEASE_NOTES.md, docs: where two PRs' entries meet), and except conflicts resolved by keeping both sides (#31). A
 * code or test file git could not merge cleanly and a person resolved to anything else than the witnessed version
 * differs from that merge: it is code no witness saw. → { sha, unaccounted }; unaccounted is every
 * commit from the fork point to sha the match doesn't cover, so code no witness saw still fails. No match → { sha: null,
 * near, differs }: the closest candidate and the code/test files where its tree isn't the witnessed change merged.
 */
function witnessImage(witnessed, sha, base, cwd, cfg) {
  const from = g.mergeBase(witnessed, sha, cwd);
  const want = g.patchId(from, witnessed, cwd);
  if (!want) return { sha: null, near: null, differs: [] };
  const isCode = matcher(cfg.code_glob);
  const isTest = matcher(cfg.test_glob);
  const range = g.commits(from, sha, cwd, ["--topo-order"]);
  const branch = g.commits(base, sha, cwd, ["--topo-order"]);
  const parentOf = (c) => g.tryGit(["rev-parse", "--verify", "--quiet", `${c}^1`], cwd)?.trim();
  // Each commit is a candidate for its own diff (a squash) and, on the branch, its diff from base (a rebase); the
  // latest match wins, the wider one when both match.
  const candidates = range.flatMap((c) => {
    const i = branch.findIndex((b) => b.sha === c.sha);
    const own = { sha: c.sha, from: parentOf(c.sha), covered: [c] };
    return i >= 0 ? [own, { sha: c.sha, from: base, covered: branch.slice(0, i + 1) }] : [own];
  }).filter((x) => x.from);
  const files = new Set(g.out(["diff", "--name-only", from, witnessed, "--", ...g.NOT_TRACKING], cwd).split("\n"));
  // A candidate that carries the witnessed change touches at least one of its files.
  const touching = candidates.filter((x) => x.covered.some((c) => c.files.some((f) => files.has(f))));
  // The code and test files where x's tree isn't the witnessed commit merged onto x.from; null when git can't merge them.
  const memo = new Map();
  const unwitnessed = (x) => {
    const key = `${x.from} ${x.sha}`;
    if (!memo.has(key)) {
      const tree = g.mergeTree(x.from, witnessed, cwd);
      // A file resolved to exactly the witnessed version is the witnessed change, not a new one; so is a conflict
      // resolved by keeping both sides (#31: two PRs adding cases at the same place).
      const same = (f) => g.blob(x.sha, f, cwd) === g.blob(witnessed, f, cwd);
      const both = (f) => keptBoth(g.show(tree, f, cwd), g.show(x.sha, f, cwd));
      memo.set(key, tree && g.treeDiff(tree, x.sha, cwd).filter((f) => (isCode(f) || isTest(f)) && !same(f) && !both(f)));
    }
    return memo.get(key);
  };
  const image = candidates.filter((x) => g.patchId(x.from, x.sha, cwd) === want).pop() || touching.filter((x) => unwitnessed(x)?.length === 0).pop();
  if (image) {
    const covered = new Set(image.covered.map((c) => c.sha));
    return { sha: image.sha, unaccounted: range.filter((c) => !covered.has(c.sha)) };
  }
  // No match: name the closest commit that touches the witnessed files, and the code and test files where it differs.
  let near = null;
  for (const x of touching) {
    const differs = unwitnessed(x) || g.differingFiles(from, witnessed, x.from, x.sha, cwd);
    if (!near || differs.length <= near.differs.length) near = { sha: x.sha, differs };
  }
  return { sha: null, near: near?.sha || null, differs: near?.differs || [] };
}

function check(n, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const reasons = [];
  const fail = (exit = 1) => ({ ok: false, exit, reasons, red: null });
  let cfg;
  try {
    cfg = opts.config || cfgLib.load(cwd, opts.remote);
  } catch (e) {
    reasons.push(e.message);
    return fail();
  }
  if (!cfg) {
    reasons.push(`no ${cfgLib.CONFIG_PATH} on the default branch — this project hasn't adopted Catalina`);
    return fail();
  }

  const source = opts.source || "commit";
  let sha, base, issueCommits;
  try {
    sha = g.resolve(opts.sha || "HEAD", cwd);
    base = opts.base ? g.resolve(opts.base, cwd) : issueBase(n, sha, cfg, cwd);
    issueCommits = opts.issueCommits || g.commits(base, sha, cwd).filter((c) => refsIssue(c.message, n));
  } catch (e) {
    reasons.push(`git: ${e.message.split("\n")[0]}`);
    return fail();
  }

  const reader = source === "worktree" ? undefined : commitReader(sha, cwd);
  const w = verifyWitness(n, { repoRoot: g.topLevel(cwd), reader });
  reasons.push(...w.reasons);
  const tracking = w.tracking;
  if (tracking) {
    // Definition of Done
    const dod = t.section(tracking, "Definition of Done");
    if (!dod || !/^- \[[ xX]\]/m.test(dod)) reasons.push("no Definition of Done items in tracking.md");
    // Premortem
    const pm = t.premortem(tracking);
    if (!pm.present) reasons.push("no ## Premortem section — write the reviewer's failure modes (P1, P2…) or `Trivial: <reason>`");
    else if (!pm.trivial && pm.ids.length === 0) reasons.push("Premortem has no items with IDs (`- **P1 …** — …`) and no `Trivial: <reason>` line");
    for (const id of pm.trivial ? [] : pm.ids) {
      if (!w.premortemLines.some((l) => String(l.premortem).match(/^P\d+/)?.[0] === id)) {
        reasons.push(`premortem ${id} has no verification.jsonl line ({"premortem":"${id}","outcome":…})`);
      }
    }
    // Lessons applied
    if (!t.filled(t.section(tracking, "Lessons applied"))) {
      reasons.push("no ## Lessons applied section — paste `catalina recall` output (\"None found\" is fine)");
    }
  }

  // Witnessed sha
  const shas = [...new Set(w.acLines.map((l) => l.sha).filter(Boolean))];
  if (w.acLines.length && w.acLines.some((l) => !l.sha)) reasons.push('every AC line must name the witnessed commit in "sha"');
  else if (shas.length > 1) reasons.push(`AC lines name different witnessed shas: ${shas.join(", ")}`);
  else if (shas.length === 1) {
    const witnessed = g.tryGit(["rev-parse", "--verify", `${shas[0]}^{commit}`], cwd)?.trim();
    const ancestor = !!witnessed && g.isAncestor(witnessed, sha, cwd);
    const image = witnessed && !ancestor ? witnessImage(witnessed, sha, base, cwd, cfg) : null;
    if (!ancestor && !image?.sha) {
      const differs = image?.differs.length ? `; the closest commit, ${image.near.slice(0, 7)}, has a different change in ${image.differs.join(", ")}` : "";
      reasons.push(`witnessed sha ${shas[0].slice(0, 7)} is not in the history of ${sha.slice(0, 7)}${differs}`);
    } else {
      // The audit's PR path counts every commit the PR adds, never the default branch's commits around it.
      const own = new Set(issueCommits.map((c) => c.sha));
      const after = ancestor ? g.commits(witnessed, sha, cwd) : image.unaccounted;
      const code = after
        .filter((c) => refsIssue(c.message, n) || (opts.allCommitsAreIssue && own.has(c.sha)))
        .flatMap((c) => c.files)
        .filter((f) => !TRACKING_ONLY.test(f));
      if (code.length) reasons.push(`commits after the witnessed sha change code (${[...new Set(code)].join(", ")}) — re-witness at the new commit`);
    }
  }

  // Red proof
  const isTest = matcher(cfg.test_glob);
  const isCode = matcher(cfg.code_glob);
  const files = [...new Set(issueCommits.flatMap((c) => c.files))].filter((f) => !TRACKING_ONLY.test(f));
  const tests = files.filter((f) => isTest(f) && g.blob(sha, f, cwd));
  const code = files.filter((f) => isCode(f) && !isTest(f));
  const exempt = w.otherLines.find((l) => l.red_green === "none");
  let red = null;
  let redBase = base;
  const named = tracking ? t.redBase(tracking) : null;
  if (named) {
    const want = fixParent(n, sha, cwd);
    const got = g.tryGit(["rev-parse", "--verify", "--quiet", `${named}^{commit}`], cwd)?.trim();
    if (got && got === want) redBase = got;
    else reasons.push(`Red base ${named} is not the parent of the first commit referencing #${n}${want ? ` (${want.slice(0, 9)})` : ""} — name that or drop the line`);
  }
  if (tests.length) {
    // A repo's first code: the red base holds no code file, so every new test fails to load there.
    const tree = g.tryGit(["ls-tree", "-r", "--name-only", redBase], cwd);
    const greenfield = tree !== null && !tree.split("\n").some((f) => f && isCode(f) && !isTest(f) && !TRACKING_ONLY.test(f));
    red = redProof({ cwd, base: redBase, sha, files: tests, cfg, mode: opts.red || "miss", greenfield });
    const mutants = w.otherLines.filter((l) => l.red_green === "mutant");
    if (!red.ok && red.basePass && mutants.length) {
      const read = reader || diskReader(g.topLevel(cwd));
      const m = mutantRed(n, mutants, { cwd, base: redBase, sha, tests, basePass: [].concat(red.basePass), cfg, mode: opts.red || "miss", read, isCode, isTest });
      red = m.red;
      reasons.push(...m.reasons);
    } else if (!red.ok && red.basePass) {
      const way = PER_TEST.has(cfg.red_parser)
        ? `break the guard in a patch and record ${MUTANT_LINE}`
        : `a mutant line can prove it only with a runner that reports each test (red_parser vitest or jest)`;
      reasons.push(`${red.reason}; if it pins a guard main already has, ${way}`);
    } else if (!red.ok) reasons.push(red.reason);
  } else if (code.length) {
    reasons.push(
      exempt
        ? `red_green exemption "${exempt.reason}" isn't allowed on a diff that changes code (${code.join(", ")})`
        : `code changed with no test change (${code.join(", ")}) — add a test that fails on main`
    );
  } else if (!exempt || !String(exempt.reason || "").trim()) {
    reasons.push('no test changed: record why with {"red_green":"none","reason":"…"} in verification.jsonl');
  }

  // Attempts (witness only): the same failure at a new sha twice in a row → escalate.
  let exit = reasons.length ? 1 : 0;
  if (opts.witness) {
    const file = path.join(g.topLevel(cwd), ".claude", "tracking", `issue-${n}`, "attempts.jsonl");
    const hash = crypto.createHash("sha1").update([...reasons].sort().join("\n")).digest("hex");
    const esc = tracking ? t.escalations(tracking) : 0;
    let attempts = [];
    try {
      attempts = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {}
    const last = attempts[attempts.length - 1];
    if (exit && last && !last.ok && last.sha !== sha && last.hash === hash && last.escalations === esc) {
      reasons.unshift("ESCALATE: same failure twice — stop and ask a person; record the answer as `- ESCALATED: <who, what>` in Review History");
      exit = 3;
    }
    if (!last || last.sha !== sha) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), sha, ok: exit === 0, hash, escalations: esc }) + "\n");
    }
  }
  return { ok: exit === 0, exit, reasons, red, sha, base };
}

module.exports = { keptBoth, check, issueBase, fixParent, witnessImage, refsIssue, infraMatcher, runnerReach, TRACKING_ONLY };
