import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeClaudeUsage, normalizeCodexRateLimits, normalizeAgyQuota, isMeteredExec, findRateLimitsSnapshot, discoverAgyRefreshToken, readCachedAgyToken } from './usage-probe.js';

// Shape captured from a live GET /api/oauth/usage response (values trimmed).
const CLAUDE_LIVE_SHAPE = {
  five_hour: { utilization: 8.0, resets_at: '2026-08-06T05:40:00.494068+00:00' },
  seven_day: null,
  limits: [
    { kind: 'session', group: 'session', percent: 8, severity: 'normal', resets_at: '2026-08-06T05:40:00.494068+00:00', scope: null, is_active: true }
  ]
};

test('claude: prefers limits[] and maps session → 5h with reset', () => {
  const w = normalizeClaudeUsage(CLAUDE_LIVE_SHAPE);
  assert.deepEqual(w, [{ label: '5h', usedPct: 8, resetsAt: '2026-08-06T05:40:00.494068+00:00' }]);
});

test('claude: maps weekly kinds and skips inactive limits', () => {
  const w = normalizeClaudeUsage({
    limits: [
      { kind: 'session', percent: 12.34, resets_at: 'A', is_active: true },
      { kind: 'weekly', percent: 55, resets_at: 'B', is_active: true },
      { kind: 'seven_day_opus', percent: 90, resets_at: 'C', is_active: false }
    ]
  });
  assert.deepEqual(w.map(x => x.label), ['5h', '7d']);
  assert.equal(w[0].usedPct, 12.3);
});

test('claude: weekly_all is the same weekly cap as weekly/7d and does not duplicate', () => {
  // The usage payload lists BOTH `weekly` and `weekly_all` for the same weekly
  // window; they must collapse to a single 7d meter (first writer wins), not
  // surface a redundant raw `weekly_all` row.
  const w = normalizeClaudeUsage({
    limits: [
      { kind: 'session', percent: 8, resets_at: 'A', is_active: true },
      { kind: 'weekly', percent: 55, resets_at: 'B', is_active: true },
      { kind: 'weekly_all', percent: 55, resets_at: 'B', is_active: true }
    ]
  });
  assert.deepEqual(w.map(x => x.label), ['5h', '7d']);
});

test('claude: merges 5h from top-level five_hour when limits[] carries only weekly', () => {
  // A plan with weekly caps: limits[] lists ONLY the weekly limit; the 5h
  // session lives solely at the top-level five_hour. Both meters must surface,
  // 5h ordered first — the old limits[]-only path dropped the 5h meter here.
  const w = normalizeClaudeUsage({
    five_hour: { utilization: 12, resets_at: 'FIVE' },
    seven_day: null,
    limits: [{ kind: 'weekly', percent: 55, resets_at: 'WEEK', is_active: true }]
  });
  assert.deepEqual(w, [
    { label: '5h', usedPct: 12, resetsAt: 'FIVE' },
    { label: '7d', usedPct: 55, resetsAt: 'WEEK' }
  ]);
});

test('claude: limits[] wins over a duplicate top-level window (no double row)', () => {
  const w = normalizeClaudeUsage({
    five_hour: { utilization: 99, resets_at: 'TOP' },
    limits: [{ kind: 'session', percent: 8, resets_at: 'AUTH', is_active: true }]
  });
  assert.deepEqual(w, [{ label: '5h', usedPct: 8, resetsAt: 'AUTH' }]);
});

test('claude: falls back to five_hour/seven_day objects when limits[] is absent', () => {
  const w = normalizeClaudeUsage({
    five_hour: { utilization: 40, resets_at: 'X' },
    seven_day: { utilization: 71.5, resets_at: 'Y' }
  });
  assert.deepEqual(w, [
    { label: '5h', usedPct: 40, resetsAt: 'X' },
    { label: '7d', usedPct: 71.5, resetsAt: 'Y' }
  ]);
});

test('claude: fallback picks up ANY utilization-bearing window key (weekly variants)', () => {
  const w = normalizeClaudeUsage({
    five_hour: { utilization: 40, resets_at: 'X' },
    seven_day: { utilization: 71.5, resets_at: 'Y' },
    seven_day_opus: { utilization: 12, resets_at: 'Z' },
    seven_day_oauth_apps: null,                          // null windows skipped
    member_dashboard_available: false                    // non-window keys skipped
  });
  assert.deepEqual(w.map(x => [x.label, x.usedPct]), [['5h', 40], ['7d', 71.5], ['7d-opus', 12]]);
});

