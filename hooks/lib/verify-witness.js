#!/usr/bin/env node
/**
 * Catalina ILR — witness evidence validator (shared module).
 *
 * The single source of truth for "is issue N's verification.jsonl complete enough
 * to sit in `review`?" Used by BOTH:
 *   - hooks/witness-gate.js   (PreToolUse defense-in-depth on the gh Bash path)
 *   - /groom                  (state sweep over every `review` issue — the real guarantee)
 *
 * Rules (see .claude/tracking/issue-2/tracking.md):
 *   a. every AC in tracking.md has a matching verification.jsonl line
 *   b. no line has result:"pass" with method:"none"
 *   c. every OBSERVABLE ac is method visual|both AND has an artifact that exists,
 *      is >1KB, and is not byte-identical to another observable ac's artifact
 *   d. no premortem line has outcome:"occurred"
 *   e. needs_human lines must name a human action (non-empty evidence); they do NOT
 *      block reaching `review` (that's where the human looks) but are counted so the
 *      auto-router (#3) won't auto-ship past them
 *
 * observable defaults to TRUE. observable:false requires a non-empty justification,
 * and is rejected outright if the AC text reads like UI work (keyword heuristic) —
 * so "mark it non-observable" can't become the new escape hatch.
 *
 * CLI:  node verify-witness.js <issueNumber> [repoRoot]   → prints reasons, exit 0 ok / 1 fail
 * API:  require('./verify-witness').verifyWitness(n, {repoRoot}) → {ok, reasons, needsHuman}
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UI_KEYWORDS =
  /\b(render|renders|page|screen|button|click|visible|visual|browser|UI|toast|modal|scroll|viewport|layout|css|style|mobile)\b/i;

function verifyWitness(issueNumber, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const reasons = [];
  const dir = path.join(repoRoot, ".claude", "tracking", `issue-${issueNumber}`);
  const trackingPath = path.join(dir, "tracking.md");
  const jsonlPath = path.join(dir, "verification.jsonl");

  if (!fs.existsSync(trackingPath)) {
    return { ok: false, reasons: [`tracking.md missing for issue ${issueNumber}`], needsHuman: 0 };
  }
  if (!fs.existsSync(jsonlPath)) {
    return { ok: false, reasons: [`verification.jsonl missing for issue ${issueNumber} — nothing was witnessed`], needsHuman: 0 };
  }

  const tracking = fs.readFileSync(trackingPath, "utf8");
  const acIds = [];
  for (const m of tracking.matchAll(/^- \[[ xX]\] (AC\d+)\b[:.]?\s*(.*)$/gm)) {
    acIds.push({ id: m[1], text: m[2] || "" });
  }
  if (acIds.length === 0) {
    reasons.push("no AC found in tracking.md (expected lines like '- [ ] AC1: ...')");
  }

  // Parse jsonl
  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const acLines = [];
  const premortemLines = [];
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      reasons.push(`verification.jsonl line ${i + 1} is not valid JSON`);
      continue;
    }
    if (obj.premortem !== undefined) premortemLines.push(obj);
    else acLines.push(obj);
  }

  const tokenOf = (s) => {
    const m = String(s || "").match(/AC\d+/);
    return m ? m[0] : null;
  };
  const lineByAc = {};
  for (const l of acLines) {
    const t = tokenOf(l.ac);
    if (t && !lineByAc[t]) lineByAc[t] = l;
  }

  // Rule a — coverage
  for (const { id } of acIds) {
    if (!lineByAc[id]) reasons.push(`${id} has no verification.jsonl line (rule a)`);
  }

  // Rules b, c, e — per AC line
  const artifactHashes = {}; // hash -> acId, for anti-fakery
  const textById = Object.fromEntries(acIds.map((a) => [a.id, a.text]));
  let needsHuman = 0;

  for (const l of acLines) {
    const id = tokenOf(l.ac) || l.ac || "?";
    const result = l.result;
    const method = l.method;

    if (result === "pass" && method === "none") {
      reasons.push(`${id}: result "pass" with method "none" is not evidence (rule b)`);
    }
    if (result === "needs_human") {
      if (!l.evidence || !String(l.evidence).trim()) {
        reasons.push(`${id}: needs_human must name what a human must do + why (rule e)`);
      } else {
        needsHuman++;
      }
    }

    // observable defaults true
    const explicitlyFalse = l.observable === false;
    const acText = textById[id] || String(l.ac || "");
    if (explicitlyFalse) {
      if (!l.observable_reason || !String(l.observable_reason).trim()) {
        reasons.push(`${id}: observable:false requires a non-empty "observable_reason" (rule c)`);
      }
      if (UI_KEYWORDS.test(acText)) {
        reasons.push(`${id}: marked observable:false but the AC text reads like UI work — reclassify or justify to the reviewer (rule c heuristic)`);
      }
      continue; // non-observable → no artifact required
    }

    // observable (default) — only enforce artifact when the AC is meant to pass
    if (result === "fail") continue; // failing AC blocks the flip elsewhere; no artifact demanded
    if (result === "needs_human") continue;

    if (method !== "visual" && method !== "both") {
      reasons.push(`${id}: observable AC must be witnessed visual|both, got method "${method}" (rule c)`);
    }
    const artifact = l.artifact;
    if (!artifact) {
      reasons.push(`${id}: observable AC has no "artifact" path — no artifact, no pass (rule c)`);
    } else {
      const ap = path.isAbsolute(artifact) ? artifact : path.join(repoRoot, artifact);
      if (!fs.existsSync(ap)) {
        reasons.push(`${id}: artifact "${artifact}" does not exist on disk (rule c)`);
      } else {
        const stat = fs.statSync(ap);
        if (stat.size <= 1024) {
          reasons.push(`${id}: artifact "${artifact}" is ${stat.size}B (<=1KB) — looks empty/placeholder (rule c)`);
        } else {
          const hash = crypto.createHash("sha1").update(fs.readFileSync(ap)).digest("hex");
          if (artifactHashes[hash]) {
            reasons.push(`${id}: artifact is byte-identical to ${artifactHashes[hash]}'s — same file reused as evidence (rule c)`);
          } else {
            artifactHashes[hash] = id;
          }
        }
      }
    }
  }

  // Rule d — premortem occurred
  for (const p of premortemLines) {
    if (p.outcome === "occurred") {
      reasons.push(`premortem "${p.premortem}" outcome=occurred — witnessing fails regardless of AC pass-rate (rule d)`);
    }
  }

  // Any AC explicitly failed → not ready for review
  for (const l of acLines) {
    if (l.result === "fail") {
      reasons.push(`${tokenOf(l.ac) || l.ac}: result "fail" — not ready for review`);
    }
  }

  return { ok: reasons.length === 0, reasons, needsHuman };
}

module.exports = { verifyWitness };

// CLI entry
if (require.main === module) {
  const n = process.argv[2];
  const repoRoot = process.argv[3] || process.cwd();
  if (!n) {
    process.stderr.write("usage: verify-witness.js <issueNumber> [repoRoot]\n");
    process.exit(2);
  }
  const { ok, reasons, needsHuman } = verifyWitness(n, { repoRoot });
  if (ok) {
    process.stdout.write(`issue ${n}: witness evidence VALID${needsHuman ? ` (${needsHuman} needs_human — human must confirm before ship)` : ""}\n`);
    process.exit(0);
  } else {
    process.stdout.write(`issue ${n}: witness evidence INVALID\n` + reasons.map((r) => `  - ${r}`).join("\n") + "\n");
    process.exit(1);
  }
}
