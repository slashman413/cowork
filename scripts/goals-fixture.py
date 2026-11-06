#!/usr/bin/env python3
"""Copy the live goals and their tasks into a temp store and run a server on it.

The server has its dispatcher off and no brains, so nothing it does can spawn a
run or touch live data. The UX harness's mutating flows run only against this.

Usage: goals-fixture.py <repo-with-server> [--port 16868]   (runs until killed)
"""
import argparse, json, os, shutil, subprocess, tempfile

ap = argparse.ArgumentParser()
ap.add_argument('repo')
ap.add_argument('--port', type=int, default=16868)
ap.add_argument('--live', default=os.path.expanduser('~/workspace/github/slashman413/cowork'))
a = ap.parse_args()

tmp = tempfile.mkdtemp(prefix='goals-fixture-')
paths = {k: os.path.join(tmp, k) for k in ('inbox', 'artifacts', 'inputs', 'status', 'decisions', 'goals')}
for p in paths.values():
    os.makedirs(p)

ids = []
live_goals = os.path.join(a.live, 'goals')
for f in os.listdir(live_goals):
    if f.endswith('.json'):
        shutil.copy(os.path.join(live_goals, f), paths['goals'])
        ids.append(f[:-5])
for gid in ids:
    d = os.path.join(live_goals, gid)
    if os.path.isdir(d):
        shutil.copytree(d, os.path.join(paths['goals'], gid))

copied = 0
live_inbox = os.path.join(a.live, 'inbox')
for f in os.listdir(live_inbox):
    if not f.endswith('.json'):
        continue
    try:
        t = json.load(open(os.path.join(live_inbox, f)))
    except Exception:
        continue
    ctx = t.get('context') or {}
    if ctx.get('goalId') in ids:
        shutil.copy(os.path.join(live_inbox, f), paths['inbox'])
        copied += 1

config = {
    'server': {'port': a.port, 'host': '127.0.0.1', 'allowUnauthenticated': True},
    'paths': {**paths, 'agencyAgents': os.path.join(a.live, 'agency-agents')},
    'platforms': {}, 'services': {},
    'orchestration': {'enabled': False, 'brains': {}, 'agents': {}},
}
cfg = os.path.join(tmp, 'config.json')
json.dump(config, open(cfg, 'w'))
print(f'fixture {tmp}: {len(ids)} goals, {copied} tasks, port {a.port}', flush=True)
env = {**os.environ, 'COWORK_CONFIG': cfg}
env.pop('COWORK_API_KEY', None)
subprocess.run(['npx', 'tsx', 'src/index.ts'], cwd=os.path.join(a.repo, 'server'), env=env)
