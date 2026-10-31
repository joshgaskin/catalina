/**
 * Catalina — `catalina audit`: did everything on the default branch pass the gate?
 *
 * The pre-push hook can't see merges done on GitHub (`gh pr merge`) or pushes made with
 * hooks skipped, so this runs `catalina check` again over the last window of commits on
 * the default branch (stateless: no notes, no cursor) and files one GitHub issue per
 * commit that never passed, deduped by title. A commit is accepted when:
 *   - it touches only .claude/tracking/**
 *   - it is a quick commit (no issue >= enforce_from) outside no_undo
 *   - its issue passes `catalina check` at the commit (direct pushes), or at the PR head
 *     for squash/merge commits (the issue then also comes from the PR branch name/body)
 */
const fs = require("fs");
const { execFileSync } = require("child_process");
const g = require("./git");
const cfgLib = require("./config");
const { check, TRACKING_ONLY } = require("./check");
const { gate, shadowLog } = require("./prepush");

const LABEL = "catalina-unchecked";
const CAP = 5;

function ghRun(args) {
  return execFileSync(process.env.CATALINA_GH || "gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const ghJson = (args) => JSON.parse(ghRun(args) || "null");

function windowStart(since) {
  const m = String(since).match(/^(\d+)([hd])$/);
  if (!m) throw new Error(`--since must look like 72h or 3d, got "${since}"`);
  return new Date(Date.now() - Number(m[1]) * (m[2] === "h" ? 3600e3 : 86400e3));
}

function slugOf(cfg, cwd) {
  if (cfg.repo) return cfg.repo;
  const url = g.out(["remote", "get-url", cfg.remote], cwd);
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`can't tell the GitHub repo from ${url}; set "repo" in .catalina/config.json`);
  return m[1];
}

function prIssues(pr, message, cfg) {
  const ns = new Set([...g.issueRefs(message), ...g.issueRefs(pr.body || ""), ...g.issueRefs(pr.title || "")]);
  const m = String(pr.head?.ref || "").match(new RegExp(cfg.branch_issue_pattern));
  if (m) ns.add(Number(m[1] || m[2]));
  return [...ns].filter((n) => n >= cfg.enforce_from);
}

/** Findings for the window: [{sha, what, reasons}]. */
function findings(cfg, cwd, since) {
  const slug = slugOf(cfg, cwd);
  const all = g.commits(null, cfg.defaultRef, cwd, ["--first-parent", `--since=${windowStart(since).toISOString()}`]);
  const out = [];
  const issueTips = new Map(); // issue -> latest direct commit referencing it (evidence commits included)
  const issuesWithCode = new Set();

  for (const c of all) {
    if (!c.files.some((f) => !TRACKING_ONLY.test(f))) {
      for (const n of g.issueRefs(c.message)) if (issueTips.has(n)) issueTips.set(n, c.sha);
      continue;
    }
    if (g.show(`${c.sha}^`, cfgLib.CONFIG_PATH, cwd) === null) continue; // before (or the commit of) adoption
    const pr = (ghJson(["api", `repos/${slug}/commits/${c.sha}/pulls`]) || []).find((p) => p.merge_commit_sha === c.sha);
    if (pr) {
      const issues = prIssues(pr, c.message, cfg);
      const parent = g.out(["rev-parse", `${c.sha}^1`], cwd);
      if (!issues.length) {
        const reasons = gate([{ ...c, message: "" }], cfg, cwd, c.sha);
        if (reasons.length) out.push({ sha: c.sha, what: `PR #${pr.number} (no issue)`, reasons });
        continue;
      }
      g.tryGit(["fetch", "-q", cfg.remote, `refs/pull/${pr.number}/head`], cwd);
      if (g.tryGit(["cat-file", "-e", `${pr.head.sha}^{commit}`], cwd) === null) {
        out.push({ sha: c.sha, what: `PR #${pr.number}`, reasons: [`PR head ${pr.head.sha.slice(0, 7)} can't be fetched, so it can't be checked`] });
        continue;
      }
      const base = g.mergeBase(pr.head.sha, parent, cwd);
      const issueCommits = g.commits(base, pr.head.sha, cwd);
      for (const n of issues) {
        const r = check(n, { cwd, sha: pr.head.sha, base, issueCommits, allCommitsAreIssue: true, source: "commit", red: "miss", config: cfg });
        if (!r.ok) out.push({ sha: c.sha, what: `PR #${pr.number}, issue #${n}`, reasons: r.reasons });
      }
      continue;
    }
    const enforced = g.issueRefs(c.message).filter((n) => n >= cfg.enforce_from);
    if (enforced.length) enforced.forEach((n) => (issueTips.set(n, c.sha), issuesWithCode.add(n)));
    else {
      const reasons = gate([c], cfg, cwd, c.sha);
      if (reasons.length) out.push({ sha: c.sha, what: "quick commit", reasons });
    }
  }
  for (const [n, sha] of [...issueTips].filter(([n]) => issuesWithCode.has(n))) {
    const r = check(n, { cwd, sha, source: "commit", red: "miss", config: cfg });
    if (!r.ok) out.push({ sha, what: `issue #${n}`, reasons: r.reasons });
  }
  return out;
}

function exists(title) {
  return (ghJson(["issue", "list", "--state", "all", "--search", `${title} in:title`, "--json", "title", "--limit", "20"]) || []).some((i) => i.title === title);
}

function body(f) {
  return [
    `Commit \`${f.sha}\` (${f.what}) is on the default branch but never passed \`catalina check\`:`,
    "",
    ...f.reasons.map((r) => `- ${r}`),
    "",
    "Fix: witness it and push the evidence (`catalina check <N> --witness`), or revert the commit. Filed by `catalina audit`.",
  ].join("\n");
}

function file(list, dryRun) {
  const fresh = list.filter((f) => !exists(`${LABEL}: ${f.sha.slice(0, 7)}`));
  if (dryRun || !fresh.length) return fresh;
  ghRun(["label", "create", LABEL, "--force", "--color", "B60205", "--description", "On the default branch without passing catalina check"]);
  for (const f of fresh.slice(0, CAP)) ghRun(["issue", "create", "--title", `${LABEL}: ${f.sha.slice(0, 7)}`, "--label", LABEL, "--body", body(f)]);
  const rest = fresh.slice(CAP);
  if (rest.length) {
    const title = `${LABEL}: summary ${new Date().toISOString().slice(0, 10)}`;
    if (!exists(title)) {
      const text = [`${rest.length} more commits never passed \`catalina check\`:`, "", ...rest.map((f) => `- \`${f.sha.slice(0, 7)}\` ${f.what}: ${f.reasons[0]}`)].join("\n");
      ghRun(["issue", "create", "--title", title, "--label", LABEL, "--body", text]);
    }
  }
  return fresh;
}

function shadowDays(cwd, since) {
  const start = windowStart(since).getTime();
  let lines = [];
  try {
    lines = fs.readFileSync(shadowLog(cwd), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {}
  const days = new Map();
  for (const l of lines.filter((l) => Date.parse(l.at) >= start)) {
    const d = l.at.slice(0, 10);
    if (!days.has(d)) days.set(d, { day: d, count: 0, items: [] });
    const day = days.get(d);
    day.count++;
    day.items.push({ sha: l.sha, host: l.host, reasons: l.reasons });
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function audit({ cwd = process.cwd(), since = "72h", dryRun = false, shadowReport = false } = {}) {
  const cfg = cfgLib.load(cwd);
  if (!cfg) return { adopted: false, findings: [] };
  if (shadowReport) return { adopted: true, days: shadowDays(cwd, since) };
  g.git(["fetch", "-q", cfg.remote], cwd);
  const list = findings(cfg, cwd, since);
  const filed = file(list, dryRun);
  return { adopted: true, findings: list, filed };
}

function main(opts) {
  try {
    const r = audit(opts);
    if (!r.adopted) return console.log("catalina audit: no .catalina/config.json on the default branch; nothing to audit"), 0;
    if (r.days) {
      if (!r.days.length) console.log(`catalina audit: no would-block pushes in the last ${opts.since}`);
      for (const d of r.days) console.log(`${d.day}: ${d.count} would-block push(es)\n${d.items.map((i) => `  ${String(i.sha || "?").slice(0, 7)} on ${i.host}: ${i.reasons.join("; ")}`).join("\n")}`);
      return 0;
    }
    if (!r.findings.length) console.log(`catalina audit: every commit in the last ${opts.since} passed`);
    for (const f of r.findings) console.log(`${f.sha.slice(0, 7)} ${f.what}\n${f.reasons.map((x) => `  - ${x}`).join("\n")}`);
    if (!opts.dryRun && r.filed.length) console.log(`filed ${Math.min(r.filed.length, CAP)} issue(s)${r.filed.length > CAP ? " + a summary" : ""}`);
    return 0;
  } catch (e) {
    process.stderr.write(`catalina audit failed: ${e.message}\n`);
    return 1;
  }
}

module.exports = { audit, main, findings };
