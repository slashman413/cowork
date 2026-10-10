import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoreTimes, parseKbTable, parseGpuRow, containerIdFromCgroup, systemDetails } from './system-details.js';

test('parseCoreTimes skips the aggregate line and sums idle+iowait', () => {
  const m = parseCoreTimes('cpu  10 0 10 80 0 0 0\ncpu0 1 0 1 7 1 0 0\ncpu1 2 0 2 6 0 0 0\nintr 5');
  assert.deepEqual([...m.keys()], [0, 1]);
  assert.deepEqual(m.get(0), { total: 10, idle: 8 });
});

test('parseKbTable reads meminfo-style lines', () => {
  const t = parseKbTable('MemTotal:       124544000 kB\nHugePages_Total:       0\nNoNumber: x');
  assert.equal(t.MemTotal, 124544000);
  assert.equal(t.HugePages_Total, 0);
  assert.equal(t.NoNumber, undefined);
});

test('parseGpuRow maps N/A to null and keeps strings', () => {
  const g = parseGpuRow('0, NVIDIA GB10, GPU-abc, 580.1, P0, 3, 0, [N/A], [N/A], 44, 10.82, [N/A], 2411, 3003, [N/A], [Not Supported], Default');
  assert.equal(g.name, 'NVIDIA GB10');
  assert.equal(g['memory.total'], null);
  assert.equal(g['fan.speed'], null);
  assert.equal(g['power.draw'], 10.82);
  assert.equal(g.driver_version, '580.1');
});

test('containerIdFromCgroup handles systemd and cgroupfs docker paths', () => {
  assert.equal(containerIdFromCgroup('0::/system.slice/docker-a839f4596571abc.scope'), 'a839f4596571abc');
  assert.equal(containerIdFromCgroup('0::/docker/a839f4596571abc'), 'a839f4596571abc');
  assert.equal(containerIdFromCgroup('0::/user.slice'), null);
});

test('every detail kind returns without throwing on this host', async () => {
  for (const kind of ['cpu', 'memory', 'gpu', 'thermal'] as const) {
    const d: any = await systemDetails(kind);
    assert.equal(d.kind, kind);
    assert.ok(d.at);
  }
});
