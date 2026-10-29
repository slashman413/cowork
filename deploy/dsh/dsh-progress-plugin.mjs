/**
 * Cowork progress & context compaction reporter for DeepSeek Harness (dsh).
 *
 * Intercepts dsh session events and LLM streaming to provide real-time status:
 * - Tool calls, outputs, step transitions, and assistant messages.
 * - CONTEXT_WINDOW_EXCEEDED error detection.
 * - Context compaction prefill progress, live generation token count, and completion status.
 *
 * Writes formatted lines to stderr which Cowork dispatcher streams to progress.log.
 */

export const name = 'dsh-cowork-progress';
export const inject = ['llm'];

const clip = (s, n) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const ts = () => {
  try {
    const d = new Date();
    return d.toTimeString().slice(0, 8);
  } catch {
    return '00:00:00';
  }
};

const formatDuration = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
};

export function apply(ctx) {
  const write = (msg) => {
    try {
      process.stderr.write(msg);
    } catch {
      // Fail-soft: process I/O errors must never crash the brain
    }
  };

  // Intercept LLM stream to track compaction prefill & generation progress
  if (ctx.llm && typeof ctx.llm.stream === 'function') {
    const origStream = ctx.llm.stream.bind(ctx.llm);
    ctx.llm.stream = async function* (options) {
      if (options && options.purpose === 'compaction') {
        const start = Date.now();
        let approxPromptTokens = 0;
        try {
          const inputStr = JSON.stringify(options.messages || []) + (options.system || '');
          approxPromptTokens = Math.max(1, Math.round(inputStr.length / 3.8));
        } catch {
          approxPromptTokens = 1000;
        }

        const tokenLabel = approxPromptTokens >= 1000
          ? `${Math.round(approxPromptTokens / 1000)}k`
          : `${approxPromptTokens}`;
        const modelLabel = options.model
          ? `${options.provider || 'local-sglang'}:${options.model}`
          : 'local engine';

        write(`[${ts()}] ⏳ [Compaction] Context threshold crossed (~${tokenLabel} prompt tokens) · prefilling prompt on ${modelLabel}...\n`);

        let prefillDone = false;
        let prefillElapsed = 0;
        let generatedChars = 0;
        let lastReportTokens = 0;
        let lastReportTime = start;

        const timer = setInterval(() => {
          try {
            const now = Date.now();
            const elapsed = formatDuration(now - start);
            if (!prefillDone) {
              write(`[${ts()}] ⏳ [Compaction] Prefilling context (~${tokenLabel} prompt tokens)... (elapsed: ${elapsed})\n`);
            } else {
              const genTokens = Math.round(generatedChars / 3.8);
              if (now - lastReportTime >= 5000 || genTokens - lastReportTokens >= 500) {
                write(`[${ts()}] ⏳ [Compaction] Generating summary (~${genTokens} tokens generated, elapsed: ${elapsed})\n`);
                lastReportTokens = genTokens;
                lastReportTime = now;
              }
            }
          } catch {}
        }, 5000);

        try {
          for await (const chunk of origStream(options)) {
            if (!prefillDone) {
              prefillDone = true;
              prefillElapsed = Date.now() - start;
              write(`[${ts()}] ⏳ [Compaction] Prefill finished in ${formatDuration(prefillElapsed)}. Generating compacted summary...\n`);
            }
            if (chunk) {
              if (typeof chunk.text_delta === 'string') {
                generatedChars += chunk.text_delta.length;
              } else if (typeof chunk.text === 'string') {
                generatedChars += chunk.text.length;
              } else if (chunk.type === 'content' && typeof chunk.content === 'string') {
                generatedChars += chunk.content.length;
              }
            }
            yield chunk;
          }
        } finally {
          clearInterval(timer);
          const totalDuration = formatDuration(Date.now() - start);
          const genTokens = Math.round(generatedChars / 3.8);
          write(`[${ts()}] ⏳ [Compaction] Summary generation finished (~${genTokens} tokens in ${totalDuration})\n`);
        }
        return;
      }

      // Normal LLM stream: pass through
      for await (const chunk of origStream(options)) {
        yield chunk;
      }
    };
  }

  // Session event listener for tool calls, results, step transitions, and compaction lifecycle
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || !event.type) return;

      switch (event.type) {
        case 'compaction/start': {
          const turn = event.data?.turn ? ` (turn ${event.data.turn})` : '';
          write(`[${ts()}] ⚙ Context compaction initiated${turn}\n`);
          break;
        }
        case 'compaction/summary': {
          write(`[${ts()}] ⚙ Compaction summary generated · updating context surface\n`);
          break;
        }
        case 'compaction/end': {
          write(`[${ts()}] ✔ Context compaction complete · context freed, resuming task\n`);
          break;
        }
        case 'step/start': {
          if (event.data?.step) {
            write(`[${ts()}] ⚙ Step ${event.data.step} started\n`);
          }
          break;
        }
        case 'tool/call': {
          const d = event.data || {};
          const name = d.name || 'tool';
          let args = d.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch {}
          }
          const desc = args?.description ? `  # ${clip(args.description, 80)}` : '';
          const pick = args?.command ?? args?.CommandLine ?? args?.file_path ?? args?.path ??
            args?.pattern ?? args?.query ?? args?.prompt ??
            (args && typeof args === 'object' ? JSON.stringify(args) : '');
          write(`[${ts()}] 🔧 ${name}${pick ? `: ${clip(String(pick), 200)}` : ''}${desc}\n`);
          break;
        }
        case 'tool/result': {
          const d = event.data || {};
          const msg = d.message || {};
          const content = msg.content || [];
          let text = '';
          let isError = false;
          for (const c of content) {
            if (c.type === 'tool-result') {
              if (c.isError) isError = true;
              if (Array.isArray(c.content)) {
                text += c.content.map(p => (p && p.text) ? p.text : '').join('\n');
              } else if (typeof c.content === 'string') {
                text += c.content;
              }
            }
          }
          const mark = isError ? '   ✗ ' : '   ↳ ';
          const clean = text.replace(/\r/g, '').trim();
          if (!clean) {
            write(`${mark}(no output)\n`);
          } else {
            const lines = clean.split('\n');
            const shown = lines.slice(0, 3).map(l => clip(l, 180));
            const more = lines.length > 3 ? `\n     … (+${lines.length - 3} more lines)` : '';
            write(`${mark}${shown.join('\n     ')}${more}\n`);
          }
          break;
        }
        case 'assistant/chunk': {
          const d = event.data || {};
          const chunk = d.chunk || {};
          if (chunk.reason?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED' ||
              (chunk.reason?.failure?.message && /context[\s_-]window|threshold/i.test(chunk.reason.failure.message))) {
            write(`[${ts()}] ⚠️ CONTEXT_WINDOW_EXCEEDED: conversation history crossed token threshold\n`);
          }
          break;
        }
        case 'assistant/message': {
          const d = event.data || {};
          const msg = d.message || {};
          const content = msg.content || [];
          let txt = '';
          for (const c of content) {
            if (c.type === 'text' && c.text?.trim()) txt += c.text.trim();
          }
          if (txt) {
            const firstLine = txt.split('\n')[0].trim();
            write(`[${ts()}] 💬 ${clip(firstLine, 180)}\n`);
          }
          break;
        }
      }
    } catch {
      // Fail-soft: logging must never interrupt session execution
    }
  });
}
