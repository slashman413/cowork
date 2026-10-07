/**
 * Live progress rendering for brain runs.
 *
 * In plain print mode (`claude -p`, `agy -p`) a CLI writes NOTHING to stdout until
 * the very end — it prints the final answer and exits — so the progress log (and
 * the dashboard's live window) only ever showed the "▶ started / task: …" header.
 * Both CLIs can instead stream newline-delimited JSON events while they work
 * (`--output-format stream-json`). This module turns that event stream into a
 * readable, human transcript for progress.log ("🔧 Bash: npm test", "↳ 12 passed",
 * "💬 Now fixing the router…") AND recovers the final answer text from the
 * terminal `result` event, so the rest of the dispatcher (verifier, result.md,
 * wait-input/background detection) still receives exactly what plain `-p` printed.
 *
 * Exec types without a structured stream (hermes, codex, dsh, ollama, script) keep
 * the raw passthrough: their stdout/stderr already IS their progress.
 */

/** Exec types whose argv gets `--output-format stream-json` in execute(). */
export const STREAMING_EXECS = new Set(['claude', 'agy']);

/** Extra argv that switches a streaming exec into JSON-event mode. */
export function streamArgs(exec: string): string[] {
  if (exec === 'claude') return ['--output-format', 'stream-json', '--verbose'];
  if (exec === 'agy') return ['--output-format', 'stream-json'];
  return [];
}

export interface StreamRenderer {
  /** Feed a raw stdout chunk; returns human-readable text to append to progress.log. */
  feed(chunk: string): string;
  /** Flush a trailing partial line (call once when the process closes). */
  flush(): string;
  /**
   * The run's answer: the `result` event's text when one arrived; otherwise the
   * assistant text seen so far (a timed-out / killed run) plus any non-JSON
   * output (a CLI that errored before streaming), so nothing is silently lost.
   */
  finalText(): string;
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** First few lines of a tool's output, indented under its call. */
function toolOutput(raw: unknown, isError: boolean): string {
  let s = '';
  if (typeof raw === 'string') s = raw;
  else if (Array.isArray(raw)) s = raw.map(p => (p && typeof p === 'object' && 'text' in p) ? String((p as any).text) : '').join('\n');
  else if (raw != null) s = JSON.stringify(raw);
  s = s.replace(/\r/g, '').trim();
  const mark = isError ? '   ✗ ' : '   ↳ ';
  if (!s) return `${mark}(no output)\n`;
  const lines = s.split('\n');
  const shown = lines.slice(0, 4).map(l => clip(l, 200));
  const more = lines.length > 4 ? `\n     … (+${lines.length - 4} more lines)` : '';
  return `${mark}${shown.join('\n     ')}${more}\n`;
}

/** One-line summary of a tool call: the argument that says what it is doing. */
function describeTool(name: string, input: Record<string, any> = {}): string {
  const pick = input.command ?? input.CommandLine ?? input.file_path ?? input.path ?? input.AbsolutePath
    ?? input.TargetFile ?? input.pattern ?? input.Query ?? input.query ?? input.url ?? input.Url
    ?? input.description ?? input.prompt ?? input.skill;
  const arg = pick != null ? String(pick) : (Object.keys(input).length ? JSON.stringify(input) : '');
  const extra = name === 'Bash' && input.description && input.command ? `  # ${clip(String(input.description), 80)}` : '';
  return `🔧 ${name}${arg ? `: ${clip(arg, 240)}` : ''}${extra}\n`;
}

const ts = () => new Date().toISOString().slice(11, 19);

/** Line-buffered JSONL renderer for a streaming exec type. */
export function createStreamRenderer(exec: string): StreamRenderer {
  let buf = '';
  let result: string | null = null;
  let assistantText = '';           // fallback answer if no result event arrives
  let plain = '';                   // non-JSON output (startup errors etc.)
  let agyStep = -1;                 // agy: step currently streaming text deltas
  let agyText = '';

  const onClaude = (ev: any): string => {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') return `[${ts()}] ⚙ session started · model ${ev.model || '?'}\n`;
        return '';                  // thinking_tokens / hooks etc. — noise
      case 'assistant': {
        let o = '';
        for (const c of ev.message?.content || []) {
          if (c.type === 'text' && c.text?.trim()) {
            assistantText += `${c.text}\n`;
            o += `[${ts()}] 💬 ${c.text.trim()}\n`;
          } else if (c.type === 'tool_use') {
            o += `[${ts()}] ${describeTool(c.name, c.input)}`;
          }
        }
        return o;
      }
      case 'user': {
        let o = '';
        const content = ev.message?.content;
        if (Array.isArray(content)) {
          for (const c of content) if (c.type === 'tool_result') o += toolOutput(c.content, !!c.is_error);
        }
        return o;
      }
      case 'rate_limit_event':
        return ev.rate_limit_info?.status && ev.rate_limit_info.status !== 'allowed'
          ? `[${ts()}] ⚠ rate limit: ${ev.rate_limit_info.status}\n` : '';
      case 'result': {
        if (typeof ev.result === 'string') result = ev.result;
        const secs = ev.duration_ms ? `${Math.round(ev.duration_ms / 1000)}s` : '?';
        const cost = typeof ev.total_cost_usd === 'number' ? ` · $${ev.total_cost_usd.toFixed(3)}` : '';
        return `[${ts()}] ${ev.is_error ? '✗ ended with error' : '✔ agent finished'} · ${secs} · ${ev.num_turns ?? '?'} turns${cost}\n`;
      }
      default:
        return '';
    }
  };

