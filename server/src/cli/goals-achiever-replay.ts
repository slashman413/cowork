/**
 * Replay: old vs new Achiever prompt on the same reconstructed goal states.
 *
 * Plan phase 1 check: the move `kind` agrees on at least 85% of states, with no
 * unsupported met:true. Rebuilds states from the live goals (read-only) by rewinding
 * each one to after phase k, and asks one model both prompts with no tools. The sample
 * is small, so treat this as a smoke test and read every disagreement by hand.
 *
 *   npx tsx src/cli/goals-achiever-replay.ts <cowork-dir> [--model claude-haiku-5-5] [--max 15] [--out file.json]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Goals } from '../core/goals.js';
import { Dispatcher } from '../core/dispatcher.js';
import { buildAchieverPrompt, estimateTokens } from '../core/achiever-prompt.js';
import type { Config, Task } from '../types.js';

const args = process.argv.slice(2);
const root = args[0];
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const model = opt('--model', 'claude-haiku-5-5');
const max = parseInt(opt('--max', '15'), 10);
const outFile = opt('--out', '');

const tasks: Task[] = fs.readdirSync(path.join(root, 'inbox')).filter(f => f.endsWith('.json')).flatMap(f => {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(root, 'inbox', f), 'utf-8'));
    return t.context?.goalId ? [t] : [];
  } catch { return []; }
});
const config = { paths: { goals: path.join(root, 'goals'), artifacts: path.join(root, 'artifacts') }, orchestration: {} } as unknown as Config;
const goals = new Goals(config, { createTask() { throw new Error('read-only'); }, listTasks: () => tasks, getTask: id => tasks.find(t => t.id === id) || null });

// Dispatcher.parseAchieverDecision and the legacy prompt touch no instance state.
const proto = Dispatcher.prototype as any;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'achiever-replay-'));

function ask(prompt: string): Promise<{ text: string; input: number }> {
  return new Promise(resolve => {
    const child = spawn('claude', ['-p', prompt, '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', 'project,local', '--output-format', 'json'],
      { cwd: scratch, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => {
      try {
        const ev = JSON.parse(out);
        resolve({ text: ev.result || '', input: (ev.usage?.input_tokens || 0) + (ev.usage?.cache_read_input_tokens || 0) + (ev.usage?.cache_creation_input_tokens || 0) });
      } catch { resolve({ text: out, input: 0 }); }
    });
  });
}

const states: { label: string; ctx: any }[] = [];
for (const rec of goals.list()) {
  const full = goals.achieverContext(rec.goalId)!;
  for (let k = 0; k <= full.phases.length; k++) {
    const phases = full.phases.map((p, i) => ({
      ...p,
      status: i < k ? 'audited' : i === k ? 'active' : 'planned',
      results: i <= k && i < k ? p.results : []
    }));
    const minutes = rec.minutes.filter(m => phases.some((p, i) => p.key === m.phaseKey && i < k)).at(-1);
    states.push({
      label: `${rec.goalId} after phase ${k}/${full.phases.length}`,
      ctx: { ...full, record: { ...full.record, lastRejected: undefined }, phases, currentPhaseKey: phases[k]?.key || null,
        latestMinutes: minutes?.artifact, nextMove: minutes ? (goals as any).readNextMove(minutes.artifact) : undefined }
    });
  }
}
// An even spread across goals rather than the first goal's states.
const picked = states.filter((_, i) => i % Math.max(1, Math.floor(states.length / max)) === 0).slice(0, max);

const rows: any[] = [];
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < picked.length) {
    const s = picked[next++];
    const oldPrompt = proto.achieverPrompt.call({}, s.ctx);
    const newPrompt = buildAchieverPrompt(s.ctx);
    const [o, n] = await Promise.all([ask(oldPrompt), ask(newPrompt)]);
    const od = proto.parseAchieverDecision.call({}, o.text);
    const nd = proto.parseAchieverDecision.call({}, n.text);
    rows.push({
      state: s.label, oldKind: od?.kind ?? null, newKind: nd?.kind ?? null, agree: !!od && od.kind === nd?.kind,
      newMet: nd?.kind === 'evaluate' && nd.met === true, oldMet: od?.kind === 'evaluate' && od.met === true,
      promptTokensEst: { old: estimateTokens(oldPrompt), new: estimateTokens(newPrompt) }, firstTurn: { old: o.input, new: n.input },
      oldReason: od?.reason?.slice(0, 240), newReason: nd?.reason?.slice(0, 240)
    });
    console.error(`${s.label}: old=${od?.kind} new=${nd?.kind}`);
  }
}));
const agree = rows.filter(r => r.agree).length;
const report = { model, states: rows.length, agree, agreePct: Math.round(100 * agree / Math.max(1, rows.length)),
  newMetTrue: rows.filter(r => r.newMet).length, maxPromptTokensEst: Math.max(...rows.map(r => r.promptTokensEst.new)), maxFirstTurn: Math.max(...rows.map(r => r.firstTurn.new)), rows };
const text = JSON.stringify(report, null, 1);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
fs.rmSync(scratch, { recursive: true, force: true });
