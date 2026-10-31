/**
 * Catalina — `catalina doctor`: find copies of package files that have drifted.
 *
 * install.sh links hooks, commands and reference docs to this checkout, so an update is
 * one `git pull`. A real copy (an old install, a builder kit, a hand edit) silently stays
 * on old rules: that is how a project kept a /spec without the premortem for months.
 * Checked: ~/.claude/hooks, ~/.claude/commands, the current project's .claude/commands and
 * .claude/reference, and any --also <dir> (matched by file name, with lib/ for hooks/lib).
 * A project copy also shadows a user-level command of the same name, so it is listed too.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const g = require("./git");

const PKG = path.resolve(__dirname, "..");

function packageFiles() {
  const list = (dir, filter) =>
    fs.existsSync(path.join(PKG, dir)) ? fs.readdirSync(path.join(PKG, dir)).filter(filter).map((f) => path.join(dir, f)) : [];
  return {
    hooks: [...list("hooks", (f) => f.endsWith(".js")), ...list("hooks/lib", (f) => f.endsWith(".js"))],
    commands: list("commands", (f) => f.endsWith(".md")),
    reference: list("reference", (f) => f.endsWith(".md")),
  };
}

function status(target, source) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return null; // not installed there
  }
  if (st.isSymbolicLink()) {
    const real = fs.realpathSync(target);
    return real === fs.realpathSync(source) ? "link" : `links elsewhere (${real})`;
  }
  return fs.readFileSync(target).equals(fs.readFileSync(source)) ? "identical" : "differs";
}

function doctor({ cwd = process.cwd(), also = [], home = os.homedir() } = {}) {
  const files = packageFiles();
  const pairs = [];
  const hooksHome = path.join(home, ".claude", "hooks");
  for (const f of files.hooks) pairs.push([path.join(hooksHome, path.relative("hooks", f)), f]);
  for (const f of files.commands) pairs.push([path.join(home, ".claude", f), f]);
  const project = g.tryGit(["rev-parse", "--show-toplevel"], cwd)?.trim();
  if (project) for (const f of [...files.commands, ...files.reference]) pairs.push([path.join(project, ".claude", f), f]);
  for (const dir of also) for (const f of files.hooks) pairs.push([path.join(path.resolve(cwd, dir), path.relative("hooks", f)), f]);
  const rows = [];
  for (const [target, rel] of pairs) {
    const s = status(target, path.join(PKG, rel));
    if (s) rows.push({ target, rel, status: s });
  }
  return rows;
}

function main(opts) {
  const rows = doctor(opts);
  const bad = rows.filter((r) => r.status !== "link" && r.status !== "identical");
  for (const r of bad) console.log(`${r.target}: ${r.status} from ${r.rel} — relink with install.sh (move project rules to .claude/catalina/<command>.local.md)`);
  console.log(bad.length ? `catalina doctor: ${bad.length} drifted file(s)` : `catalina doctor: ${rows.length} installed file(s), all linked or identical`);
  return bad.length ? 1 : 0;
}

module.exports = { doctor, main };
