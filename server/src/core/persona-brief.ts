/**
 * Persona brief: a token-lean view of a roster agent's .md persona for LOCAL runs.
 *
 * Roster personas are long (median ~13k chars, p90 ~25k) and most of the bulk is
 * deliverable templates, code samples and workflow checklists the agent only needs
 * for some tasks. Inlining all of it costs ~3k+ tokens on every run. Following the
 * "context pointer" lever from mattpocock/skills `writing-for-agents`, the brief
 * keeps the sections that shape EVERY run (identity, mission, critical rules,
 * communication style, success metrics) inline and replaces the rest with a pointer
 * naming the dropped sections, the absolute file path, and when to read it.
 *
 * Only for brains that can read this host's filesystem: remote clients build their
 * own prompt from context.persona (stampPersona) and keep the full text.
 */

/** Section headings (any `##` level-2 heading) kept inline in the brief. */
const KEEP = /identity|core mission|mission|critical rules|rules you must follow|communication style|success metrics|success criteria|when not to use/i;

/** Personas shorter than this are inlined whole: the pointer would not pay for itself. */
const MIN_CHARS = 4000;
/** Only brief when it saves at least this share of the persona. */
const MIN_SAVING = 0.25;

export interface PersonaBrief {
  text: string;
  /** Headings of the sections moved behind the pointer (empty = full persona returned). */
  dropped: string[];
}

export function briefPersona(persona: string, sourcePath: string | undefined): PersonaBrief {
  const full = { text: persona, dropped: [] as string[] };
  if (!sourcePath || persona.length < MIN_CHARS) return full;

  // Split on level-2 headings, ignoring `## ` lines inside fenced code blocks.
  const lines = persona.split('\n');
  const parts: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line)) parts.push({ heading: line.replace(/^## /, '').trim(), lines: [line] });
    else parts[parts.length - 1].lines.push(line);
  }
  if (parts.length < 3) return full;

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const p of parts) {
    if (p.heading === null || KEEP.test(p.heading)) kept.push(p.lines.join('\n').trimEnd());
    else dropped.push(p.heading);
  }
  if (dropped.length === 0) return full;

  const names = dropped.map(h => h.replace(/[^\p{L}\p{N}&/ -]/gu, '').trim()).filter(Boolean);
  const pointer = [
    `## More of this persona (not inlined, to save tokens)`,
    `Your full persona is at \`${sourcePath}\`. It also has: ${names.join('; ')}.`,
    `Read that file before you produce a deliverable that needs its templates, code patterns, or step-by-step workflow. Skip it when the task does not.`,
  ].join('\n');
  const text = `${kept.join('\n\n')}\n\n${pointer}`;
  if (text.length > persona.length * (1 - MIN_SAVING)) return full;
  return { text, dropped };
}