test('claude: appends the extra-usage credits row on both paths; caps at 8 windows', () => {
  const extra = { is_enabled: true, utilization: 94.88 };
  // limits[] path (the live shape) still gets the credits row appended.
  const a = normalizeClaudeUsage({ ...CLAUDE_LIVE_SHAPE, extra_usage: extra });
  assert.deepEqual(a.map(x => x.label), ['5h', 'credits']);
  assert.equal(a[1].usedPct, 94.9);
  // fallback path too, and disabled/garbage credit blocks are ignored.
  const b = normalizeClaudeUsage({ five_hour: { utilization: 10 }, extra_usage: extra });
  assert.deepEqual(b.map(x => x.label), ['5h', 'credits']);
  assert.deepEqual(normalizeClaudeUsage({ five_hour: { utilization: 10 }, extra_usage: { is_enabled: false, utilization: 50 } }).map(x => x.label), ['5h']);
  // cap: 9 window keys + credits → 8 rows total (heartbeat schema max).
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`seven_day_v${i}`, { utilization: i }]));
  assert.equal(normalizeClaudeUsage({ ...many, extra_usage: extra }).length, 8);
});

test('claude: ignores Anthropic internal A/B codename buckets (no garbage rows)', () => {
  // Captured from a real GET /api/oauth/usage: alongside the genuine windows the
  // payload carries rotating experimental buckets under codename keys, some with
  // a utilization (nimbus_quill:0). Those are NOT user quotas and must not leak
  // into the meters — only 5h + credits should surface here.
  const w = normalizeClaudeUsage({
    five_hour: { utilization: 15, resets_at: '2026-08-08T19:30:00Z' },
    seven_day: null, seven_day_opus: null, seven_day_sonnet: null,
    tangelo: null, iguana_necktie: null,
    nimbus_quill: { utilization: 0, resets_at: null },
    cinder_cove: null, amber_ladder: null, omelette_promotional: null,
    extra_usage: { is_enabled: true, utilization: 100 },
    limits: [{ kind: 'session', percent: 15, is_active: true, resets_at: '2026-08-08T19:30:00Z' }],
    spend: { percent: 100 }, member_dashboard_available: false
  });
  assert.deepEqual(w.map(x => x.label), ['5h', 'credits']);
});

test('claude: clamps out-of-range percents and returns [] on garbage', () => {
  assert.deepEqual(normalizeClaudeUsage({ limits: [{ kind: 'session', percent: 250, is_active: true }] })[0].usedPct, 100);
  assert.deepEqual(normalizeClaudeUsage(null), []);
  assert.deepEqual(normalizeClaudeUsage({ limits: [{ kind: 'session', percent: 'nope' }] }), []);
});

test('codex: maps primary/secondary windows with absolute reset times', () => {
  const at = Date.parse('2026-08-06T00:00:00Z');
  const w = normalizeCodexRateLimits({
    primary: { used_percent: 62.5, window_minutes: 300, resets_in_seconds: 3600 },
    secondary: { used_percent: 21, window_minutes: 10080, resets_in_seconds: 86400 }
  }, at);
  assert.deepEqual(w, [
    { label: '5h', usedPct: 62.5, resetsAt: '2026-08-06T01:00:00.000Z' },
    { label: '7d', usedPct: 21, resetsAt: '2026-08-07T00:00:00.000Z' }
  ]);
});

test('codex: unusual window sizes get derived labels; missing fields are skipped', () => {
  const w = normalizeCodexRateLimits({
    primary: { used_percent: 10, window_minutes: 60 },
    secondary: { window_minutes: 10080 }   // no used_percent → skipped
  }, 0);
  assert.deepEqual(w, [{ label: '1h', usedPct: 10, resetsAt: undefined }]);
});

test('agy: inverts remaining→used, keeps remainingPct, and derives labels from grouped buckets', () => {
  // Shape mirrors retrieveUserQuotaSummary: buckets nested under a group,
  // each carrying a REMAINING percent (the CLI renders "%.0f%% remaining").
  const w = normalizeAgyQuota({
    quotaSummaryGroups: [{
      quotaSummaryBuckets: [
        { remaining: 82, windowMinutes: 300, resetTime: '2026-08-06T05:00:00Z' },
        { remaining: 40.5, windowMinutes: 10080, resetTime: '2026-08-13T00:00:00Z' }
      ]
    }]
  });
  assert.deepEqual(w, [
    { label: '5h', usedPct: 18, resetsAt: '2026-08-06T05:00:00Z', remainingPct: 82 },
    { label: '7d', usedPct: 59.5, resetsAt: '2026-08-13T00:00:00Z', remainingPct: 40.5 }
  ]);
});

