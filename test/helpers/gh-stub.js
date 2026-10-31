#!/usr/bin/env node
// A fake `gh` for tests. State lives in the JSON file named by CATALINA_GH_STATE:
//   { pulls: { <commit sha>: [pr…] }, issues: [{title, body, labels}], labels: [] }
const fs = require("fs");
const file = process.env.CATALINA_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const val = (f) => args[args.indexOf(f) + 1];
const save = () => fs.writeFileSync(file, JSON.stringify(state));

if (args[0] === "api" && /contents\/\.catalina\/config\.json/.test(args[1])) {
  if (state.adopted === false) process.stderr.write("gh: Not Found (HTTP 404)\n"), process.exit(1);
  if (state.githubDown) process.stderr.write("gh: HTTP 502\n"), process.exit(1);
  process.stdout.write(JSON.stringify({ content: "e30=" }));
} else if (args[0] === "api") {
  const m = args[1].match(/commits\/([0-9a-f]+)\/pulls/);
  if (m && (state.unknownCommits || []).includes(m[1])) process.stderr.write(`gh: No commit found for SHA: ${m[1]} (HTTP 422)\n`), process.exit(1);
  if (m && state.githubDown) process.stderr.write("gh: HTTP 502\n"), process.exit(1);
  process.stdout.write(JSON.stringify(m ? state.pulls[m[1]] || [] : {}));
} else if (args[0] === "issue" && args[1] === "list") {
  const q = (val("--search") || "").replace(/ in:title$/, "");
  process.stdout.write(JSON.stringify(state.issues.filter((i) => i.title.includes(q)).map((i) => ({ title: i.title }))));
} else if (args[0] === "issue" && args[1] === "create") {
  state.issues.push({ title: val("--title"), body: val("--body"), labels: [val("--label")] });
  save();
  process.stdout.write(`https://github.com/o/r/issues/${state.issues.length}\n`);
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: args[2] && !args[2].startsWith("-") ? args[2] : "o/r", url: state.remote }));
} else if (args[0] === "pr" && args[1] === "view") {
  const pr = (state.prs || {})[args[2]];
  if (!pr) process.exit(1);
  process.stdout.write(JSON.stringify(pr));
} else if (args[0] === "pr" && args[1] === "merge") {
  state.merged = [...(state.merged || []), args[2]];
  save();
} else if (args[0] === "label") {
  state.labels = [...new Set([...(state.labels || []), args[2]])];
  save();
} else {
  process.stderr.write(`gh-stub: unsupported ${args.join(" ")}\n`);
  process.exit(1);
}
