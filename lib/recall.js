/**
 * Catalina — `catalina recall`: the lessons past issues left for this one.
 *
 * Tracking files are the memory. After ship, the retro writes a `## Lessons` block into
 * the issue's tracking.md; /spec runs this over the files it is about to change (and the
 * epic) and pastes the result into `## Lessons applied`.
 * An issue matches when its Design Notes name one of the paths (or a directory holding
 * it), when its own commits touched one, or when it shares the epic.
 */
const fs = require("fs");
const path = require("path");
const g = require("./git");
const t = require("./tracking");

const near = (a, b) => a === b || a.startsWith(b.replace(/\/?$/, "/")) || b.startsWith(a.replace(/\/?$/, "/"));

function recall({ cwd = process.cwd(), paths = [], epic } = {}) {
  const root = g.topLevel(cwd);
  const dir = path.join(root, ".claude", "tracking");
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((d) => /^issue-\d+$/.test(d));
  } catch {}
  const hits = [];
  for (const d of entries) {
    const n = Number(d.slice(6));
    let text;
    try {
      text = fs.readFileSync(path.join(dir, d, "tracking.md"), "utf8");
    } catch {
      continue;
    }
    const lessons = t.section(text, "Lessons");
    if (!t.filled(lessons)) continue;
    const named = [...(t.section(text, "Design Notes") || "").matchAll(/`([^`\s]+[/.][^`\s]*)`/g)].map((m) => m[1]);
    const touched = (g.tryGit(["log", "--format=", "--name-only", "-E", `--grep=#${n}([^0-9]|$)`, "HEAD"], root) || "").split("\n").filter(Boolean);
    const byPath = paths.some((p) => [...named, ...touched].some((f) => near(p, f)));
    const byEpic = epic && new RegExp(`^Epic: #${String(epic).replace("#", "")}\\b`, "m").test(text);
    if (byPath || byEpic) hits.push({ issue: n, title: (text.match(/^# (.+)$/m) || [, `#${n}`])[1], lessons });
  }
  return hits.sort((a, b) => b.issue - a.issue);
}

function main(opts) {
  const hits = recall(opts);
  if (!hits.length) console.log("None found");
  for (const h of hits) console.log(`### ${h.title}\n${h.lessons}\n`);
  return 0;
}

module.exports = { recall, main };
