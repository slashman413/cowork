import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { Workflows } from './workflows.js';
import type { Config, Task, WorkflowDef } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FakeStore {
  tasks: Task[] = [];
  createTask(params: Omit<Task, 'id' | 'status' | 'createdAt'>): Task {
    const task = {
      ...params,
      id: uuidv4(),
      status: 'pending',
      createdAt: new Date().toISOString()
    } as Task;
    this.tasks.push(task);
    return task;
  }
  listTasks(): Task[] {
    return this.tasks;
  }
  getTask(id: string): Task | null {
    return this.tasks.find(t => t.id === id) || null;
  }
  saveTask(task: Task): void {
    const idx = this.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) this.tasks[idx] = task;
    else this.tasks.push(task);
  }
  parkForInput(opts: { taskId: string; questions: string[]; result?: string }): Task | null {
    const t = this.getTask(opts.taskId);
    if (t) {
      t.status = 'wait-input';
      if (opts.result) t.result = opts.result;
      t.interaction = {
        prompt: 'The assigned agent paused and needs your input before it can finish this task.',
        fields: (opts.questions || []).map((q, i) => ({
          id: `q${i + 1}`,
          label: q,
          type: 'textarea' as const,
          required: i === 0
        })),
        status: 'pending'
      };
      this.saveTask(t);
      return t;
    }
    return null;
  }
}

function makeHarness(templates: Record<string, WorkflowDef> = {}, arenaEnabled = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-arena-test-'));
  const dir = path.join(base, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, def] of Object.entries(templates)) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(def));
  }
  const config = {
    paths: { workflows: dir, artifacts: path.join(base, 'artifacts') },
    orchestration: {
      defaultChain: ['brain-claude-std'],
      tiers: {
        mechanical: ['brain-mech'],
        standard: ['brain-claude-std'],
        judgment: ['brain-claude-opus']
      },
      brains: {
        'brain-mech': { exec: 'claude', model: 'haiku' },
        'brain-claude-std': { exec: 'claude', model: 'sonnet' },
        'brain-claude-opus': { exec: 'claude', model: 'opus' },
        'brain-gemini-flash': { exec: 'agy', model: 'gemini-3.8-flash' },
        'brain-qwen': { exec: 'hermes', model: 'qwen3.8-27b' }
      },
      verifier: {
        spec: {
          judges: {
            claude: ['brain-gemini-flash'],
            gemini: ['brain-claude-opus'],
            default: ['brain-claude-opus']
          }
        }
      },
      arena: {
        enabled: arenaEnabled
      }
    }
  } as unknown as Config;

  const store = new FakeStore();
  const workflows = new Workflows(config, store as any);
  return { base, workflows, store, config };
}

test('arena validate: rejects invalid structures and single family runners', () => {
  const { workflows } = makeHarness();

  // 1. Not an object
  const err1 = workflows.validate({
    id: 't1',
    steps: [{ key: 's1', arena: 'invalid' as any }]
  });
  assert.ok(err1.some(e => e.includes('arena must be an object')));

  // 2. Fewer than 2 runners
  const err2 = workflows.validate({
    id: 't2',
    steps: [{
      key: 's1',
      arena: {
        runners: ['brain-claude-opus'],
        rubric: ['Criterion 1', 'Criterion 2', 'Criterion 3']
      }
    }]
  });
  assert.ok(err2.some(e => e.includes('runners must be an array of at least 2 brains')));

  // 3. Single model family across runners (both Claude)
  const err3 = workflows.validate({
    id: 't3',
    steps: [{
      key: 's1',
      arena: {
        runners: ['brain-claude-opus', 'brain-claude-std'],
        rubric: ['Criterion 1', 'Criterion 2', 'Criterion 3']
      }
    }]
  });
  assert.ok(err3.some(e => e.includes('runners must span at least 2 distinct model families')));

  // 4. Rubric < 3 criteria
  const err4 = workflows.validate({
    id: 't4',
    steps: [{
      key: 's1',
      arena: {
        runners: ['brain-claude-opus', 'brain-gemini-flash'],
        rubric: ['Criterion 1', 'Criterion 2']
      }
    }]
  });
  assert.ok(err4.some(e => e.includes('rubric must contain 3-6 gradeable criteria')));

  // 5. Rubric > 6 criteria
  const err5 = workflows.validate({
    id: 't5',
    steps: [{
      key: 's1',
      arena: {
        runners: ['brain-claude-opus', 'brain-gemini-flash'],
        rubric: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']
      }
    }]
  });
  assert.ok(err5.some(e => e.includes('rubric must contain 3-6 gradeable criteria')));

  // 6. Forbidden on media renders or operations steps
  const err6 = workflows.validate({
    id: 't6',
    steps: [{
      key: 'render-step',
      arena: {
        runners: ['brain-claude-opus', 'brain-gemini-flash'],
        rubric: ['C1', 'C2', 'C3']
      }
    }]
  });
  assert.ok(err6.some(e => e.includes('forbidden on media renders or operations')));

  const err7 = workflows.validate({
    id: 't7',
    steps: [{
      key: 'ops-step',
      division: 'operations',
      arena: {
        runners: ['brain-claude-opus', 'brain-gemini-flash'],
        rubric: ['C1', 'C2', 'C3']
      }
    }]
  });
  assert.ok(err7.some(e => e.includes('forbidden on media renders or operations')));

  // 7. Valid arena definition (Claude + Gemini, 4 rubric criteria)
  const ok = workflows.validate({
    id: 't8',
    steps: [{
      key: 'prd',
      arena: {
        runners: ['brain-claude-opus', 'brain-gemini-flash'],
        rubric: ['Completeness', 'Traceability', 'Feasibility', 'Actionability']
      }
    }]
  });
  assert.deepEqual(ok, []);
});