test('agy: real schema — remainingFraction, groups, member models, disabled 5h bucket', () => {
  // Mirrors the live retrieveUserQuotaSummary: two model-groups, each with a
  // 7d + 5h bucket reporting a *fraction* (0–1) left; the Claude/GPT group has
  // hit its weekly cap (0% left) so its 5h bucket is disabled.
  const w = normalizeAgyQuota({
    quotaSummaryGroups: [
      {
        groupName: 'Gemini Models',
        modelDisplayNames: ['Gemini Flash', 'Gemini Pro'],
        quotaSummaryBuckets: [
          { remainingFraction: 0.7415, minutesPerBucket: 10080, resetTime: '2026-08-13T00:00:00Z' },
          { remainingFraction: 0.9161, movingWindowSize: '18000s', resetTime: '2026-08-11T06:00:00Z' }
        ]
      },
      {
        groupName: 'Claude and GPT Models',
        models: [{ displayName: 'Claude Opus' }, { displayName: 'Claude Sonnet' }, { displayName: 'GPT-OSS' }],
        quotaSummaryBuckets: [
          { remainingFraction: 0, minutesPerBucket: 10080, resetTime: '2026-08-15T00:00:00Z' },
          { minutesPerBucket: 300, disabled: true, disabledMessage: 'Disabled: You have hit your weekly limit, the 5-hour limit does not currently apply.' }
        ]
      }
    ]
  });
  assert.equal(w.length, 4);
  assert.deepEqual(w[0], {
    label: '7d', usedPct: 25.8, resetsAt: '2026-08-13T00:00:00Z', remainingPct: 74.2,
    group: 'Gemini Models', groupModels: ['Gemini Flash', 'Gemini Pro']
  });
  assert.equal(w[1].label, '5h');            // 18000s = 300min → 5h
  assert.equal(w[1].remainingPct, 91.6);
  assert.equal(w[2].remainingPct, 0);        // weekly cap hit
  assert.equal(w[2].group, 'Claude and GPT Models');
  assert.deepEqual(w[2].groupModels, ['Claude Opus', 'Claude Sonnet', 'GPT-OSS']);
  assert.equal(w[3].label, '5h');
  assert.equal(w[3].remainingPct, undefined);
  assert.match(w[3].disabledNote, /5-hour limit does not currently apply/);
  assert.equal(w[3].usedPct, 100);
});

test('agy: live daily schema — window strings, models in group description, disabled bucket keeps no bar', () => {
  // Exact shape of the Antigravity CLI's retrieveUserQuotaSummary (daily host):
  // `window` is a STRING ("weekly"/"5h"), member models are named inline in the
  // group `description`, and the Claude/GPT 5h bucket is disabled yet still
  // reports remainingFraction:1 — which must NOT render as a 100% bar.
  const w = normalizeAgyQuota({
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-08-13T06:16:47Z', remainingFraction: 0.7415407 },
          { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-08-11T15:44:38Z', remainingFraction: 1 }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-08-15T15:34:06Z', remainingFraction: 0 },
          { bucketId: '3p-5h', window: '5h', resetTime: '2026-08-11T15:44:38Z', disabled: true, remainingFraction: 1,
            description: 'You have hit your weekly limit, the 5-hour limit does not currently apply.' }
        ]
      }
    ]
  });
  assert.equal(w.length, 4);
  assert.deepEqual(w[0], {
    label: '7d', usedPct: 25.8, resetsAt: '2026-08-13T06:16:47Z', remainingPct: 74.2,
    group: 'Gemini Models', groupModels: ['Gemini Flash', 'Gemini Pro']
  });
  assert.equal(w[1].label, '5h');
  assert.equal(w[1].remainingPct, 100);
  assert.equal(w[2].label, '7d');
  assert.equal(w[2].remainingPct, 0);        // 3p weekly cap hit
  assert.deepEqual(w[2].groupModels, ['Claude Opus', 'Claude Sonnet', 'GPT-OSS']);
  assert.equal(w[3].label, '5h');
  assert.equal(w[3].remainingPct, undefined, 'disabled 5h bucket must not carry a remaining bar');
  assert.match(w[3].disabledNote, /5-hour limit does not currently apply/);
});