  const onAgy = (ev: any): string => {
    if (ev.event === 'init') return `[${ts()}] ⚙ session started\n`;
    if (ev.event === 'result') {
      const r = ev.result || {};
      if (typeof r.response === 'string') result = r.response;
      const secs = r.duration_seconds ? `${Math.round(r.duration_seconds)}s` : '?';
      return `${agyStep >= 0 ? '\n' : ''}[${ts()}] ${r.status === 'SUCCESS' ? '✔ agent finished' : `✗ ended: ${r.status || 'unknown'}`} · ${secs}\n`;
    }
    if (ev.event !== 'step_update') return '';
    const s = ev.step_update || {};
    let o = '';
    if (s.step_type === 'agent_response') {
      if (s.text_delta) {
        if (agyStep !== s.step_index) { agyStep = s.step_index; o += `[${ts()}] 💬 `; }
        agyText += s.text_delta;
        o += s.text_delta;
      }
      if (s.state === 'DONE' && agyStep === s.step_index) {
        assistantText += `${agyText}\n`;
        agyText = '';
        agyStep = -1;
        if (!o.endsWith('\n')) o += '\n';
      }
      return o;
    }
    if (s.step_type === 'tool') {
      const info = s.tool_info || {};
      if (s.state === 'ACTIVE') return `[${ts()}] ${describeTool(s.tool_name || info.name || 'tool', info.parameters)}`;
      if (s.state === 'DONE') return toolOutput(info.output, !!info.error);
      if (s.state && s.state !== 'DONE') return `   ✗ ${s.state}${info.error ? `: ${clip(String(info.error), 200)}` : ''}\n`;
    }
    return '';
  };

  const line = (l: string): string => {
    if (!l.trim()) return '';
    let ev: any;
    try { ev = JSON.parse(l); } catch { plain += `${l}\n`; return `${l}\n`; }
    if (!ev || typeof ev !== 'object') { plain += `${l}\n`; return `${l}\n`; }
    try { return exec === 'agy' ? onAgy(ev) : onClaude(ev); } catch { return ''; }
  };

  return {
    feed(chunk) {
      buf += chunk;
      let out = '';
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out += line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      return out;
    },
    flush() {
      const rest = buf;
      buf = '';
      return line(rest);
    },
    finalText() {
      if (result !== null) return result;
      return `${assistantText}${agyText}${plain}`.trim();
    }
  };
}
