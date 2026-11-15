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

/** The written form of a premortem item, for messages. */
const PREMORTEM_FORMAT = (id = "P1") => `- **${id} Scenario** — early sign: …; mitigation: …`;

/**
 * Premortem items: `- **P1 Scenario** — …`. The bold must open with the ID; any separator may follow it (#27).
 * unread: top-level `- ` lines that open with a P-ID but aren't items (no bold, an unclosed bold); [] when Trivial.
 */
function premortem(text) {
  const body = section(text, "Premortem");
  if (body === null) return { present: false, trivial: false, ids: [], unread: [] };
  const trivial = /^_?Trivial:\s*\S/m.test(body);
  const ids = [];
  const starts = new Set();
  // The bold may wrap onto the next lines, but never past a blank line or the next item.
  for (const m of body.matchAll(/^- \*\*(P\d+)\b(?:(?!\n- |\n[ \t]*\n)[\s\S])*?\*\*/gm)) {
    ids.push(m[1]);
    starts.add(m.index);
  }
  const unread = [...body.matchAll(/^- (?:\*\*)?P\d+\b.*$/gm)].filter((m) => !starts.has(m.index)).map((m) => m[0].trim());
  return { present: true, trivial, ids, unread: trivial ? [] : unread };
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

module.exports = { sections, section, premortem, PREMORTEM_FORMAT, filled, escalations, redBase };