test('agy: readCachedAgyToken honours nested antigravity + flat gemini shapes and expiry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tok-'));
  try {
    const f = (name: string, obj: unknown) => {
      const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(obj)); return p;
    };
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    // Antigravity CLI nested shape with an RFC3339 expiry string.
    assert.equal(readCachedAgyToken(f('agy.json', { token: { access_token: 'agy-live', expiry: future }, auth_method: 'consumer' })), 'agy-live');
    assert.equal(readCachedAgyToken(f('agy-exp.json', { token: { access_token: 'agy-dead', expiry: past } })), null);
    // gemini-cli flat shape with an epoch-ms expiry_date.
    assert.equal(readCachedAgyToken(f('gem.json', { access_token: 'gem-live', expiry_date: Date.now() + 3600_000 })), 'gem-live');
    assert.equal(readCachedAgyToken(f('gem-exp.json', { access_token: 'gem-dead', expiry_date: Date.now() - 60_000 })), null);
    // No expiry → treated as usable.
    assert.equal(readCachedAgyToken(f('noexp.json', { token: { access_token: 'agy-noexp' } })), 'agy-noexp');
    assert.equal(readCachedAgyToken(path.join(dir, 'missing.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agy: accepts flat buckets, alias fields, and slug labels; clamps + skips garbage', () => {
  const w = normalizeAgyQuota({
    buckets: [
      { percentRemaining: 100, displayName: 'Gemini 3 Pro Requests' }, // used 0, name slug
      { remaining: -5 },                                               // used clamps to 100
      { displayName: 'no-remaining-field' }                            // skipped (no remaining, not disabled)
    ]
  });
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { label: 'Gemini 3 Pro', usedPct: 0, resetsAt: undefined, remainingPct: 100 });
  assert.equal(w[1].usedPct, 100);
  assert.equal(w[1].remainingPct, 0);
  assert.deepEqual(normalizeAgyQuota(null), []);
});

test('codex: finds rate_limits regardless of rollout nesting (version drift)', () => {
  const snap = { primary: { used_percent: 5, window_minutes: 300 } };
  // (a) modern shape: payload.rate_limits
  assert.equal(findRateLimitsSnapshot({ type: 'event_msg', payload: { type: 'token_count', rate_limits: snap } }), snap);
  // (b) legacy Event{id,msg} wrapper: payload.msg.rate_limits — the path the
  //     old hard-coded probe missed, leaving the codex meter permanently empty.
  assert.equal(findRateLimitsSnapshot({ type: 'event_msg', payload: { msg: { type: 'token_count', rate_limits: snap } } }), snap);
  // (c) top-level rate_limits
  assert.equal(findRateLimitsSnapshot({ rate_limits: snap }), snap);
  // A bare {} rate_limits with no primary/secondary is not a usable snapshot.
  assert.equal(findRateLimitsSnapshot({ payload: { rate_limits: {} } }), null);
  assert.equal(findRateLimitsSnapshot({ type: 'response_item', payload: { text: 'hi' } }), null);
  assert.equal(findRateLimitsSnapshot(null), null);
});

test('agy: discovers a refresh token from user_refresh.antigravity or oauth_creds.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
  const gemini = path.join(home, '.gemini');
  fs.mkdirSync(gemini, { recursive: true });
  try {
    assert.equal(discoverAgyRefreshToken(home), null);   // nothing on disk yet
    // gemini-cli oauth_creds.json with a refresh_token
    fs.writeFileSync(path.join(gemini, 'oauth_creds.json'), JSON.stringify({ access_token: 'a', refresh_token: '1//gemini-rt', expiry_date: 1 }));
    assert.equal(discoverAgyRefreshToken(home), '1//gemini-rt');
    // Antigravity's bare-string user_refresh.antigravity wins (checked first)
    fs.writeFileSync(path.join(gemini, 'user_refresh.antigravity'), '1//agy-rt\n');
    assert.equal(discoverAgyRefreshToken(home), '1//agy-rt');
    // ...and a JSON-shaped variant of that file also works
    fs.writeFileSync(path.join(gemini, 'user_refresh.antigravity'), JSON.stringify({ refresh_token: '1//agy-json-rt' }));
    assert.equal(discoverAgyRefreshToken(home), '1//agy-json-rt');
    // The Antigravity CLI token file (nested under `token`) is checked first.
    const agyCli = path.join(gemini, 'antigravity-cli');
    fs.mkdirSync(agyCli, { recursive: true });
    fs.writeFileSync(path.join(agyCli, 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'a', refresh_token: '1//agy-cli-rt' }, auth_method: 'consumer' }));
    assert.equal(discoverAgyRefreshToken(home), '1//agy-cli-rt');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('metered execs: claude/codex/agy yes; hermes/ollama/script no', () => {
  assert.equal(isMeteredExec('claude'), true);
  assert.equal(isMeteredExec('codex'), true);
  assert.equal(isMeteredExec('agy'), true);
  for (const e of ['hermes', 'ollama', 'script', undefined]) assert.equal(isMeteredExec(e), false);
});
