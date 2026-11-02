/** Catalina — parse the sections of a tracking.md that `catalina check` reads. */

function sections(text) {
  const out = {};
  const parts = String(text).split(/^## +/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const head = (nl === -1 ? p : p.slice(0, nl)).trim().toLowerCase();
    out[head] = nl === -1 ? "" : p.slice(nl + 1).trim();
  }
  return out;
}

/** The body of the section headed `name` (case-insensitive; `name (…)` also counts), or null. */
function section(text, name) {
  const s = sections(text);
  const want = name.toLowerCase();
  // An exact heading wins, so "Lessons" never reads "Lessons applied".
  const key = want in s ? want : Object.keys(s).find((k) => k.startsWith(`${want} (`) || k.startsWith(`${want} —`) || k.startsWith(`${want}:`));
  return key === undefined ? null : s[key];
}

/** Premortem items: `- **P1 Scenario** — …` (accepts —, -- or -). */
function premortem(text) {
  const body = section(text, "Premortem");
  if (body === null) return { present: false, trivial: false, ids: [] };
  const trivial = /^_?Trivial:\s*\S/m.test(body);
  const ids = [...body.matchAll(/^- \*\*(P\d+)\b[^*]*\*\*\s*(?:—|--|-)/gm)].map((m) => m[1]);
  return { present: true, trivial, ids };
}

/** True when a section has real content, not just a `_(pending…)_` placeholder. */
function filled(body) {
  if (body === null) return false;
  const stripped = body.replace(/^_\((?:pending|todo)[^)]*\)_\s*$/gim, "").trim();
  return stripped.length > 0;
}

/** The sha on a `Red base: <sha>` line (a record written after its fix merged), or null. */
function redBase(text) {
  const m = String(text).match(/^Red base:\s*`?([0-9a-f]{7,40})\b/im);
  return m ? m[1] : null;
}

function escalations(text) {
  const body = section(text, "Review History") || "";
  return (body.match(/^- ESCALATED:/gm) || []).length;
}

module.exports = { sections, section, premortem, filled, escalations, redBase };
