import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ShotcraftConfig, WorkflowDef } from '../types.js';

/**
 * Shotcraft — the server side of /shotcraft.html, a shortcut for the
 * video-shotcraft agent skill (https://github.com/Vincentwei1021/video-shotcraft,
 * a plain git clone at ~/.agents/skills/video-shotcraft, symlinked into
 * ~/.claude/skills and ~/.codex/skills).
 *
 * The skill makes Remotion product videos from 124 tuned "shot recipe cards".
 * This module only
 *  (a) exposes the card index (gallery/api/library.json) + the bundled BGM so
 *      the page can offer a shot picker and a music picker, and
 *  (b) turns the page's form into ONE brief, then wraps it as whichever cowork
 *      object the requester picked: a task, a recurring task, a goal, or a
 *      saved workflow template.
 *
 * READ-ONLY on the skill dir: nothing here writes into it. BGM reads are
 * path-guarded (basename + extension + must be listed) like the artifacts route.
 */

export const SHOTCRAFT_TAG = 'video-shotcraft';
export const GALLERY_URL = 'https://vincentwei1021.github.io/video-shotcraft/';

export const DEFAULT_SHOTCRAFT: Required<ShotcraftConfig> = {
  skillDir: '~/.agents/skills/video-shotcraft',
  defaultBrain: 'local-cc-opus-5-5',
  brains: ['local-cc-opus-5-5', 'local-cc-sonnet-5-5'],
};

export type ShotcraftMode = 'auto' | 'guided' | 'template' | 'shot' | 'ask';
export type ShotcraftKind = 'task' | 'recurring' | 'goal' | 'workflow';

export interface ShotcraftBrief {
  mode: ShotcraftMode;
  product: string;
  message: string;
  source?: string;
  shots: string[];
  aspect: '16:9' | '9:16' | '1:1' | '4:5';
  seconds: number;
  language: 'match' | 'en' | 'zh-TW' | 'zh-CN';
  /** 'auto' | 'none' | 'attached' | a file name under assets/audio/bgm/. */
  music: string;
  jianying: boolean;
  /** Guided/ask modes: let the orchestrator answer checkpoints as the CEO's delegate. */
  autoAnswer: boolean;
  brain: string;
  notes?: string;
}

export interface ShotCard {
  name: string;
  category: string;
  summary: string;
  use: string;
  duration: string;
  energy: string;
  styles: { key: string; label: string; preview?: string }[];
}