test('arena disabled: step executes as a single normal task', () => {
  const tpl: WorkflowDef = {
    id: 'wf-spec',
    steps: [
      { key: 'research', title: 'Research' },
      {
        key: 'prd',
        title: 'PRD',
        dependsOn: ['research'],
        arena: {
          runners: ['brain-claude-opus', 'brain-gemini-flash'],
          rubric: ['Completeness', 'Traceability', 'Actionability']
        }
      },
      { key: 'scope', title: 'Scope', dependsOn: ['prd'] }
    ]
  };

  const { workflows, store } = makeHarness({ 'wf-spec': tpl }, false); // arena disabled
  const res = workflows.run('wf-spec');
  assert.equal(res.tasks?.length, 3);
  const prdTask = store.tasks.find(t => t.context?.stepKey === 'prd');
  assert.ok(prdTask);
  assert.equal(prdTask.context?.arenaRole, undefined);
});

test('arena enabled: creates N sibling candidate tasks, 1 cross-judge, 1 synthesis task, and wires downstream', () => {
  const tpl: WorkflowDef = {
    id: 'wf-spec',
    steps: [
      { key: 'research', title: 'Research' },
      {
        key: 'prd',
        title: 'Write PRD',
        description: 'Detailed PRD for {{item}}',
        acceptance: ['prd.md is saved'],
        dependsOn: ['research'],
        arena: {
          runners: ['brain-claude-opus', 'brain-gemini-flash'],
          rubric: ['Completeness', 'Traceability', 'Feasibility']
        }
      },
      { key: 'scope', title: 'Scope backlog', dependsOn: ['prd'] }
    ]
  };

  const { workflows, store } = makeHarness({ 'wf-spec': tpl }, true); // arena enabled
  const res = workflows.run('wf-spec', { item: 'Widget' });

  // Total tasks: 1 research + 2 candidates + 1 judge + 1 synthesis + 1 scope = 6 tasks
  assert.equal(res.tasks?.length, 6);

  const researchTask = store.tasks.find(t => t.context?.stepKey === 'research')!;
  const cand1 = store.tasks.find(t => t.context?.stepKey === 'prd:candidate:1')!;
  const cand2 = store.tasks.find(t => t.context?.stepKey === 'prd:candidate:2')!;
  const judge = store.tasks.find(t => t.context?.stepKey === 'prd:judge')!;
  const synth = store.tasks.find(t => t.context?.stepKey === 'prd' && t.context?.arenaRole === 'synthesis')!;
  const scopeTask = store.tasks.find(t => t.context?.stepKey === 'scope')!;

  assert.ok(researchTask);
  assert.ok(cand1);
  assert.ok(cand2);
  assert.ok(judge);
  assert.ok(synth);
  assert.ok(scopeTask);

  // Both candidates depend on researchTask
  assert.deepEqual(cand1.context?.dependsOn, [researchTask.id]);
  assert.deepEqual(cand2.context?.dependsOn, [researchTask.id]);
  assert.equal(cand1.context?.brain, 'brain-claude-opus');
  assert.equal(cand2.context?.brain, 'brain-gemini-flash');

  // Cross-judge depends on both candidates
  assert.deepEqual(judge.context?.dependsOn, [cand1.id, cand2.id]);
  assert.equal(judge.context?.tier, 'review');
  assert.ok(judge.description.includes('Arena Cross-Judge'));

  // Synthesis depends on both candidates + judge
  assert.deepEqual(synth.context?.dependsOn, [cand1.id, cand2.id, judge.id]);
  assert.equal(synth.context?.tier, 'judgment');
  assert.ok(synth.description.includes('Arena Synthesis'));
  assert.ok(synth.context?.acceptance.includes('synthesis.md is saved in the artifacts dir naming the base, judge verdict, grafts, and rejections'));

  // Downstream task (scope) depends on synthesis task!
  assert.deepEqual(scopeTask.context?.dependsOn, [synth.id]);
});

