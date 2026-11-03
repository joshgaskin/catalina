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
 *   - the red-then-green proof (lib/red.js), or an exemption on a diff with no code; a record
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
const { redProof } = require("./red");
const { verifyWitness } = require("../hooks/lib/verify-witness");

const TRACKING_ONLY = /^\.claude\/tracking\//;
const refsIssue = (message, n) => g.issueRefs(message).includes(Number(n));

function commitReader(sha, cwd) {
  return { text: (rel) => g.show(sha, rel, cwd), buf: (rel) => g.showBuffer(sha, rel, cwd) };
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
 * Where a witnessed sha's change sits in sha's history when the witnessed sha itself doesn't: the branch was rebased
 * after the witness, or the PR was squash-merged (plus2 #2214). The image is the latest commit X from the witnessed
 * sha's fork point whose diff from base (a rebased branch, X in base..sha) or whose own diff (a squash) has the
 * witnessed change's patch-id, tracking excluded. → { sha, unaccounted }; unaccounted is every commit from
 * the fork point to sha the match doesn't cover, so code no witness saw still fails. No match → { sha: null, near,
 * differs }: the closest candidate and the files where its change isn't the witnessed one.
 */
function witnessImage(witnessed, sha, base, cwd) {
  const from = g.mergeBase(witnessed, sha, cwd);
  const want = g.patchId(from, witnessed, cwd);
  if (!want) return { sha: null, near: null, differs: [] };
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
  const image = candidates.filter((x) => g.patchId(x.from, x.sha, cwd) === want).pop();
  if (image) {
    const covered = new Set(image.covered.map((c) => c.sha));
    return { sha: image.sha, unaccounted: range.filter((c) => !covered.has(c.sha)) };
  }
  // No match: name the closest commit that touches the witnessed files, and the files where it differs.
  const files = new Set(g.out(["diff", "--name-only", from, witnessed, "--", ...g.NOT_TRACKING], cwd).split("\n"));
  let near = null;
  for (const x of candidates.filter((x) => x.covered.some((c) => c.files.some((f) => files.has(f))))) {
    const differs = g.differingFiles(from, witnessed, x.from, x.sha, cwd);
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
    const image = witnessed && !ancestor ? witnessImage(witnessed, sha, base, cwd) : null;
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
    red = redProof({ cwd, base: redBase, sha, files: tests, cfg, mode: opts.red || "miss" });
    if (!red.ok) reasons.push(red.reason);
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

module.exports = { check, issueBase, fixParent, witnessImage, refsIssue, TRACKING_ONLY };
