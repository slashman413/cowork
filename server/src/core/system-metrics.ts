import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';

/**
 * Host system-load sampler for the dashboard's top-of-page metrics bar.
 *
 * Everything is best-effort and degrades gracefully: on a host where /proc is
 * absent (non-Linux) or nvidia-smi isn't installed, the corresponding field is
 * simply null instead of throwing. A background timer refreshes a cached
 * snapshot so the HTTP endpoint is O(1) and CPU% is a smooth delta over the
 * sample window rather than a per-request spike.
 */

export interface GpuInfo {
  index: number;
  name: string;
  /** Percent 0–100, or null if unavailable. */
  utilization: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  /** Degrees Celsius, or null. */
  temperature: number | null;
}

export interface SystemSnapshot {
  timestamp: string;
  cpu: {
    /** Percent 0–100 busy over the last sample window, or null. */
    usage: number | null;
    cores: number;
    /** 1-minute load average, or null on platforms without it. */
    load1: number | null;
    /** Package/core temperature in °C, or null. */
    temperature: number | null;
  };
  memory: {
    usedMb: number | null;
    totalMb: number | null;
    /** Percent 0–100 used, or null. */
    usage: number | null;
  };
  /** Per-GPU detail (empty when no NVIDIA GPU / nvidia-smi is present). */
  gpus: GpuInfo[];
  /** Aggregate over all GPUs for the summary tile, or null when none. */
  gpu: {
    usage: number | null;
    memoryUsedMb: number | null;
    memoryTotalMb: number | null;
    temperature: number | null;
  } | null;
  /** Root filesystem (`/`) capacity in GB, or null fields when statfs fails. */
  disk: {
    mount: string;
    usedGb: number | null;
    totalGb: number | null;
    /** Percent 0–100 used (of the space non-root users can get), or null. */
    usage: number | null;
  };
  platform: string;
}

interface CpuTimes { total: number; idle: number; }

export class SystemMetrics {
  private snapshot: SystemSnapshot;
  private prevCpu: CpuTimes | null = null;
  private gpus: GpuInfo[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(intervalMs = 2000) {
    this.intervalMs = intervalMs;
    this.snapshot = this.empty();
    // Seed the CPU baseline so the first refresh already has a delta to work with.
    this.prevCpu = this.readCpuTimes();
  }

  start(): void {
    if (this.timer) return;
    // GPU is polled asynchronously; kick one off immediately so the first
    // HTTP hit isn't empty, then refresh on the interval.
    this.refreshGpu();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get(): SystemSnapshot {
    return this.snapshot;
  }

  private empty(): SystemSnapshot {
    return {
      timestamp: new Date().toISOString(),
      cpu: { usage: null, cores: os.cpus().length || 0, load1: null, temperature: null },
      memory: { usedMb: null, totalMb: null, usage: null },
      gpus: [],
      gpu: null,
      disk: { mount: '/', usedGb: null, totalGb: null, usage: null },
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
    };
  }

  /** Recompute the CPU/memory/temperature parts synchronously (cheap fs reads). */
  private refresh(): void {
    const cpu = this.sampleCpu();
    const memory = this.sampleMemory();
    const temperature = this.readCpuTemp();
    const load = os.loadavg?.() || [];

    const gpuAgg = this.gpus.length
      ? {
          usage: avg(this.gpus.map(g => g.utilization)),
          memoryUsedMb: sum(this.gpus.map(g => g.memoryUsedMb)),
          memoryTotalMb: sum(this.gpus.map(g => g.memoryTotalMb)),
          temperature: max(this.gpus.map(g => g.temperature)),
        }
      : null;

    this.snapshot = {
      timestamp: new Date().toISOString(),
      cpu: {
        usage: cpu,
        cores: os.cpus().length || 0,
        load1: load.length ? round(load[0], 2) : null,
        temperature,
      },
      memory,
      gpus: this.gpus,
      gpu: gpuAgg,
      disk: sampleDisk('/'),
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
    };
  }

  // ── CPU ────────────────────────────────────────────────────────────────
  private readCpuTimes(): CpuTimes | null {
    try {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      if (parts.length < 4 || parts.some(Number.isNaN)) return null;
      const idle = parts[3] + (parts[4] || 0); // idle + iowait
      const total = parts.reduce((a, b) => a + b, 0);
      return { total, idle };
    } catch {
      return null;
    }
  }

  private sampleCpu(): number | null {
    const now = this.readCpuTimes();
    if (!now || !this.prevCpu) { if (now) this.prevCpu = now; return null; }
    const dTotal = now.total - this.prevCpu.total;
    const dIdle = now.idle - this.prevCpu.idle;
    this.prevCpu = now;
    if (dTotal <= 0) return null;
    return round(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)), 1);
  }