test('arena completion: synthesis completes normally and updates run record', () => {
  const tpl: WorkflowDef = {
    id: 'wf-spec',
    steps: [
      {
        key: 'prd',
        title: 'Write PRD',
        arena: {
          runners: ['brain-claude-opus', 'brain-gemini-flash'],
          rubric: ['C1', 'C2', 'C3']
        }
      }
    ]
  };

  const { workflows, store } = makeHarness({ 'wf-spec': tpl }, true);
  const res = workflows.run('wf-spec');
  const synth = store.tasks.find(t => t.context?.arenaRole === 'synthesis')!;

  synth.status = 'done';
  synth.result = 'STATUS: DONE\nEVIDENCE:\n- prd.md (5000 bytes)\n- synthesis.md (2000 bytes)\nBase: candidate 1.';
  workflows.onTaskCompleted(synth);

  const runRec = (workflows as any).loadRecord(res.runId);
  assert.equal(runRec.arenas?.prd?.status, 'completed');
});

test('arena Phase E divergence: parks step on wait-input with divergence summary', () => {
  const tpl: WorkflowDef = {
    id: 'wf-spec',
    steps: [
      {
        key: 'prd',
        title: 'Write PRD',
        arena: {
          runners: ['brain-claude-opus', 'brain-gemini-flash'],
          rubric: ['C1', 'C2', 'C3']
        }
      },
      {
        key: 'downstream',
        title: 'Downstream',
        dependsOn: ['prd']
      }
    ]
  };

  const { workflows, store } = makeHarness({ 'wf-spec': tpl }, true);
  const res = workflows.run('wf-spec');
  const synth = store.tasks.find(t => t.context?.arenaRole === 'synthesis')!;

  // Simulate Phase E wild divergence
  synth.result = [
    'STATUS: BLOCKED',
    'DIVERGENCE: Candidate 1 built a monolithic desktop architecture while Candidate 2 built a multi-tenant cloud SaaS. The core product direction is fundamentally split.',
    'NEEDS_INPUT: Arena candidates wildly diverged on fundamental architecture. Should we proceed with desktop or SaaS?'
  ].join('\n');

  workflows.onTaskCompleted(synth);

  // Synth task must be parked on wait-input
  assert.equal(synth.status, 'wait-input');
  assert.ok(synth.interaction);
  assert.equal(synth.interaction.status, 'pending');
  assert.ok(synth.interaction.fields[0].label.includes('monolithic desktop architecture'));

  // Run record must be wait-input, and arena status diverged
  const runRec = (workflows as any).loadRecord(res.runId);
  assert.equal(runRec.status, 'wait-input');
  assert.equal(runRec.arenas?.prd?.status, 'diverged');
  assert.ok(runRec.arenas?.prd?.divergenceSummary?.includes('monolithic desktop architecture'));
});

test('production product-spec workflow template validates with arena on prd step', () => {
  const { workflows } = makeHarness();
  const defPath = path.resolve(__dirname, '../../../workflows/product-spec.json');
  const raw = fs.readFileSync(defPath, 'utf-8');
  const def = JSON.parse(raw);
  const errors = workflows.validate(def);
  assert.deepEqual(errors, [], `product-spec.json has validation errors: ${errors.join(', ')}`);
});
