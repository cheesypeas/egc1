#!/usr/bin/env python3
"""Optional browser integration test. Requires Playwright and desktop Chrome.

Uses generated audio only; downloads pinned models just as the public tool does.
No test audio or browser profile belongs in the website repository.
"""
import argparse
import functools
import json
from pathlib import Path
import struct
import tempfile
import threading
import wave
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--chrome', required=True, help='Path to Chrome/Chromium executable')
parser.add_argument('--port', type=int, default=8780, help='Local test port; keep stable to reuse model cache')
parser.add_argument('--profile', help='Optional external test profile for model-cache reuse')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *values):
        pass

handler = functools.partial(Handler, directory=str(repo))
server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/classifier/'

try:
    with tempfile.TemporaryDirectory(prefix='sample-lab-test-') as temporary:
        root = Path(temporary)
        fixture = root / 'samples'
        fixture.mkdir()
        rate = 48000
        for name, offsets in [('kick.wav', [0]), ('multi.wav', [0, rate])]:
            import math
            frames = rate // 2 if name == 'kick.wav' else rate * 2
            pcm = bytearray(frames * 2)
            for offset in offsets:
                for i in range(rate // 5):
                    value = int(24000 * math.exp(-28 * i / rate) * math.sin(2 * math.pi * 80 * i / rate))
                    struct.pack_into('<h', pcm, (offset + i) * 2, value)
            with wave.open(str(fixture / name), 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(rate)
                audio.writeframes(pcm)
        (fixture / 'bad.wav').write_bytes(b'bad audio')
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                args.profile or str(root / 'browser'), executable_path=args.chrome,
                headless=True, args=['--no-sandbox'], accept_downloads=True)
            try:
                page = context.new_page()
                for old_page in context.pages:
                    if old_page is not page:
                        old_page.close()
                errors = []
                methods = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: print('Browser:', message.text, flush=True) if message.type == 'error' else None)
                context.on('request', lambda request: methods.append(request.method))
                # Refresh only this dedicated test profile's page cache, retaining model weights.
                page.goto(url.rsplit('classifier/', 1)[0])
                page.evaluate('''async () => {
                    for (const r of await navigator.serviceWorker.getRegistrations()) { await r.unregister(); }
                    for (const key of await caches.keys()) { if (key.startsWith('egc-sample-lab-shell-')) { await caches.delete(key); } }
                }''')
                page.goto(url)
                print('Page loaded', flush=True)
                page.evaluate("navigator.serviceWorker.addEventListener('message', e => console.error('SW', JSON.stringify(e.data)))")
                try:
                    page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=30000)
                except Exception:
                    print(page.evaluate('''async()=>({registrations:await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r=>({active:r.active?.state,waiting:r.waiting?.state,installing:r.installing?.state}))),caches:await caches.keys()})'''), flush=True)
                    raise
                print('Offline page cached', flush=True)
                page.evaluate('window.showDirectoryPicker = undefined')
                page.locator('#folder-input').set_input_files(str(fixture))
                page.locator('#find-beats').uncheck()
                print('Starting run', flush=True)
                page.evaluate("document.querySelector('#run').click(); document.querySelector('#pause').click()")
                print('Pause requested', flush=True)
                page.wait_for_function("!document.querySelector('#run').disabled", timeout=180000)
                assert 'paused' in page.locator('#stage').inner_text(), (page.locator('#stage').inner_text(), page.locator('#notice').inner_text())
                print('Starting run', flush=True)
                page.locator('#run').click()
                page.wait_for_function("!document.querySelector('#run').disabled", timeout=180000)
                assert page.locator('#stat-ready').inner_text() == '3'
                assert page.locator('#stat-regions').inner_text() == '2'
                assert page.locator('#stat-failed').inner_text() == '1'
                with page.expect_download() as download:
                    page.locator('#export-metadata').click()
                archive = root / 'metadata.zip'
                download.value.save_as(archive)
                with zipfile.ZipFile(archive) as metadata:
                    assert metadata.testzip() is None
                    assert all(name.startswith('.toysampler/') for name in metadata.namelist())
                    manifest = json.loads(metadata.read('.toysampler/library.json'))
                    assert len([row for row in manifest['entries'] if row['state'] == 'ready']) == 3
                print('Starting run', flush=True)
                page.locator('#run').click()
                page.wait_for_function("!document.querySelector('#run').disabled", timeout=30000)
                assert page.locator('#stat-cached').inner_text() == '3'
                context.set_offline(True)
                print('Reloading offline', flush=True)
                page.reload()
                page.evaluate('window.showDirectoryPicker = undefined')
                page.locator('#folder-input').set_input_files(str(fixture))
                page.locator('#find-beats').uncheck()
                print('Starting run', flush=True)
                page.locator('#run').click()
                page.wait_for_function("!document.querySelector('#run').disabled", timeout=180000)
                assert page.locator('#stat-ready').inner_text() == '3'
                assert not errors, errors
                assert set(methods) == {'GET'}, methods
                print('PASS: classification, regions, failed files, pause/resume, ZIP, cache and offline inference')
            finally:
                print('Closing test browser', flush=True)
                context.close()
finally:
    print('Stopping test server', flush=True)
    server.shutdown()
    server.server_close()