  // ── Memory ───────────────────────────────────────────────────────────────
  private sampleMemory(): SystemSnapshot['memory'] {
    try {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = (key: string) => {
        const m = info.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
        return m ? Number(m[1]) : null;
      };
      const totalKb = kb('MemTotal');
      const availKb = kb('MemAvailable');
      if (totalKb != null && availKb != null) {
        const usedMb = round((totalKb - availKb) / 1024, 0);
        const totalMb = round(totalKb / 1024, 0);
        return { usedMb, totalMb, usage: round(((totalKb - availKb) / totalKb) * 100, 1) };
      }
    } catch { /* fall through to os.* */ }
    // Fallback: os.freemem() excludes reclaimable cache so it over-reports "used",
    // but it's the best we can do off /proc.
    const total = os.totalmem();
    const free = os.freemem();
    if (!total) return { usedMb: null, totalMb: null, usage: null };
    return {
      usedMb: round((total - free) / 1048576, 0),
      totalMb: round(total / 1048576, 0),
      usage: round(((total - free) / total) * 100, 1),
    };
  }

  // ── Temperature ────────────────────────────────────────────────────────
  private readCpuTemp(): number | null {
    try {
      const base = '/sys/class/thermal';
      const zones = fs.readdirSync(base).filter(z => z.startsWith('thermal_zone'));
      let best: number | null = null;
      let fallbackMax: number | null = null;
      for (const z of zones) {
        let type = '';
        try { type = fs.readFileSync(`${base}/${z}/type`, 'utf8').trim(); } catch { /* ignore */ }
        let milli: number;
        try { milli = Number(fs.readFileSync(`${base}/${z}/temp`, 'utf8').trim()); } catch { continue; }
        if (!Number.isFinite(milli) || milli <= 0) continue;
        const c = milli / 1000;
        if (fallbackMax == null || c > fallbackMax) fallbackMax = c;
        // Prefer a zone that clearly represents the CPU package/cores.
        if (best == null && /cpu|x86_pkg|coretemp|soc|package|tdie|tctl/i.test(type)) best = c;
      }
      const t = best ?? fallbackMax;
      return t == null ? null : round(t, 1);
    } catch {
      return null;
    }
  }

  // ── GPU (nvidia-smi) ──────────────────────────────────────────────────────
  private refreshGpu(): void {
    execFile(
      'nvidia-smi',
      ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 4000 },
      (err, stdout) => {
        // Re-arm the next GPU poll regardless of outcome, aligned to the interval.
        setTimeout(() => this.refreshGpu(), this.intervalMs).unref?.();
        if (err || !stdout) { this.gpus = []; return; }
        try {
          this.gpus = stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((row) => {
              const [index, name, util, memUsed, memTotal, temp] = row.split(',').map(s => s.trim());
              return {
                index: numOrNull(index) ?? 0,
                name: name || 'GPU',
                utilization: numOrNull(util),
                memoryUsedMb: numOrNull(memUsed),
                memoryTotalMb: numOrNull(memTotal),
                temperature: numOrNull(temp),
              } as GpuInfo;
            });
        } catch {
          this.gpus = [];
        }
      }
    );
  }
}

// ── Disk (statfs, cheap) ─────────────────────────────────────────────────────
/** Capacity of the filesystem holding `mount`, `df`-style (used = total − free,
 *  usage % against used + available so the root-reserved blocks count as full). */
export function sampleDisk(mount: string): SystemSnapshot['disk'] {
  try {
    const st = fs.statfsSync(mount);
    const total = st.blocks * st.bsize;
    const used = (st.blocks - st.bfree) * st.bsize;
    const avail = st.bavail * st.bsize;
    if (!total) return { mount, usedGb: null, totalGb: null, usage: null };
    return {
      mount,
      usedGb: round(used / 1073741824, 1),
      totalGb: round(total / 1073741824, 1),
      usage: used + avail > 0 ? round((used / (used + avail)) * 100, 1) : null,
    };
  } catch {
    return { mount, usedGb: null, totalGb: null, usage: null };
  }
}

// ── small numeric helpers ───────────────────────────────────────────────────
function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
function numOrNull(s: string | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function avg(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 1) : null;
}
function sum(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? round(v.reduce((a, b) => a + b, 0), 0) : null;
}
function max(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.max(...v) : null;
}
