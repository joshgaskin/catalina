/**
 * #27: a worktree whose node_modules is a relative symlink. `red_setup`'s `cp -al` copies the link as is, so in the
 * red checkout (under the system temp dir) it points nowhere and every test fails to load.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeRepo, buildIssue } = require("./helpers/repo");
const { check } = require("../lib/check");
const { repairNodeModules } = require("../lib/red");

const PKG_TEST =
  "const test = require('node:test');\nconst assert = require('node:assert');\nconst two = require('fixture-pkg');\nconst add = require('../src/add');\ntest('adds', () => assert.strictEqual(add(two, 3), 5));\n";

function linkedRepo(n) {
  const repo = makeRepo({ config: { red_setup: 'cp -al "$CATALINA_ROOT/node_modules" node_modules' } });
  const { tip } = buildIssue(repo, n, { testText: PKG_TEST });
  const pkg = path.join(repo.tmp, "store", "node_modules", "fixture-pkg");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = 2;\n");
  fs.symlinkSync(path.join("..", "store", "node_modules"), path.join(repo.cwd, "node_modules")); // untracked, relative
  return { repo, tip };
}

test("#27 AC7: a relative node_modules link copied by red_setup is repaired, so the red proof runs", () => {
  const { repo, tip } = linkedRepo(180);
  const r = check(180, { cwd: repo.cwd, source: "commit", red: "run", sha: tip });
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.ok, true);
});

test("#27 AC7: only a dangling link is replaced, and only by a root link that resolves", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalina-nm-"));
  const store = path.join(tmp, "store");
  fs.mkdirSync(store);
  const root = path.join(tmp, "root");
  const red = path.join(tmp, "red");
  fs.mkdirSync(root);
  fs.mkdirSync(red);
  fs.symlinkSync("../store", path.join(root, "node_modules"));

  fs.symlinkSync("../store", path.join(red, "node_modules")); // resolves from red too
  repairNodeModules(red, root);
  assert.strictEqual(fs.readlinkSync(path.join(red, "node_modules")), "../store", "a link that resolves is left alone");

  fs.unlinkSync(path.join(red, "node_modules"));
  fs.symlinkSync("../../nowhere", path.join(red, "node_modules"));
  repairNodeModules(red, root);
  assert.strictEqual(fs.readlinkSync(path.join(red, "node_modules")), fs.realpathSync(store));

  fs.unlinkSync(path.join(root, "node_modules"));
  fs.symlinkSync("../gone", path.join(root, "node_modules"));
  fs.unlinkSync(path.join(red, "node_modules"));
  fs.symlinkSync("../../nowhere", path.join(red, "node_modules"));
  repairNodeModules(red, root);
  assert.strictEqual(fs.readlinkSync(path.join(red, "node_modules")), "../../nowhere", "a dangling root is not papered over");
});
