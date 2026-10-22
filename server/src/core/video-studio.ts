import fs from 'fs';
import path from 'path';
import os from 'os';
import type { VideoStudioConfig } from '../types.js';

/**
 * Video Studio — the server side of /video-studio.html.
 *
 * A film is made by an ordinary cowork task: a Claude brain directs and renders
 * it with the lemo-opuscar style library (a plain git clone, default
 * ~/lemo-opuscar — https://github.com/lemomo-ai/lemo-opuscar). This module only
 *  (a) exposes the library's style catalog + poster frames to the page, and
 *  (b) turns the page's brief form into one fixed task description, so every
 *      brain gets the same instructions and the deliverables always land at the
 *      artifacts ROOT under fixed names (GET /api/artifacts/:id lists top-level
 *      files only).
 *
 * READ-ONLY on the library: nothing here writes into it. Poster reads are
 * path-guarded (slug charset + basename) like the artifacts route.
 */

export const VIDEO_STUDIO_TAG = 'video-studio';

export const DEFAULT_VIDEO_STUDIO: Required<VideoStudioConfig> = {
  libDir: '~/lemo-opuscar',
  myStylesDir: '~/lemo-my-styles',
  defaultBrain: 'local-cc-sonnet-5-5',
  brains: ['local-cc-sonnet-5-5', 'local-cc-opus-5-5'],
  renderSlots: 1,
};

export interface StudioStyle {
  slug: string;
  en: string;
  cn: string;
  cat_en: string;
  cat_cn: string;
  film?: string;
  line?: string;
  line_cn?: string;
  uses: string[];
  dur?: number;
  /** One of the user's own styles from ~/lemo-my-styles/ (pinned first in the UI). */
  my?: boolean;
  /** True when a poster frame exists for GET /api/video-studio/frames/:slug. */
  poster: boolean;
  /** Recommended size for my-styles that declare one, e.g. "1080x1440". */
  size?: string;
}

export interface FilmBrief {
  slug: string;
  topic: string;
  seconds: number;
  aspect: '16:9' | '9:16' | '3:4';
  voice: 'none' | 'en' | 'zh';
  voiceHint?: string;
  music: boolean;
  storyboard: boolean;
  brain: string;
  notes?: string;
}

export const ASPECTS: Record<FilmBrief['aspect'], { w: number; h: number }> = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '3:4': { w: 1080, h: 1440 },
};
const LENGTHS = [15, 30, 45, 60, 90];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const expand = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export function resolveStudioConfig(cfg?: VideoStudioConfig): Required<VideoStudioConfig> {
  const merged = { ...DEFAULT_VIDEO_STUDIO, ...(cfg || {}) };
  return {
    ...merged,
    libDir: expand(merged.libDir),
    myStylesDir: expand(merged.myStylesDir),
    brains: Array.isArray(merged.brains) && merged.brains.length ? merged.brains : DEFAULT_VIDEO_STUDIO.brains,
  };
}

