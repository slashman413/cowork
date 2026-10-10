import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const pexecFile = promisify(execFile);

/**
 * On-demand drill-down behind the Overview's CPU / GPU / Memory / Temp tiles.
 *
 * SystemMetrics (system-metrics.ts) keeps a cheap cached summary that the bar
 * polls every 3s; this module answers the heavier "what exactly is going on"
 * question only while a detail dialog is open. Like the summary sampler it is
 * best-effort: every source (/proc, /sys, lscpu, nvidia-smi, docker) may be
 * missing and the matching field just comes back null / empty.
 */

export type DetailKind = 'cpu' | 'gpu' | 'memory' | 'thermal';
export const DETAIL_KINDS = new Set<DetailKind>(['cpu', 'gpu', 'memory', 'thermal']);

export interface ProcRow {
  pid: number;
  name: string;
  /** Instantaneous CPU % over the sample window (100 = one full core). */
  cpu: number | null;
  rssMb: number | null;
  /** Docker container name when the process runs inside one. */
  container?: string;
  /** GPU memory in MB (GPU detail only). */
  gpuMemMb?: number | null;
}

const SAMPLE_MS = 400;
const TOP_N = 10;

// ── tiny helpers ────────────────────────────────────────────────────────────
function read(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function num(s: string | undefined | null): number | null {
  if (s == null) return null;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}
function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let clkTck: number | null = null;
async function ticksPerSec(): Promise<number> {
  if (clkTck) return clkTck;
  try { clkTck = num((await pexecFile('getconf', ['CLK_TCK'], { timeout: 2000 })).stdout) || 100; }
  catch { clkTck = 100; }
  return clkTck;
}

/** "Key:   123 kB" → { Key: 123 } for /proc/meminfo and /proc/<pid>/status. */
export function parseKbTable(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_()]+):\s+(\d+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// ── per-core CPU times ──────────────────────────────────────────────────────
/** Parse /proc/stat into per-core { total, idle } jiffies (aggregate line skipped). */
export function parseCoreTimes(stat: string): Map<number, { total: number; idle: number }> {
  const out = new Map<number, { total: number; idle: number }>();
  for (const line of stat.split('\n')) {
    const m = line.match(/^cpu(\d+)\s+(.*)$/);
    if (!m) continue;
    const parts = m[2].trim().split(/\s+/).map(Number);
    if (parts.length < 4 || parts.some(Number.isNaN)) continue;
    out.set(Number(m[1]), { total: parts.reduce((a, b) => a + b, 0), idle: parts[3] + (parts[4] || 0) });
  }
  return out;
}

// ── processes ───────────────────────────────────────────────────────────────
/** utime+stime ticks per pid, from /proc/<pid>/stat (comm may contain spaces/parens). */
function procTicks(): Map<number, { name: string; ticks: number }> {
  const out = new Map<number, { name: string; ticks: number }>();
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return out; }
  for (const pid of pids) {
    const s = read(`/proc/${pid}/stat`);
    if (!s) continue;
    const open = s.indexOf('('), close = s.lastIndexOf(')');
    if (open < 0 || close < 0) continue;
    const rest = s.slice(close + 2).split(' ');
    // rest[0] is field 3 (state) → utime = field 14 → rest[11], stime → rest[12]
    const ticks = (Number(rest[11]) || 0) + (Number(rest[12]) || 0);
    out.set(Number(pid), { name: s.slice(open + 1, close), ticks });
  }
  return out;
}

function rssMb(pid: number): number | null {
  const st = read(`/proc/${pid}/status`);
  if (!st) return null;
  const kb = parseKbTable(st).VmRSS;
  return kb == null ? null : round(kb / 1024, 0);
}

/** Docker container id (full hex) a pid belongs to, from its cgroup path. */
export function containerIdFromCgroup(cg: string): string | null {
  const m = cg.match(/docker[-/]([0-9a-f]{12,64})/);
  return m ? m[1] : null;
}

let containerCache: { at: number; names: Map<string, string> } | null = null;
async function containerNames(): Promise<Map<string, string>> {
  if (containerCache && Date.now() - containerCache.at < 30000) return containerCache.names;
  const names = new Map<string, string>();
  try {
    const { stdout } = await pexecFile('docker', ['ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}'], { timeout: 3000 });
    for (const line of stdout.trim().split('\n')) {
      const [id, name] = line.split(' ');
      if (id && name) names.set(id, name);
    }
  } catch { /* docker absent / no permission — no container labels */ }
  containerCache = { at: Date.now(), names };
  return names;
}

async function labelContainer(rows: ProcRow[]): Promise<void> {
  const names = await containerNames();
  if (!names.size) return;
  for (const r of rows) {
    const id = containerIdFromCgroup(read(`/proc/${r.pid}/cgroup`) || '');
    if (!id) continue;
    const name = names.get(id) || [...names.entries()].find(([full]) => full.startsWith(id))?.[1];
    if (name) r.container = name;
  }
}

