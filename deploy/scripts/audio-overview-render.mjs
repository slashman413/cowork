#!/usr/bin/env node
/**
 * Audio Overview renderer: script.md -> one mp3 (edge-tts per segment, ffmpeg concat).
 *
 *   node audio-overview-render.mjs <script.md> <out.mp3> [--lang zh-TW|en]
 *
 * script.md: single narrator = plain paragraphs (optionally "NARRATOR: ..."), dialogue =
 * one turn per line tagged "HOST_A: ..." / "HOST_B: ...". "#" headings, blank lines and
 * HTML comments are ignored. --lang defaults to a "LANG: en" line in the script, else zh-TW.
 *
 * NOTE: edge-tts sends the text to Microsoft's online TTS service.
 * The parsing helpers are exported (and unit-tested by core/audio-overview.test.ts).
 * Env overrides: EDGE_TTS, FFMPEG (default: resolve via PATH).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VOICES = {
  'zh-TW': { A: 'zh-TW-HsiaoChenNeural', B: 'zh-TW-YunJheNeural' },
  en: { A: 'en-US-AriaNeural', B: 'en-US-GuyNeural' },
};
const MAX_SEG = 400;

export function voiceFor(lang, speaker) {
  const v = VOICES[lang] || VOICES['zh-TW'];
  return speaker === 'B' ? v.B : v.A;
}

/** Split long text at sentence ends so each TTS call stays short. */
export function splitText(text, max = MAX_SEG) {
  const sentences = text.match(/[^。！？!?.；;\n]+[。！？!?.；;]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > max) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** script.md -> [{speaker:'A'|'B', text}] */
export function parseScript(md) {
  const segs = [];
  const clean = md.replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of clean.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || /^(-{3,}|\*{3,}|LANG:|STYLE:)/i.test(line)) continue;
    let speaker = 'A';
    const m = line.match(/^\**\s*(HOST[_ ]?([AB])|NARRATOR)\s*\**\s*[:：]\s*\**\s*(.*)$/i);
    if (m) { speaker = m[2] ? m[2].toUpperCase() : 'A'; line = m[3]; }
    line = line.replace(/^[-*>]\s+/, '').replace(/[*_`]+/g, '').trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    for (const t of splitText(line)) segs.push({ speaker, text: t });
  }
  return segs;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${(r.stderr || r.error?.message || '').slice(-400)}`);
}

function main() {
  const argv = process.argv.slice(2);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (pos.length < 2) { console.error('usage: audio-overview-render.mjs <script.md> <out.mp3> [--lang zh-TW|en]'); process.exit(2); }
  const [scriptPath, outPath] = pos;
  const md = fs.readFileSync(scriptPath, 'utf-8');
  const lang = opt('lang') || (md.match(/^LANG:\s*(\S+)/im) || [])[1] || 'zh-TW';
  const segs = parseScript(md);
  if (!segs.length) { console.error('no speakable segments in script'); process.exit(1); }
  const edge = process.env.EDGE_TTS || 'edge-tts';
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-overview-'));
  try {
    const list = [];
    segs.forEach((s, i) => {
      const txt = path.join(tmp, `seg-${i}.txt`), mp3 = path.join(tmp, `seg-${i}.mp3`);
      fs.writeFileSync(txt, s.text);
      run(edge, ['--voice', voiceFor(lang, s.speaker), '--file', txt, '--write-media', mp3]);
      list.push(`file '${mp3.replace(/'/g, "'\\''")}'`);
      console.error(`[${i + 1}/${segs.length}] ${s.speaker}: ${s.text.slice(0, 40)}`);
    });
    fs.writeFileSync(path.join(tmp, 'list.txt'), list.join('\n'));
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'),
      '-c:a', 'libmp3lame', '-q:a', '4', '-ar', '24000', '-ac', '1', outPath]);
    console.log(`wrote ${outPath} (${segs.length} segments, lang ${lang})`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
