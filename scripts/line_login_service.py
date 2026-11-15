#!/usr/bin/env python3
"""
Interactive LINE Creators Market Login Daemon & Session Relay.
Maintains live QR code and status for the Cowork Portal (/line-login.html).
Saves authenticated cookies permanently to ~/.priv/line_creators_cookies.json.
"""

import os
import sys
import time
import json
import re
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

# Paths
COWORK_ROOT = Path('/home/wayne/workspace/github/slashman413/cowork')
PUBLIC_DIR = COWORK_ROOT / 'server/public/line-login'
ARTIFACTS_LINE_DIR = COWORK_ROOT / 'artifacts/line-login'
CANONICAL_COOKIES = Path.home() / '.priv/line_creators_cookies.json'
TASK_DIR = Path('/home/wayne/workspace/github/slashman413/cowork/artifacts/99c73f74-aefe-4cdd-ad1d-9cebbbe908c4')

MYPAGE = 'https://creator.line.me/my/W92XqLPqBOQfJ2Ro/sticker/'
SCAN_HINT = '請開啟智慧手機版LINE中的行動條碼掃描器'

# Ensure directories exist
PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
ARTIFACTS_LINE_DIR.mkdir(parents=True, exist_ok=True)
CANONICAL_COOKIES.parent.mkdir(parents=True, exist_ok=True)

def log(*args):
    msg = time.strftime('%Y-%m-%d %H:%M:%S ') + ' '.join(str(a) for a in args)
    print(msg, flush=True)
    with open(PUBLIC_DIR / 'log.txt', 'a', encoding='utf-8') as f:
        f.write(msg + '\n')

def write_status(status, pin=None, countdown=None, qr_age=0, detail=""):
    data = {
        "status": status,
        "pin": pin,
        "countdown": countdown,
        "qr_age": qr_age,
        "updated_at": time.strftime('%H:%M:%S'),
        "detail": detail,
        "log": detail
    }
    # Write JSON to public & artifacts
    for d in [PUBLIC_DIR, ARTIFACTS_LINE_DIR]:
        try:
            tmp = d / 'status.json.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, d / 'status.json')
        except Exception as e:
            pass

    # Legacy text status format for backward compatibility
    txt = f"{status} {time.strftime('%H:%M:%S')} qr_age={qr_age}\n"
    if pin:
        txt += f"\n{pin}\n"
    if countdown:
        txt += f"剩餘時間 {countdown}\n"
    if detail:
        txt += f"\n{detail}\n"

    for p in [PUBLIC_DIR / 'status.txt', TASK_DIR / 'LINE_LOGIN_STATUS.txt']:
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, 'w', encoding='utf-8') as f:
                f.write(txt)
        except Exception:
            pass

def save_qr_image(page):
    tmp_path = PUBLIC_DIR / 'qr.tmp.png'
    try:
        page.screenshot(path=str(tmp_path))
        os.replace(tmp_path, PUBLIC_DIR / 'qr.png')
        # Also copy to task dir for existing links
        if TASK_DIR.exists():
            try:
                page.screenshot(path=str(TASK_DIR / 'LINE_LOGIN_QR.png'))
            except Exception:
                pass
    except Exception as e:
        log('Error capturing QR screenshot:', e)

def check_manual_refresh():
    candidates = [
        ARTIFACTS_LINE_DIR / 'refresh_req.txt',
        PUBLIC_DIR / 'refresh_req.txt',
        TASK_DIR / 'work/refresh_req.txt'
    ]
    requested = False
    for p in candidates:
        if p.exists():
            try:
                p.unlink()
                requested = True
            except Exception:
                pass
    return requested

def open_qr_page(page):
    log('Navigating to LINE Creators MyPage...')
    page.goto(MYPAGE, wait_until='networkidle')
    page.wait_for_timeout(2000)
    login_btn = page.locator('a:has-text("透過行動條碼登入")')
    if login_btn.count():
        login_btn.first.click()
        page.wait_for_timeout(4000)
    log('QR page ready:', page.url[:90])
    save_qr_image(page)
    return time.time()

