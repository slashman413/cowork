#!/usr/bin/env python3
"""Frozen UX harness for the goals page. Prints one JSON report and exits non-zero on a miss.

Read-only checks run against any server. --flows mutates goals, so run it only on
the fixture from goals-fixture.py. Never point --flows at the live server.

Usage: goals-ux-baseline.py --base http://localhost:16868 [--flows] [--axe path/to/axe.min.js] [--shots dir]
Env:   COWORK_API_KEY, sent as a bearer token when set.
"""
import argparse, json, os, sys, urllib.request
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://localhost:16868')
ap.add_argument('--flows', action='store_true')
ap.add_argument('--axe')
ap.add_argument('--shots')
a = ap.parse_args()
H = {'Authorization': 'Bearer ' + os.environ['COWORK_API_KEY']} if os.environ.get('COWORK_API_KEY') else {}
results = []

def check(name, ok, value=None, target=None):
    results.append({'check': name, 'ok': bool(ok), 'value': value, 'target': target})

def api(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(a.base + path, headers=H)))

EMOJI = r"/[\p{Extended_Pictographic}]/u"
SIZES = {'desktop': (1440, 900), 'mobile': (390, 844)}

def main(p):
    b = p.chromium.launch(headless=True, args=['--no-sandbox'])
    raw = urllib.request.urlopen(urllib.request.Request(a.base + '/api/goals', headers=H)).read()
    check('GET /goals bytes', len(raw) <= 3000, len(raw), '<=3000')
    goals = json.loads(raw)
    first = goals[0]['goalId'] if goals else None

    for theme in ('light', 'dark'):
        for name, (w, h) in SIZES.items():
            ctx = b.new_context(viewport={'width': w, 'height': h}, extra_http_headers=H, color_scheme=theme)
            pg = ctx.new_page()
            pg.add_init_script(f"localStorage.setItem('theme','{theme}');localStorage.setItem('cowork-theme','{theme}')")
            fetched = []
            pg.on('request', lambda r: fetched.append(r.url))
            pg.goto(a.base + '/#goals')
            pg.wait_for_selector('.gv-row', timeout=20000)
            pg.evaluate(f"document.documentElement.setAttribute('data-theme','{theme}')")
            tag = f'{name}/{theme}'
            top = pg.evaluate("document.querySelector('.gv-row').getBoundingClientRect().top")
            if theme == 'light':
                check(f'first goal top edge {name}', top <= 180, round(top), '<=180')
                if name == 'mobile':
                    ul = pg.evaluate("document.querySelector('#gv-list').getBoundingClientRect().height")
                    per = ul / max(1, len(goals)) * 4
                    check('list height per 4 goals, mobile', per <= 1200, round(per), '<=1200')
                check(f'templates not fetched on list {name}', not any('/goals/templates' in u for u in fetched))
                texts = pg.evaluate("[...document.querySelectorAll('.gv-row-line')].map(e=>e.textContent)")
                sleepers = [g for g in goals if g['display']['state'] == 'sleeping']
                labelled = sum(1 for g in sleepers if g['display'].get('nextAt'))
                check('sleeping goals with next time', labelled == len(sleepers), f'{labelled}/{len(sleepers)}')
                check('rows show budget', pg.locator('.gv-budget').count() == len(goals), pg.locator('.gv-budget').count())
            if a.shots:
                os.makedirs(a.shots, exist_ok=True)
                pg.wait_for_timeout(500)   # the theme switch animates
                pg.screenshot(path=f'{a.shots}/goals-{name}-{theme}-list.png')

            if first:
                pg.goto(a.base + f'/#goals/{first}/phases')
                pg.wait_for_selector('#gv-tab-phases[aria-selected="true"]', timeout=15000)
                pg.reload()
                pg.wait_for_selector('#gv-tab-phases[aria-selected="true"]', timeout=15000)
                pg.evaluate(f"document.documentElement.setAttribute('data-theme','{theme}')")
                if theme == 'light':
                    check(f'deep link survives reload {name}', True)
                if a.shots:
                    pg.wait_for_timeout(500)
                    pg.screenshot(path=f'{a.shots}/goals-{name}-{theme}-detail.png')
                m = pg.evaluate("""(EMOJI) => {
                  const root = document.querySelector('.gv');
                  const leaves = [...root.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim() && e.getClientRects().length);
                  const small = leaves.filter(e => parseFloat(getComputedStyle(e).fontSize) < 12).map(e => e.textContent.slice(0, 30));
                  const emoji = leaves.filter(e => new RegExp(EMOJI.slice(1, -2), 'u').test(e.textContent) && !e.closest('.gv-pre, .gv-tasks, .gv-title, .gv-facts, .gv-row-title, .gv-row-line, .gv-dec-text')).map(e => e.textContent.slice(0, 30));
                  const targets = [...root.querySelectorAll('a,button,summary,input,select,textarea')].filter(e => e.getClientRects().length && !e.closest('p,li>a,.gv-tasks,.gv-strip') );
                  const tiny = targets.filter(e => { const r = e.getBoundingClientRect(); return r.height < 24 || r.width < 24; }).map(e => e.textContent.trim().slice(0, 30) || e.className);
                  return { small, emoji, tiny };
                }""", EMOJI)
                check(f'leaf text under 12px {tag}', not m['small'], m['small'][:5], '0')
                check(f'emoji as icons {tag}', not m['emoji'], m['emoji'][:5], '0')
                check(f'non-inline targets under 24px {tag}', not m['tiny'], m['tiny'][:5], '0')
                if a.axe:
                    for route in (f'#goals/{first}/phases', f'#goals/{first}/settings', f'#goals/{first}/decisions', 'goals/new', '#goals'):
                        pg.goto(a.base + '/' + (route if route.startswith('#') else '#' + route))
                        pg.wait_for_selector('.gv', timeout=15000)
                        pg.wait_for_timeout(600)
                        pg.evaluate(f"document.documentElement.setAttribute('data-theme','{theme}')")
                        pg.add_script_tag(path=a.axe)
                        v = pg.evaluate("""async () => {
                          const r = await axe.run('.gv', { resultTypes: ['violations'] });
                          return r.violations.filter(x => ['serious','critical'].includes(x.impact)).map(x => ({ id: x.id, n: x.nodes.length, ex: x.nodes[0].html.slice(0,120), why: (x.nodes[0].any[0]||{}).message }));
                        }""")
                        check(f'axe serious/critical {tag} {route}', not v, v[:4], '0')
            ctx.close()

    # State survives events; mobile back restores scroll.
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, extra_http_headers=H)
    pg = ctx.new_page()
    pg.goto(a.base + '/#goals/new')
    pg.wait_for_selector('#gc-title')
    pg.fill('#gc-title', 'kept through an event')
    pg.evaluate("document.activeElement.blur()")
    pg.evaluate("window.app && window.app.handleSSEEvent ? window.app.handleSSEEvent({type:'taskCreated',payload:{task:{id:'x',title:'t'}}}) : null")
    pg.wait_for_timeout(1200)
    check('create form survives an event', pg.input_value('#gc-title') == 'kept through an event')
    if first:
        pg.goto(a.base + '/#goals')
        pg.wait_for_selector('.gv-row')
        pg.evaluate("(document.querySelector('.content-area')||document.scrollingElement).scrollTop = 40")
        before = pg.evaluate("(document.querySelector('.content-area')||document.scrollingElement).scrollTop")
        pg.click('.gv-row')
        pg.wait_for_selector('.gv-title')
        pg.click('.gv-back')
        pg.wait_for_selector('.gv-list', state='visible')
        pg.wait_for_timeout(400)
        after = pg.evaluate("(document.querySelector('.content-area')||document.scrollingElement).scrollTop")
        check('back on mobile restores scroll', after == before, f'{before}->{after}')
    ctx.close()

    # Keyboard: list, detail, tabs, back.
    if first:
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, extra_http_headers=H)
        pg = ctx.new_page()
        pg.goto(a.base + '/#goals')
        pg.wait_for_selector('.gv-row')
        pg.focus('.gv-row')
        ring = pg.evaluate("getComputedStyle(document.activeElement).outlineStyle")
        pg.keyboard.press('Enter')
        pg.wait_for_selector('.gv-tabs [role=tab][aria-selected=true]')
        pg.focus('#gv-tab-overview')
        pg.keyboard.press('ArrowRight')
        pg.wait_for_selector('#gv-tab-phases[aria-selected=true]')
        check('keyboard list, detail, tabs', True, f'outline={ring}')
        ctx.close()

    if a.flows:
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, extra_http_headers=H)
        pg = ctx.new_page()
        dialogs = []
        pg.on('dialog', lambda d: (dialogs.append(d.type), d.dismiss()))

        # Create: invalid first, then valid, then raise the budget.
        pg.goto(a.base + '/#goals/new')
        pg.wait_for_selector('[data-tpl]')
        pg.click('button[data-activate="1"]')
        pg.wait_for_selector('#gc-title-error:not([hidden])')
        focused = pg.evaluate("document.activeElement.id")
        check('create: invalid shows inline error and focuses it', focused == 'gc-title', focused)
        pg.fill('#gc-title', 'Harness goal')
        pg.fill('#gc-criteria', 'not a question')
        check('create: non Yes/No criterion warns', pg.locator('#gc-warn:not([hidden])').count() == 1)
        pg.fill('#gc-criteria', 'Is the harness green?')
        pg.fill('#gc-phases', 'Do the thing')
        pg.click('button[data-activate="1"]')
        pg.wait_for_function("location.hash.startsWith('#goals/goal-')", timeout=10000)
        gid = pg.evaluate("location.hash.split('/')[1]")
        check('create: valid creates and activates', api(f'/api/goals/{gid}')['status'] == 'active', gid)

        pg.goto(a.base + f'/#goals/{gid}/settings')
        pg.wait_for_selector('#gs-budget')
        pg.fill('#gs-budget', '0')
        pg.click('#gv-settings button[type=submit]')
        pg.wait_for_selector('#gs-budget-error:not([hidden])')
        pg.fill('#gs-budget', '99')
        pg.click('#gv-settings button[type=submit]')
        pg.wait_for_function("document.querySelector('#gs-saved').textContent.startsWith('Saved')", timeout=10000)
        check('raise budget via Settings', api(f'/api/goals/{gid}')['stepBudget'] == 99)

        # Block with a typed check, then retry.
        pg.goto(a.base + f'/#goals/{gid}')
        pg.wait_for_selector('.gv-menu summary')
        pg.click('.gv-menu summary')
        pg.click('[data-act=block]')
        pg.wait_for_selector('dialog[open] #gb-reason')
        pg.click('dialog[open] [data-ok]')
        pg.wait_for_selector('#gb-reason-error:not([hidden])')
        pg.fill('#gb-reason', 'Waiting on a person')
        pg.fill('#gb-resume', 'They reply')
        pg.select_option('#gb-type', 'after-time')
        pg.fill('#gb-value', '2030-01-01T00:00:00Z')
        pg.click('dialog[open] [data-ok]')
        pg.wait_for_selector('dialog[open]', state='detached', timeout=10000)
        g = api(f'/api/goals/{gid}')
        check('block: dialog holds the goal with a typed check', g['status'] == 'blocked' and g.get('unblockCheck', {}).get('type') == 'after-time')
        check('block: shows as needs you', g['display']['state'] == 'needs-you', g['display']['state'])
        pg.wait_for_selector('[data-act=retry]')
        pg.click('[data-act=retry]')
        pg.wait_for_function(f"!document.querySelector('[data-act=retry]')", timeout=10000)
        check('retry now resumes', api(f'/api/goals/{gid}')['status'] == 'active')

        # Plan a phase from a goal with no phase left (blocked by the harness).
        audited = [g for g in goals if g['display'].get('action') == 'plan-phase']
        if audited:
            sid = audited[0]['goalId']
            pg.goto(a.base + f'/#goals/{sid}')
            pg.wait_for_selector('[data-act=plan]')
            pg.click('[data-act=plan]')
            pg.wait_for_selector('dialog[open] #gp-title')
            pg.fill('#gp-title', 'Harness follow-up phase')
            pg.click('dialog[open] [data-ok]')
            pg.wait_for_selector('dialog[open]', state='detached', timeout=10000)
            g = api(f'/api/goals/{sid}')
            check('plan a phase: adds it and resumes', g['status'] == 'active' and g['phases'][-1]['title'] == 'Harness follow-up phase')

        # Delete names the goal; keep-tasks is offered only with tasks.
        pg.goto(a.base + f'/#goals/{gid}')
        pg.wait_for_selector('.gv-menu summary')
        pg.click('.gv-menu summary')
        pg.click('[data-act=delete]')
        pg.wait_for_selector('dialog[open]')
        named = 'Harness goal' in pg.inner_text('dialog[open] h3')
        pg.click('dialog[open] [data-ok]')
        pg.wait_for_function("location.hash === '#goals'", timeout=10000)
        try:
            api(f'/api/goals/{gid}')
            gone = False
        except Exception:
            gone = True
        check('delete: dialog names the goal, and it deletes', named and gone)
        check('native prompt/confirm used', not dialogs, dialogs, '0')
        ctx.close()
    b.close()

with sync_playwright() as p:
    try:
        main(p)
    except Exception as e:  # a crash is a miss, and the checks so far still matter
        check('harness completed', False, str(e)[:400])

failed = [r for r in results if not r['ok']]
print(json.dumps({'passed': len(results) - len(failed), 'failed': len(failed), 'results': results}, indent=1, ensure_ascii=False))
sys.exit(1 if failed else 0)