/** Top processes by instantaneous CPU over the shared sample window. */
function topByCpu(
  before: Map<number, { name: string; ticks: number }>,
  after: Map<number, { name: string; ticks: number }>,
  seconds: number,
  hz: number,
): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const [pid, a] of after) {
    const b = before.get(pid);
    if (!b) continue;
    const d = a.ticks - b.ticks;
    if (d <= 0) continue;
    rows.push({ pid, name: a.name, cpu: round((d / hz / seconds) * 100), rssMb: null });
  }
  rows.sort((x, y) => (y.cpu || 0) - (x.cpu || 0));
  const top = rows.slice(0, TOP_N);
  for (const r of top) r.rssMb = rssMb(r.pid);
  return top;
}

function topByRss(): ProcRow[] {
  const rows: ProcRow[] = [];
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return rows; }
  for (const pid of pids) {
    const st = read(`/proc/${pid}/status`);
    if (!st) continue;
    const kb = parseKbTable(st).VmRSS;
    if (!kb) continue; // kernel threads have no VmRSS
    const name = (st.match(/^Name:\s+(.*)$/m) || [])[1] || '?';
    rows.push({ pid: Number(pid), name, cpu: null, rssMb: round(kb / 1024, 0) });
  }
  rows.sort((a, b) => (b.rssMb || 0) - (a.rssMb || 0));
  return rows.slice(0, TOP_N);
}

// ── CPU ─────────────────────────────────────────────────────────────────────
async function cpuModels(): Promise<{ model: string; count: number }[]> {
  try {
    const { stdout } = await pexecFile('lscpu', ['-p=CPU,MODELNAME'], { timeout: 3000 });
    const counts = new Map<string, number>();
    for (const line of stdout.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const model = line.split(',').slice(1).join(',').trim() || 'CPU';
      counts.set(model, (counts.get(model) || 0) + 1);
    }
    if (counts.size) return [...counts].map(([model, count]) => ({ model, count }));
  } catch { /* fall back to os.cpus() */ }
  const cpus = os.cpus();
  return cpus.length ? [{ model: cpus[0].model || 'CPU', count: cpus.length }] : [];
}

async function cpuDetails() {
  const hz = await ticksPerSec();
  const stat0 = read('/proc/stat') || '';
  const p0 = procTicks();
  const t0 = Date.now();
  await sleep(SAMPLE_MS);
  const stat1 = read('/proc/stat') || '';
  const p1 = procTicks();
  const secs = (Date.now() - t0) / 1000;

  const c0 = parseCoreTimes(stat0), c1 = parseCoreTimes(stat1);
  const cores = [...c1.keys()].sort((a, b) => a - b).map((id) => {
    const a = c0.get(id), b = c1.get(id)!;
    const dT = a ? b.total - a.total : 0, dI = a ? b.idle - a.idle : 0;
    const khz = num(read(`/sys/devices/system/cpu/cpu${id}/cpufreq/scaling_cur_freq`));
    return {
      id,
      usage: dT > 0 ? round(Math.min(100, Math.max(0, (1 - dI / dT) * 100))) : null,
      mhz: khz == null ? null : Math.round(khz / 1000),
    };
  });

  const la = (read('/proc/loadavg') || '').trim().split(/\s+/);
  const [running, total] = (la[3] || '').split('/').map(Number);
  const processes = topByCpu(p0, p1, secs, hz);
  await labelContainer(processes);

  return {
    kind: 'cpu' as const,
    models: await cpuModels(),
    arch: os.arch(),
    cores,
    load: { m1: num(la[0]), m5: num(la[1]), m15: num(la[2]) },
    tasks: { running: Number.isFinite(running) ? running : null, total: Number.isFinite(total) ? total : null },
    uptimeSec: Math.round(os.uptime()),
    processes,
  };
}

// ── Memory ──────────────────────────────────────────────────────────────────
async function memoryDetails() {
  const kb = parseKbTable(read('/proc/meminfo') || '');
  const mb = (k: string) => (kb[k] == null ? null : round(kb[k] / 1024, 0));
  const total = mb('MemTotal'), avail = mb('MemAvailable');
  const processes = topByRss();
  await labelContainer(processes);
  // On unified-memory parts (DGX Spark GB10) GPU allocations come out of system
  // RAM but are NOT in any process's RSS — without this the top-RSS list can't
  // explain where most of "used" went.
  const apps = await gpuApps();
  const gpuMb = apps.reduce((a, r) => a + (r.gpuMemMb || 0), 0);
  return {
    kind: 'memory' as const,
    gpuAllocatedMb: apps.length ? gpuMb : null,
    totalMb: total,
    usedMb: total != null && avail != null ? total - avail : null,
    availableMb: avail,
    freeMb: mb('MemFree'),
    buffersMb: mb('Buffers'),
    cachedMb: mb('Cached'),
    shmemMb: mb('Shmem'),
    reclaimableMb: mb('SReclaimable'),
    dirtyMb: mb('Dirty'),
    committedMb: mb('Committed_AS'),
    swap: { totalMb: mb('SwapTotal'), freeMb: mb('SwapFree') },
    hugePages: { total: kb.HugePages_Total ?? null, free: kb.HugePages_Free ?? null },
    processes,
  };
}

