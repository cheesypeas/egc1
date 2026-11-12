#!/usr/bin/env python3
"""Exercise visible sample curation and organised navigation in real Chrome."""
import argparse
import functools
import hashlib
import json
import math
from pathlib import Path
import struct
import tempfile
import threading
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--chrome', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
server = ThreadingHTTPServer(('127.0.0.1', 8786), functools.partial(Handler, directory=str(repo)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='egc-curation-') as temporary:
        folder = Path(temporary)/'samples'
        metadata = folder/'.egc1'
        (metadata/'entries').mkdir(parents=True)
        rows = []
        specs = [('Drums/Kick 2.wav', 1., ['drums','kick'], 'needs-review', 'uncertain-attacks'),
                 ('Drums/Kick 10.wav', .7, ['drums','kick'], 'needs-review', 'uncertain-category'),
                 ('Synth/Bass.wav', 1.5, ['synth','bass'], 'needs-review', 'uncertain-root'),
                 ('Drums/Rejected.wav', .5, ['drums','snare'], 'rejected', 'human-review'),
                 ('Voice/Accepted.wav', .8, ['vocal'], 'ready', None)]
        for number, (path, duration, tags, state, reason) in enumerate(specs):
            rate = 8000
            count = round(duration*rate)
            pcm = bytearray(count*2)
            for i in range(count):
                struct.pack_into('<h', pcm, i*2, round(12000*math.sin(i*(.13+number*.015))*math.exp(-i/(rate*.4))))
            source = folder/path
            source.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(source), 'wb') as audio:
                audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate); audio.writeframes(pcm)
            identity = hashlib.sha256(source.read_bytes()).hexdigest()
            row = dict(id=identity, path=path, bytes=source.stat().st_size, rate=rate, samples=count, channels=1,
                       state=state, tags=tags, preparation=dict(reasons=[reason] if reason else [], bounds=dict(start=0,end=count), attacks=dict(accepted=[0],rejected=[])))
            rows.append(row)
            role = dict(samples=count,rate=rate,transients=[0],beats=[],downbeats=[],hasRoot=number==2)
            (metadata/'entries'/f'{identity}.json').write_text(json.dumps(dict(version=1,id=identity,pipeline='test',pitch=role,loop=role,vocal=role)))
        (metadata/'workspace.json').write_text(json.dumps(dict(version=1,state='complete',entries=rows)))
        (metadata/'library.json').write_text(json.dumps(dict(version=1,state='complete',entries=[rows[-1]])))
        old = dict(tags=['drums','kick'],certainty='clear',quality='keep',reasons=[],notes='Historical judgement',boundaries={},assisted=False,updatedAt='2026-11-01T00:00:00Z')
        (metadata/'evaluation.json').write_text(json.dumps(dict(version=1,revision=1,reviews={'s-'+rows[0]['id']:old},exposures={},history=[])))
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chrome,headless=True,args=['--no-sandbox'])
            try:
                page = browser.new_page(viewport=dict(width=1440,height=1000))
                errors=[]
                page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto('http://127.0.0.1:8786/classifier/review/')
                page.evaluate('window.showDirectoryPicker=undefined')
                page.locator('#review-folder-input').set_input_files(str(folder))
                page.wait_for_selector('#workspace:not([hidden])')
                assert page.locator('#filter').input_value() == 'pending'
                assert page.locator('#queue .queue-item').count() == 3
                assert page.locator('#item-title').inner_text() == 'Kick 2.wav'
                assert 'Drums/Kick 2.wav' in page.locator('#details').inner_text()
                assert 'Current category: Drums · Kick' in page.locator('#details').inner_text()
                assert page.locator('#reveal').count() == 0
                assert page.locator('#previous-comparison').count() == 0
                assert page.locator('#item-review-reasons').inner_text() == 'uncertain attacks'
                exported=page.evaluate("window.egcReview.request('/api/export')")
                assert exported['reviews']['s-'+rows[0]['id']] == old
                page.locator('#category-filter').select_option('synth')
                assert page.locator('#queue .queue-item').count() == 1
                assert page.locator('#item-title').inner_text() == 'Bass.wav'
                page.locator('#notes').fill('Quiet root needs checking')
                page.locator('#clear-queue-filters').click()
                page.locator('#folder-filter').select_option('Drums')
                assert page.locator('#queue .queue-item').count() == 2
                page.locator('#queue-sort').select_option('longest')
                assert page.locator('#queue .queue-item strong').all_inner_texts() == ['Kick 2.wav','Kick 10.wav']
                page.locator('#next').click()
                assert page.locator('#item-title').inner_text() == 'Kick 10.wav'
                assert page.locator('[data-category="drums"]').get_attribute('aria-pressed') == 'true'
                assert page.locator('[data-role="kick"]').get_attribute('aria-pressed') == 'true'
                page.locator('#queue-sort').select_option('duration')
                assert page.locator('#queue .queue-item strong').all_inner_texts() == ['Kick 10.wav','Kick 2.wav']
                page.locator('#autoplay').uncheck()
                page.locator('#save').click()
                page.wait_for_function("document.querySelector('#item-title').textContent === 'Kick 2.wav'")
                page.locator('#reason-filter').select_option('uncertain-category')
                assert page.locator('#queue .queue-item').count() == 1
                page.locator('#queue-search').fill('no-match-for-this-name')
                assert page.locator('#queue .queue-item').count() == 0
                assert not page.locator('#workspace').is_visible()
                assert 'No sounds match' in page.locator('#loading').inner_text()
                page.locator('#clear-queue-filters').click()
                page.locator('#queue-search').fill('bass')
                assert page.locator('#item-title').inner_text() == 'Bass.wav'
                assert page.locator('#notes').input_value() == 'Quiet root needs checking'
                page.locator('#clear-queue-filters').click()
                page.locator('#filter').select_option('excluded')
                assert page.locator('#queue .queue-item').count() == 1
                assert page.locator('#item-title').inner_text() == 'Rejected.wav'
                page.locator('#filter').select_option('accepted')
                assert page.locator('#queue .queue-item').count() == 1
                assert page.locator('#item-title').inner_text() == 'Accepted.wav'
                page.locator('#filter').select_option('all')
                page.locator('#category-filter').select_option('drums')
                page.locator('#queue-sort').select_option('source')
                page.reload()
                page.locator('#review-folder-input').set_input_files(str(folder))
                page.wait_for_selector('#workspace:not([hidden])')
                assert page.locator('#filter').input_value() == 'all'
                assert page.locator('#category-filter').input_value() == 'drums'
                assert page.locator('#queue-sort').input_value() == 'source'
                assert page.locator('#queue .queue-item strong').all_inner_texts() == ['Kick 2.wav','Kick 10.wav','Rejected.wav']
                page.screenshot(path='/tmp/egc-curation-desktop.png', full_page=True)
                page.set_viewport_size(dict(width=390,height=844))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert page.locator('#queue-search').is_visible()
                assert page.locator('#queue').is_visible()
                page.screenshot(path='/tmp/egc-curation-mobile.png', full_page=True)
                assert not errors, errors
                print('PASS: visible names/categories, manual queue, search/folder/category/reason filters, sorted navigation, empty state, draft and preference persistence, historical reviews unchanged, mobile layout',flush=True)
            finally:
                browser.close()
finally:
    server.shutdown();server.server_close()