const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; } };
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export class VideoStudio {
  private cache: { key: string; styles: StudioStyle[] } | null = null;
  readonly cfg: Required<VideoStudioConfig>;

  constructor(cfg?: VideoStudioConfig) { this.cfg = resolveStudioConfig(cfg); }

  private get catalogFile() { return path.join(this.cfg.libDir, 'styleboard', 'catalog.json'); }

  available(): boolean { return fs.existsSync(this.catalogFile); }

  /** Library version (short HEAD) for the page footer; '' when not a git clone. */
  libVersion(): string {
    try {
      const head = fs.readFileSync(path.join(this.cfg.libDir, '.git', 'HEAD'), 'utf-8').trim();
      const sha = head.startsWith('ref:')
        ? fs.readFileSync(path.join(this.cfg.libDir, '.git', head.slice(5).trim()), 'utf-8').trim()
        : head;
      return sha.slice(0, 7);
    } catch { return ''; }
  }

  /** Library catalog + the user's own styles, cached on the inputs' mtimes. */
  styles(): StudioStyle[] {
    const myDirs = this.myStyleDirs();
    const mt = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
    const key = [mt(this.catalogFile), ...myDirs.map(d => `${d}:${mt(path.join(this.cfg.myStylesDir, d, 'style.json'))}`)].join('|');
    if (this.cache?.key === key) return this.cache.styles;

    const out: StudioStyle[] = [];
    for (const d of myDirs) {
      const j = readJson(path.join(this.cfg.myStylesDir, d, 'style.json'));
      if (!j) continue;
      out.push({
        slug: d, en: str(j.en) || d, cn: str(j.cn), cat_en: 'My styles', cat_cn: '我的风格',
        line: str(j.line), line_cn: str(j.line_cn), uses: [], my: true,
        poster: !!this.posterFile(d), ...(str(j.size) ? { size: str(j.size) } : {}),
      });
    }
    const cat = readJson(this.catalogFile);
    for (const s of Array.isArray(cat) ? cat : []) {
      if (!s || !SLUG_RE.test(str(s.slug)) || myDirs.includes(s.slug)) continue;
      out.push({
        slug: s.slug, en: str(s.en) || s.slug, cn: str(s.cn), cat_en: str(s.cat_en) || 'Other', cat_cn: str(s.cat),
        film: str(s.film), line: str(s.line), line_cn: str(s.line_cn),
        uses: Array.isArray(s.uses) ? s.uses.filter((u: unknown) => typeof u === 'string') : [],
        dur: typeof s.dur === 'number' ? s.dur : undefined, poster: !!this.posterFile(s.slug),
      });
    }
    this.cache = { key, styles: out };
    return out;
  }

  getStyle(slug: string): StudioStyle | undefined { return this.styles().find(s => s.slug === slug); }

  private myStyleDirs(): string[] {
    try {
      return fs.readdirSync(this.cfg.myStylesDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && SLUG_RE.test(e.name) && fs.existsSync(path.join(this.cfg.myStylesDir, e.name, 'style.json')))
        .map(e => e.name).sort();
    } catch { return []; }
  }

  /** Absolute poster path for a slug, or null. Never resolves outside the two roots. */
  posterFile(slug: string): string | null {
    if (!SLUG_RE.test(slug)) return null;
    const s = path.basename(slug);
    const candidates = [
      path.join(this.cfg.myStylesDir, s, 'poster.jpg'),
      path.join(this.cfg.libDir, 'docs', 'frames', `${s}.jpg`),
      path.join(this.cfg.libDir, 'styles', s, 'poster.jpg'),
    ];
    return candidates.find(f => fs.existsSync(f)) || null;
  }

  /** Validate + normalise the page's form. Throws with a user-facing message. */
  parseBrief(body: any): FilmBrief {
    const b = body || {};
    const slug = str(b.slug);
    if (!SLUG_RE.test(slug) || !this.getStyle(slug)) throw new Error('unknown style');
    const topic = str(b.topic).trim();
    if (topic.length < 3) throw new Error('topic is required');
    if (topic.length > 4000) throw new Error('topic is too long (max 4000 characters)');
    const seconds = LENGTHS.includes(Number(b.seconds)) ? Number(b.seconds) : 45;
    const aspect = (Object.keys(ASPECTS) as FilmBrief['aspect'][]).includes(b.aspect) ? b.aspect : '16:9';
    const voice = ['none', 'en', 'zh'].includes(b.voice) ? b.voice : 'none';
    const brain = this.cfg.brains.includes(b.brain) ? b.brain : this.cfg.defaultBrain;
    return {
      slug, topic, seconds, aspect, voice, brain,
      voiceHint: str(b.voiceHint).trim().slice(0, 200) || undefined,
      music: b.music !== false,
      storyboard: b.storyboard === true,
      notes: str(b.notes).trim().slice(0, 2000) || undefined,
    };
  }

  /** The fixed task the dispatcher hands to the brain. */
  buildTask(brief: FilmBrief, inputNames: string[] = []) {
    const style = this.getStyle(brief.slug)!;
    const { w, h } = ASPECTS[brief.aspect];
    const styleDoc = style.my
      ? `${this.cfg.myStylesDir}/${style.slug}/STYLE.md (one of the user's own styles — see MY-STYLES.md "Using it")`
      : `styles/${style.slug}/STYLE.md`;
    const voice = brief.voice === 'none' ? 'none (no narration; on-screen text carries the story)'
      : brief.voice === 'en' ? `English, Kokoro offline TTS (core/tts/tts.py)${brief.voiceHint ? ` — voice hint: ${brief.voiceHint}` : ''}`
      : `Mandarin Chinese (Traditional Chinese on-screen text and subtitles for a Taiwan audience), edge-tts (core/tts/tts_zh.py, e.g. zh-TW-HsiaoChenNeural)${brief.voiceHint ? ` — voice hint: ${brief.voiceHint}` : ''}`;
    const titleTopic = brief.topic.replace(/\s+/g, ' ').slice(0, 60);
    const lines = [
      `# Video Studio film: ${style.en}${style.cn ? ` ${style.cn}` : ''}`,
      '',
      `Make a ${brief.seconds}-second film in the lemo-opuscar "${style.en}" style about:`,
      '',
      brief.topic.split('\n').map(l => `> ${l}`).join('\n'),
      '',
      '## The brief is complete — do not ask questions',
      `- Library: ${this.cfg.libDir} (already installed with voice + music tiers, HDRIs and instrument packs). Read AGENTS.md, DIRECTOR.md, TECHNIQUE.md, core/README.md and ${styleDoc}, and follow them. Skip AGENTS.md "Start" and Workflow step 1 (the brief): this task IS the brief, already answered.`,
      `- Output: ${w}×${h} (--size ${w}x${h}), 24 fps, ${brief.seconds} s (±10%).`,
      `- Narration: ${voice}.`,
      `- Music: ${brief.music ? 'yes — score it with the library tools (core/audio/sampler.py / pluck.py)' : 'no music; foley/SFX only where the style calls for it'}.`,
      `- Attached inputs: ${inputNames.length ? inputNames.join(', ') + ' (listed in your prompt; use them in the film)' : 'none'}.`,
      ...(brief.notes ? [`- Extra notes from the requester: ${brief.notes}`] : []),
      '- This is the requester\'s own film (outside `styles/`): no LemoLab credit, no watermark.',
      '',
      '## Where things go',
      `- Project folder: ./film/ (relative to your working dir = $COWORK_ARTIFACTS_DIR). Never build inside the library's styles/.`,
      `- Before every full render: \`export RENDER_SLOTS=${this.cfg.renderSlots}\` — this host shares unified memory with the local LLM, so full renders queue machine-wide.`,
      '- When done, COPY the deliverables to the artifacts ROOT with exactly these names (the task card only lists top-level files):',
      '  - `film.mp4` — the final muxed film (core/render/mux.sh)',
      '  - `poster.jpg` — one strong frame from the film',
      '  - `film.srt` and `film.vtt` — subtitles (if there is narration or dialogue)',
      '  - `contact.jpg` — contact sheet of ~12 frames (core/render/sheet.py)',
      '  - `TREATMENT.md` — your treatment',
      '',
      brief.storyboard
        ? '## Storyboard gate\nAfter the look frames, render the key shots to `storyboard.jpg` in the artifacts root, then STOP and end your output with a line `NEEDS_INPUT: Approve this storyboard (storyboard.jpg)? Reply "approve" or describe changes.` Continue from the reply when this task is resumed.'
        : '## No storyboard gate\nDo not stop for approval at any point; carry the film through to delivery.',
      '',
      '## Final output',
      'A short summary: the treatment you chose (one line), duration, size, voice/music used, render time, and the deliverable file list.',
    ];
    return {
      title: `🎬 ${style.en}: ${titleTopic}`,
      description: lines.join('\n'),
      tags: [VIDEO_STUDIO_TAG],
      context: { brain: brief.brain, videoStudio: { ...brief, styleName: style.en } },
    };
  }
}
