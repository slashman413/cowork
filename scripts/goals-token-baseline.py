#!/usr/bin/env python3
"""Frozen token harness: per-role and per-arm token totals from recorded telemetry.

Reads task.context.usage (inbox/*.json) and goals/<id>/achiever-turns.jsonl. Read-only.
Weights are the usual price ratios (cache read 0.1x, cache write 1.25x, output 5x),
an assumption to re-check against current pricing. Unmetered runs are listed, never
counted as zero. The plan's verdict rule: an arm needs >= 15 tasks (>= 6 Judgers),
otherwise it reports INCONCLUSIVE and does not ship.

Usage: goals-token-baseline.py [--root <cowork dir>] [--since YYYY-MM-DD]
"""
import argparse, collections, glob, json, os, statistics

ap = argparse.ArgumentParser()
ap.add_argument('--root', default=os.path.expanduser('~/workspace/github/slashman413/cowork'))
ap.add_argument('--since', default='')
a = ap.parse_args()

def weighted(u):
    return u.get('input', 0) + 0.1 * u.get('cacheRead', 0) + 1.25 * u.get('cacheWrite', 0) + 5 * u.get('output', 0)

roles = collections.defaultdict(list)
arms = collections.defaultdict(list)
unmetered = collections.Counter()
for f in glob.glob(os.path.join(a.root, 'inbox', '*.json')):
    try:
        t = json.load(open(f))
    except Exception:
        continue
    c = t.get('context') or {}
    if not c.get('goalGenerated') or t.get('createdAt', '') < a.since or t.get('status') not in ('done', 'rejected'):
        continue
    role = {'goal-judger': 'judger', 'goal-attention': 'attention'}.get(c.get('role'), 'execution')
    u = c.get('usage')
    if not u or u.get('input') is None:
        unmetered[role] += 1
        continue
    roles[role].append(weighted(u))
    if c.get('usageArm'):
        arms[c['usageArm']].append(weighted(u))

turns = []
for f in glob.glob(os.path.join(a.root, 'goals', '*', 'achiever-turns.jsonl')):
    for line in open(f):
        try:
            turn = json.loads(line)
        except Exception:
            continue
        if turn.get('at', '') >= a.since and turn.get('usage'):
            turns.append(weighted(turn['usage']))
if turns:
    roles['achiever'] = turns

def row(v):
    return {'runs': len(v), 'weighted_total': round(sum(v)), 'weighted_median': round(statistics.median(v)) if v else None}

def verdict(a_arm, b_arm, need, target):
    x, y = arms.get(a_arm, []), arms.get(b_arm, [])
    if len(x) < need or len(y) < need:
        return f'INCONCLUSIVE ({len(x)} vs {len(y)} runs, need {need} per arm)'
    change = statistics.mean(x) / statistics.mean(y) - 1
    return f"{'VERIFIED' if change <= target else 'NOT VERIFIED'} ({change:+.1%}, target {target:+.0%})"

print(json.dumps({
    'roles': {k: row(v) for k, v in sorted(roles.items())},
    'unmetered': dict(unmetered),
    'arms': {k: row(v) for k, v in sorted(arms.items())},
    'verdicts': {
        'auto-memory off vs on': verdict('memory-off', 'memory-on', 15, -0.15),
        'judger digest vs plain': verdict('judger-digest', 'judger-plain', 6, -0.30),
    },
}, indent=1))