export const ASPECTS: Record<ShotcraftBrief['aspect'], { w: number; h: number }> = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
};
export const LENGTHS = [15, 20, 30, 45, 60, 90];
const MODES: ShotcraftMode[] = ['auto', 'guided', 'template', 'shot', 'ask'];
const LANGS: ShotcraftBrief['language'][] = ['match', 'en', 'zh-TW', 'zh-CN'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const BGM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.mp3$/;

const expand = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function resolveShotcraftConfig(cfg?: ShotcraftConfig): Required<ShotcraftConfig> {
  const merged = { ...DEFAULT_SHOTCRAFT, ...(cfg || {}) };
  return {
    ...merged,
    skillDir: expand(merged.skillDir),
    brains: Array.isArray(merged.brains) && merged.brains.length ? merged.brains : DEFAULT_SHOTCRAFT.brains,
  };
}

export class Shotcraft {
  private cache: { mtime: number; cards: ShotCard[]; categories: Record<string, { zh: string; en: string }> } | null = null;
  readonly cfg: Required<ShotcraftConfig>;

  constructor(cfg?: ShotcraftConfig) { this.cfg = resolveShotcraftConfig(cfg); }

  private get libraryFile() { return path.join(this.cfg.skillDir, 'gallery', 'api', 'library.json'); }
  private get bgmDir() { return path.join(this.cfg.skillDir, 'assets', 'audio', 'bgm'); }

  available(): boolean { return fs.existsSync(path.join(this.cfg.skillDir, 'SKILL.md')) && fs.existsSync(this.libraryFile); }

  /** Skill version (short HEAD) for the page footer; '' when not a git clone. */
  version(): string {
    try {
      const head = fs.readFileSync(path.join(this.cfg.skillDir, '.git', 'HEAD'), 'utf-8').trim();
      const sha = head.startsWith('ref:')
        ? fs.readFileSync(path.join(this.cfg.skillDir, '.git', head.slice(5).trim()), 'utf-8').trim()
        : head;
      return sha.slice(0, 7);
    } catch { return ''; }
  }

  /** The Gallery card index, cached on library.json's mtime. Previews point at
   *  the public Gallery (the mp4s are not in git). */
  catalog(): { cards: ShotCard[]; categories: Record<string, { zh: string; en: string }> } {
    let mtime = 0;
    try { mtime = fs.statSync(this.libraryFile).mtimeMs; } catch { return { cards: [], categories: {} }; }
    if (this.cache?.mtime === mtime) return this.cache;
    let lib: any = null;
    try { lib = JSON.parse(fs.readFileSync(this.libraryFile, 'utf-8')); } catch { /* bad file → empty */ }
    const cards: ShotCard[] = [];
    for (const c of Array.isArray(lib?.cards) ? lib.cards : []) {
      if (!c || !NAME_RE.test(str(c.name))) continue;
      cards.push({
        name: c.name, category: str(c.category) || 'other', summary: str(c.summary), use: str(c.use),
        duration: str(c.duration), energy: str(c.energy),
        styles: (Array.isArray(c.styles) ? c.styles : [])
          .filter((s: any) => s && NAME_RE.test(str(s.key)))
          .map((s: any) => {
            const url = str(s.media?.url);
            return {
              key: s.key, label: str(s.label) || s.key,
              ...(url.startsWith('./media/') ? { preview: GALLERY_URL + url.slice(2) } : {}),
            };
          }),
      });
    }
    const categories: Record<string, { zh: string; en: string }> = {};
    for (const [k, v] of Object.entries(lib?.categories || {})) {
      const o = v as any;
      if (NAME_RE.test(k)) categories[k] = { zh: str(o?.zh) || k, en: str(o?.en) || k };
    }
    this.cache = { mtime, cards, categories };
    return this.cache;
  }

  /** BGM tracks bundled with the skill (assets/audio/bgm/*.mp3). */
  bgm(): string[] {
    try { return fs.readdirSync(this.bgmDir).filter(f => BGM_RE.test(f)).sort(); } catch { return []; }
  }

  /** Absolute path of a bundled BGM track, or null. Never resolves outside bgm/. */
  bgmFile(name: string): string | null {
    const f = path.basename(name);
    return f === name && this.bgm().includes(f) ? path.join(this.bgmDir, f) : null;
  }

  /** Validate a "card" or "card · style" reference against the index. */
  private shotRef(ref: string): string | null {
    const [cardName, styleKey] = ref.split('·').map(s => s.trim());
    const card = this.catalog().cards.find(c => c.name === cardName);
    if (!card) return null;
    if (!styleKey) return card.name;
    return card.styles.some(s => s.key === styleKey) ? `${card.name} · ${styleKey}` : null;
  }

  /** Validate + normalise the page's form. Throws with a user-facing message. */
  parseBrief(body: any): ShotcraftBrief {
    const b = body || {};
    const mode: ShotcraftMode = MODES.includes(b.mode) ? b.mode : 'auto';
    const product = str(b.product).trim().slice(0, 120);
    if (product.length < 2) throw new Error('product name is required');
    const message = str(b.message).trim();
    if (message.length < 3) throw new Error('describe what the video should say');
    if (message.length > 4000) throw new Error('message is too long (max 4000 characters)');

    const shots: string[] = [];
    for (const raw of Array.isArray(b.shots) ? b.shots.slice(0, 24) : []) {
      const ref = this.shotRef(str(raw));
      if (!ref) throw new Error(`unknown shot card: ${str(raw).slice(0, 80)}`);
      if (!shots.includes(ref)) shots.push(ref);
    }
    if (mode === 'shot' && !shots.length) throw new Error('single-shot mode needs at least one shot card');

    const tracks = this.bgm();
    const music = ['auto', 'none', 'attached'].includes(b.music) || tracks.includes(b.music) ? b.music : 'auto';
    const template = mode === 'template';
    return {
      mode, product, message, shots,
      source: str(b.source).trim().slice(0, 500) || undefined,
      aspect: template ? '16:9' : (Object.keys(ASPECTS) as ShotcraftBrief['aspect'][]).includes(b.aspect) ? b.aspect : '16:9',
      seconds: template ? 36 : LENGTHS.includes(Number(b.seconds)) ? Number(b.seconds) : 30,
      language: LANGS.includes(b.language) ? b.language : 'match',
      music,
      jianying: b.jianying === true,
      autoAnswer: b.autoAnswer === true,
      brain: this.cfg.brains.includes(b.brain) ? b.brain : this.cfg.defaultBrain,
      notes: str(b.notes).trim().slice(0, 2000) || undefined,
    };
  }

  /** The brief body every kind shares. `inputNames` = files attached to the task. */
  briefText(brief: ShotcraftBrief, inputNames: string[] = []): string {
    const dir = this.cfg.skillDir;
    const { w, h } = ASPECTS[brief.aspect];
    const source = brief.source?.startsWith('{{')
      ? `${brief.source} — a URL/path: capture real pages from it (skill rule 1) without modifying the product project; "none": work from the message and any attached files`
      : brief.source
      ? `${brief.source} — capture real pages from it (skill rule 1); never modify the product project itself, and stop any dev server you start`
      : inputNames.length ? 'the attached files (screenshots / recordings / docs)' : 'none given — work from the message; hand-built UI only under the skill\'s rule 1 quality bar';
    const lang = {
      match: 'match the product\'s own UI language',
      en: 'English',
      'zh-TW': 'Traditional Chinese (繁體中文, Taiwan wording)',
      'zh-CN': 'Simplified Chinese (简体中文)',
    }[brief.language];
    const music = brief.music === 'none' ? 'no BGM — SFX only (references/sound-design.md)'
      : brief.music === 'attached' ? 'the attached audio file is the BGM — beat-analyse it first (references/music-beat-sync.md) and cut to the beat'
      : brief.music === 'auto' ? `your choice: one of ${dir}/assets/audio/bgm/ beat-synced (references/music-beat-sync.md), or SFX-only if the film reads better without`
      : `${dir}/assets/audio/bgm/${brief.music} — beat-analyse it first (references/music-beat-sync.md) and cut to the beat`;
    const output = brief.mode === 'template'
      ? '1920×1080, 30 fps, ~36 s — the Ink Press template\'s own spec'
      : brief.mode === 'shot'
        ? `${w}×${h}, 30 fps, each shot at its card's own duration`
        : `${w}×${h}, 30 fps, ${brief.seconds} s (±10%)`;

    const modeRule: Record<ShotcraftMode, string> = {
      auto: 'Mode is already chosen: **autonomous free creation (自主自由创作)** — read references/pipeline.md and carry stages 0–7 straight through. Do not stop for confirmation at any stage; record your key decisions in STORYBOARD.md instead.',
      template: 'Mode is already chosen: **Ink Press template** — read template/TEMPLATE.md in full and follow its re-skin guide shot by shot. Do not ask which mode.',
      guided: [
        'Mode is already chosen: **guided co-creation (共同创作)** — read references/guided-free-creation.md. Each of its confirmation checkpoints (product brief, decisions, visual direction / styleframe, shot mapping, final storyboard) is a STOP:',
        '  write what the requester must look at to the artifacts root (e.g. `brief.md`, `styleframe-1.png`, `storyboard.md`), then end your output with a line `NEEDS_INPUT:` followed by your 1–3 questions, one per line.',
        '  When this task is resumed, continue from the reply — do not redo earlier stages. If the reply says "you decide" / "skip confirmations", switch to autonomous mode as the skill describes.',
      ].join('\n'),
      shot: 'Mode is already chosen: **single shot (用法 4)** — make only the shot card(s) listed above, adapted to this product. No full-film storyboard, no mode question.',
      ask: 'Mode is NOT chosen yet: do the skill\'s minimal read-only product check, write `MODE-RECOMMENDATION.md` (Ink Press fit, autonomous vs guided, your pick and why), then STOP with `NEEDS_INPUT:` asking which mode to use. When resumed, continue in the chosen mode (guided checkpoints also stop with `NEEDS_INPUT:`).',
    };

    const deliver = brief.mode === 'shot'
      ? ['- `film.mp4` — all requested shots, rendered back-to-back (also `shot-<card>.mp4` per shot when there is more than one)']
      : [
          '- `film.mp4` — the final film',
          '- `film-nobgm.mp4` — same timeline, SFX only (when the film has BGM; the `bgm` inputProp, skill rule 5)',
          '- `STORYBOARD.md` — the final storyboard: shot order, card · style, frames, copy, SFX',
        ];

    return [
      `Use the **video-shotcraft skill** (\`/video-shotcraft\`, installed at ${dir}). Read its SKILL.md first and follow it; the points below answer its questions and adapt it to a headless cowork run.`,
      '',
      '## The request',
      brief.message.split('\n').map(l => `> ${l}`).join('\n'),
      '',
      `- Product: ${brief.product}`,
      `- Source: ${source}`,
      `- Shot cards: ${brief.shots.length
        ? brief.shots.join(', ') + ' — resolve them in gallery/api/library.json, read each card in full and its exact demo TSX (skill rule 6). These are constraints, not the whole storyboard.'
        : 'your choice from references/shots/ (scan the frontmatter, pick by energy curve)'}`,
      `- Output: ${output}`,
      `- On-screen text language: ${lang}`,
      `- Music: ${music}`,
      `- Attached inputs: ${inputNames.length ? inputNames.join(', ') + ' (listed in your prompt)' : 'none'}`,
      ...(brief.jianying ? ['- Also export a JianYing (剪映) draft per references/jianying-export.md, zipped as `jianying-draft.zip` (needs a venv + `pip install pyJianYingDraft`; if it cannot be produced here, say why instead).'] : []),
      ...(brief.notes ? [`- Extra notes from the requester: ${brief.notes}`] : []),
      '',
      '## Mode',
      modeRule[brief.mode],
      '',
      '## Running on this host (overrides the skill where they conflict)',
      '- Work in ./project/ (relative to your working dir = $COWORK_ARTIFACTS_DIR). Copy what you need out of the skill dir; never write into it.',
      '- Captures: headless Chromium (/usr/bin/chromium-browser or Remotion\'s own headless shell). No real customer/personal data or secrets on screen (skill rule 1).',
      '- This host shares unified memory with local LLMs: render with `--concurrency=4` and only one full render at a time.',
      '- The independent final review is mandatory (skill rule 8): run it as a clean-context subagent with references/final-review.md, save its report as `REVIEW.md`, fix blocking issues and re-render before you deliver.',
      '- Delivery tail: do NOT start the Motion Workbench (no display here) and do NOT publish anywhere. Skip the closing 1-2-3 asks (author credit / showcase / JianYing) — the requester has read them.',
      '- COPY the deliverables to the artifacts ROOT with exactly these names (the task card lists top-level files only):',
      ...deliver,
      '- `poster.jpg` — one strong frame',
      '- `contact.jpg` — contact sheet of ~12 frames (ffmpeg `tile`)',
      '- `REVIEW.md` — the independent final review',
      '',
      '## Final output',
      `A short summary: mode, shot cards used, duration/size, music, review verdict, the deliverable file list, and how to keep editing: \`node ${dir}/workbench/scripts/open.mjs <absolute path of ./project>\` (Motion Workbench on :5198).`,
    ].join('\n');
  }

  private title(brief: ShotcraftBrief): string {
    const icon = brief.mode === 'shot' ? '🎞️' : '🎬';
    return `${icon} Shotcraft: ${brief.product} — ${brief.message.replace(/\s+/g, ' ').slice(0, 50)}`;
  }

  /** Tags + context shared by tasks. Guided/ask modes park on wait-input for a
   *  human unless the requester opted into auto-answer (`human-only` tag). */
  private taskMeta(brief: ShotcraftBrief) {
    const stops = brief.mode === 'guided' || brief.mode === 'ask';
    return {
      tags: [SHOTCRAFT_TAG, ...(stops && !brief.autoAnswer ? ['human-only'] : [])],
      context: { brain: brief.brain, claudeProfile: 'full', shotcraft: brief },
    };
  }

  /** One-off task (also the body of a recurring one). */
  buildTask(brief: ShotcraftBrief, inputNames: string[] = []) {
    return {
      title: this.title(brief),
      description: `# video-shotcraft: ${brief.product}\n\n${this.briefText(brief, inputNames)}`,
      ...this.taskMeta(brief),
    };
  }

  /** Goal: the achiever drives the film through capture → storyboard → produce
   *  → review until the judge can answer the success question with Yes. */
  buildGoal(brief: ShotcraftBrief) {
    return {
      title: `🎬 ${brief.product} promo film (video-shotcraft)`,
      description: [
        `Produce a finished product film with the video-shotcraft skill. Every task this goal creates must name the skill (\`/video-shotcraft\`) and be pinned to brain ${brief.brain}.`,
        'Give each task the brief below verbatim; the producing task\'s artifacts dir is where the film lives — later tasks read it from there.',
        '',
        '---',
        this.briefText({ ...brief, mode: brief.mode === 'guided' || brief.mode === 'ask' ? 'auto' : brief.mode }),
      ].join('\n'),
      successCriteria: `Is there a film.mp4 of ${brief.product} in a task's artifacts, with a REVIEW.md from an independent final review that found no blocking issues?`,
      reportBrief: 'Link the film.mp4, poster.jpg and REVIEW.md; one line on the treatment and the review verdict.',
      phases: [
        { key: 'capture', title: 'Product check + real-page capture' },
        { key: 'storyboard', title: 'Visual direction, shot mapping, storyboard' },
        { key: 'produce', title: 'Remotion build, sound design, render' },
        { key: 'review', title: 'Independent final review + fixes' },
      ],
      achieverBrainChain: [brief.brain],
      stepBudget: 8,
    };
  }

  /** Reusable workflow template: this run's settings are frozen into it and
   *  product / source / message / notes become run params, so the same look can
   *  be re-run for another product from the Workflows tab. */
  buildWorkflow(brief: ShotcraftBrief, id: string, artifactsRoot: string): WorkflowDef {
    if (!NAME_RE.test(id)) throw new Error('workflow id: lowercase letters, digits and dashes only');
    const mode: ShotcraftMode = brief.mode === 'guided' || brief.mode === 'ask' ? 'auto' : brief.mode;
    const body = this.briefText({
      ...brief, mode, product: '{{product}}', message: '{{message}}', source: '{{source}}', notes: '{{notes}}',
    });
    return {
      id,
      name: `🎬 Shotcraft · ${id.replace(/^shotcraft-/, '')}`,
      description: `video-shotcraft film, ${mode} mode, ${brief.aspect}${mode === 'template' ? '' : `, ${brief.seconds}s`}, music: ${brief.music}${brief.shots.length ? `, shots: ${brief.shots.join(', ')}` : ''}. Params: product, source (URL/path or "none"), message, notes ("none").`,
      params: ['product', 'source', 'message', 'notes'],
      steps: [
        {
          key: 'produce',
          title: '🎬 Shotcraft: {{product}}',
          description: `# video-shotcraft: {{product}}\n\n${body}`,
          brain: brief.brain,
        },
        {
          key: 'second-look',
          title: '🔍 Shotcraft review: {{product}}',
          description: [
            'Independent second look at a film made with the video-shotcraft skill. You did not make it; judge it cold.',
            `The upstream "produce" task's id is in the dependency results in your prompt; its files are in ${artifactsRoot}/<that id>/ (film.mp4, STORYBOARD.md, REVIEW.md, contact.jpg).`,
            '1. Extract ~1 frame/s with ffmpeg into your artifacts dir and look at them.',
            '2. Check against the request ({{message}}), the skill\'s references/final-review.md and references/aesthetic-rules.md (in ~/.agents/skills/video-shotcraft): readable text, on-brand colours, holds ≥1 s on key info, no sensitive data, audio present and not clipping (ffmpeg volumedetect).',
            '3. Write SECOND-LOOK.md: verdict SHIP / FIX, then findings with frame numbers. Do not re-render.',
          ].join('\n'),
          brain: brief.brain === 'local-cc-opus-5-5' ? 'local-cc-sonnet-5-5' : brief.brain,
          dependsOn: ['produce'],
        },
      ],
    };
  }
}