def on_login_success(ctx, page):
    log('LOGIN SUCCESS! Current URL:', page.url[:120])
    page.goto(MYPAGE, wait_until='networkidle')
    cookies = ctx.cookies()

    # Save to canonical persistent location
    with open(CANONICAL_COOKIES, 'w', encoding='utf-8') as f:
        json.dump(cookies, f, indent=2)
    log('Saved cookies to canonical path:', CANONICAL_COOKIES)

    # Save to line-login artifacts
    with open(ARTIFACTS_LINE_DIR / 'cookies_after.json', 'w', encoding='utf-8') as f:
        json.dump(cookies, f, indent=2)

    # Save to task directory
    task_cookies = TASK_DIR / 'line_submit/cookies_after.json'
    task_cookies.parent.mkdir(parents=True, exist_ok=True)
    with open(task_cookies, 'w', encoding='utf-8') as f:
        json.dump(cookies, f, indent=2)

    page.screenshot(path=str(PUBLIC_DIR / 'login_done.png'))
    if TASK_DIR.exists():
        page.screenshot(path=str(TASK_DIR / 'LINE_LOGIN_DONE.png'))

    write_status('LOGGED_IN', detail="LINE Creators Market 登入成功！Session 已就緒。")

    # Trigger task run_all.sh if present
    run_script = TASK_DIR / 'scripts/run_all.sh'
    if run_script.exists():
        log('Triggering automated pipeline run_all.sh...')
        try:
            subprocess.Popen(['/bin/bash', str(run_script)], cwd=str(TASK_DIR))
        except Exception as e:
            log('Error triggering run_all.sh:', e)

def main():
    log('=== Starting LINE Login Service ===')
    write_status('WAITING_SCAN', detail="正在啟動 Chromium 與載入登入頁面…")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            locale='zh-TW',
            viewport={'width': 900, 'height': 1100},
            user_agent='Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
        )
        page = ctx.new_page()

        shown_time = open_qr_page(page)
        start_time = time.time()

        while time.time() - start_time < 86400:  # run up to 24h
            try:
                body = page.inner_text('body')

                # Check if logged in
                if page.url.startswith('https://creator.line.me') and '透過行動條碼登入' not in body:
                    on_login_success(ctx, page)
                    break

                # Check if error page
                if '暫時無法登入' in body or '前往登入畫面' in body:
                    log('Error page detected -> reopening QR...')
                    shown_time = open_qr_page(page)
                    continue

                # Check for 4-digit PIN verification code
                pin_match = re.search(r'^\s*(\d{4,6})\s*$', body, re.M)
                time_match = re.search(r'剩餘時間\s*([\d:]+)', body)

                qr_age = int(time.time() - shown_time)
                manual_req = check_manual_refresh()

                if pin_match:
                    pin = pin_match.group(1)
                    countdown = time_match.group(1) if time_match else None
                    write_status('PIN_REQUIRED', pin=pin, countdown=countdown, qr_age=qr_age, detail=f"請在手機 LINE 輸入認證碼 {pin}")
                    save_qr_image(page)
                else:
                    if manual_req or (SCAN_HINT in body and qr_age > 150):
                        log('Regenerating QR code (manual=' + str(manual_req) + ', age=' + str(qr_age) + ')...')
                        refresh_btn = page.locator('text=更新行動條碼')
                        if refresh_btn.count() and refresh_btn.first.is_visible():
                            refresh_btn.first.click()
                            page.wait_for_timeout(2500)
                            log('Regenerated QR via button')
                        else:
                            open_qr_page(page)
                        shown_time = time.time()
                        qr_age = 0
                        body = page.inner_text('body')

                    save_qr_image(page)
                    write_status('WAITING_SCAN', qr_age=qr_age, detail=body[:400])

            except Exception as e:
                log('Loop error:', repr(e)[:180])
                page.wait_for_timeout(3000)
                try:
                    shown_time = open_qr_page(page)
                except Exception:
                    pass

            page.wait_for_timeout(2500)

        browser.close()
    log('=== LINE Login Service Ended ===')

if __name__ == '__main__':
    main()