// ── GPU ─────────────────────────────────────────────────────────────────────
/** Processes holding GPU memory, largest first (empty without nvidia-smi). */
async function gpuApps(): Promise<ProcRow[]> {
  try {
    const { stdout } = await pexecFile('nvidia-smi',
      ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'], { timeout: 5000 });
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [pid, name, mem] = line.split(',').map((s) => s.trim());
      return { pid: Number(pid), name: (name || '?').split('/').pop() || '?', cpu: null,
               rssMb: rssMb(Number(pid)), gpuMemMb: num(mem) };
    }).sort((a, b) => (b.gpuMemMb || 0) - (a.gpuMemMb || 0));
  } catch { return []; }
}

const GPU_FIELDS = [
  'index', 'name', 'uuid', 'driver_version', 'pstate', 'utilization.gpu', 'utilization.memory',
  'memory.used', 'memory.total', 'temperature.gpu', 'power.draw', 'power.limit',
  'clocks.sm', 'clocks.max.sm', 'clocks.mem', 'fan.speed', 'compute_mode',
] as const;

/** nvidia-smi CSV row → object; "[N/A]" / "N/A" / "[Not Supported]" become null. */
export function parseGpuRow(row: string): Record<string, string | number | null> {
  const cells = row.split(',').map((s) => s.trim());
  const out: Record<string, string | number | null> = {};
  GPU_FIELDS.forEach((f, i) => {
    const v = cells[i];
    if (v == null || /^\[?(N\/A|Not Supported)\]?$/i.test(v) || v === '') { out[f] = null; return; }
    const n = Number(v);
    out[f] = ['name', 'uuid', 'driver_version', 'pstate', 'compute_mode'].includes(f) || !Number.isFinite(n) ? v : n;
  });
  return out;
}

async function gpuDetails() {
  let gpus: Record<string, string | number | null>[] = [];
  let processes: ProcRow[] = [];
  let error: string | null = null;
  try {
    const { stdout } = await pexecFile('nvidia-smi',
      [`--query-gpu=${GPU_FIELDS.join(',')}`, '--format=csv,noheader,nounits'], { timeout: 5000 });
    gpus = stdout.trim().split('\n').filter(Boolean).map(parseGpuRow);
  } catch (e: any) {
    error = e?.code === 'ENOENT' ? 'nvidia-smi not found' : 'nvidia-smi failed';
  }
  if (gpus.length) {
    processes = await gpuApps();
    await labelContainer(processes);
  }
  // Unified-memory parts (e.g. DGX Spark GB10) report memory.total as N/A: the
  // GPU draws from system RAM, so point the UI at the host memory instead.
  const unified = gpus.length > 0 && gpus.every((g) => g['memory.total'] == null);
  return { kind: 'gpu' as const, gpus, processes, unifiedMemory: unified, error };
}

// ── Thermal ─────────────────────────────────────────────────────────────────
async function thermalDetails() {
  const zones: { zone: string; type: string; celsius: number }[] = [];
  const base = '/sys/class/thermal';
  let names: string[] = [];
  try { names = fs.readdirSync(base).filter((z) => z.startsWith('thermal_zone')); } catch { /* none */ }
  for (const z of names.sort((a, b) => Number(a.slice(12)) - Number(b.slice(12)))) {
    const milli = num(read(`${base}/${z}/temp`));
    if (milli == null || milli <= 0) continue;
    zones.push({ zone: z, type: (read(`${base}/${z}/type`) || '?').trim(), celsius: round(milli / 1000) });
  }
  let gpus: { index: number; name: string; celsius: number | null }[] = [];
  try {
    const { stdout } = await pexecFile('nvidia-smi',
      ['--query-gpu=index,name,temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 5000 });
    gpus = stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [i, name, t] = l.split(',').map((s) => s.trim());
      return { index: Number(i), name, celsius: num(t) };
    });
  } catch { /* no GPU */ }
  return { kind: 'thermal' as const, zones, gpus };
}

export async function systemDetails(kind: DetailKind) {
  const at = new Date().toISOString();
  switch (kind) {
    case 'cpu': return { at, ...(await cpuDetails()) };
    case 'gpu': return { at, ...(await gpuDetails()) };
    case 'memory': return { at, ...(await memoryDetails()) };
    case 'thermal': return { at, ...(await thermalDetails()) };
  }
}
