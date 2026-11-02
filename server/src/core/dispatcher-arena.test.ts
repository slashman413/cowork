import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArena, pickArenaBrains, arenaPlan } from './pstack-gates.js';
import { pstackHarness, BRAINS } from './pstack-test-harness.js';
import { brainFamily } from './tiers.js';

/** G6: arena re-homed as a task fan-out (runners + judge + synthesis via dependsOn). */
test('parseArena normalises true / number / object and clamps runners to 2..5', () => {
  assert.equal(parseArena(undefined), null);
  assert.equal(parseArena(false), null);
  assert.equal(parseArena(true)!.runners, 3);
  assert.equal(parseArena(9)!.runners, 5);
  assert.equal(parseArena({ runners: 1, rubric: 'speed' })!.runners, 2);
  assert.equal(parseArena({ rubric: 'speed' })!.rubric, 'speed');
  assert.equal(parseArena('yes'), null);
});

test('pickArenaBrains prefers distinct families from the tiers', () => {
  const tiers = { judgment: ['local-cc-opus-5-5'], standard: ['local-agy-gemini-4-argon-medium'], mechanical: ['local-agy-gemini-3.8-flash-high', 'local-dsh-qwen3-8-27b'] };
  const out = pickArenaBrains(3, tiers, BRAINS, id => brainFamily(BRAINS[id], id));
  assert.deepEqual(out, ['local-cc-opus-5-5', 'local-agy-gemini-4-argon-medium', 'local-dsh-qwen3-8-27b']);
});

test('arenaPlan strips arena/brain keys from children so they never recurse', () => {
  const p = arenaPlan({ id: 'p', title: 'T', description: 'D', context: { arena: true, brain: 'x', playbook: 'feature' } } as any, { runners: 2, rubric: 'r' }, ['a', 'b']);
  assert.equal(p.runners.length, 2);
  assert.equal(p.runners[0].context.brain, 'a');
  assert.equal((p.runners[0].context as any).arena, undefined);
  assert.equal(p.runners[0].context.playbook, 'feature');
  assert.match(p.judge.description, /Rubric: r/);
});

test('dispatcher tick: context.arena spawns runners + judge and the parent waits on them', async () => {
  const h = pstackHarness({ enabled: true });
  const parent = h.mk({ agent: 'engineer', arena: { runners: 3 } }, 'Write the plan');
  const ran: string[] = [];
  (h.dispatcher as any).agentId = 'disp';
  (h.dispatcher as any).execute = async (t: any) => { ran.push(t.id); };
  (h.dispatcher as any).tick();
  const p = h.store.getTask(parent.id)!;
  const kids = p.context!.arenaChildren as any;
  assert.equal(kids.runners.length, 3);
  assert.ok(kids.judge);
  assert.deepEqual(p.context!.dependsOn, [...kids.runners, kids.judge]);
  assert.ok(!ran.includes(parent.id), 'parent not executed before its children');
  const judge = h.store.getTask(kids.judge)!;
  assert.deepEqual(judge.context!.dependsOn, kids.runners);
  const brains = kids.runners.map((id: string) => h.store.getTask(id)!.context!.brain);
  assert.equal(new Set(brains).size, 3, 'each runner pinned to a different brain');
  // second tick does not spawn again
  (h.dispatcher as any).tick();
  assert.equal(h.store.listTasks({}).filter(t => t.context?.arenaRole === 'judge').length, 1);
});
