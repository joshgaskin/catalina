/**
 * Catalina — `catalina check <N>`: is issue N done the ILR way?
 *
 * Reads tracking.md + verification.jsonl from a COMMIT (source "commit", the default:
 * pre-push and audit grade what is shipped, not what is on disk) or from the working
 * tree (source "worktree": /witness before the evidence is committed, and the
 * witness-gate hook). Builds on hooks/lib/verify-witness.js and adds:
 *   - Definition of Done, Premortem (IDs or Trivial), Lessons applied
 *   - a verification line per premortem ID
 *   - the witnessed sha: every AC line names it; issue commits after it touch only tracking
 *   - the red-then-green proof (lib/red.js), or an exemption on a diff with no code
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

/** The base for issue N at sha: merge-base with the default branch, or (already merged) the parent of its first commit. */
function issueBase(n, sha, cfg, cwd) {
  const mb = g.mergeBase(sha, cfg.defaultRef, cwd);
  if (mb !== sha) return mb;
  const first = g.commits(null, sha, cwd, ["-E", `--grep=#${n}([^0-9]|$)`])[0];
  if (!first) throw new Error(`no commit references #${n} up to ${sha.slice(0, 7)}`);
  return g.tryGit(["rev-parse", `${first.sha}^`], cwd)?.trim() || first.sha;
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
    if (!witnessed || !g.isAncestor(witnessed, sha, cwd)) reasons.push(`witnessed sha ${shas[0].slice(0, 7)} is not in the history of ${sha.slice(0, 7)}`);
    else {
      const after = g.commits(witnessed, sha, cwd).filter((c) => refsIssue(c.message, n) || opts.allCommitsAreIssue);
      const code = after.flatMap((c) => c.files).filter((f) => !TRACKING_ONLY.test(f));
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
  if (tests.length) {
    red = redProof({ cwd, base, sha, files: tests, cfg, mode: opts.red || "miss" });
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

module.exports = { check, issueBase, refsIssue, TRACKING_ONLY };
