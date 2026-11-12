#!/usr/bin/env python3
"""Exercise direct instrument exports in Chrome's isolated temporary storage."""
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

def fixture(root, frequency):
    metadata = root / '.egc1'
    (metadata / 'entries').mkdir(parents=True)
    source = root / 'original.wav'
    rate, frames = 8000, 8000
    pcm = b''.join(struct.pack('<h', round(12000 * math.sin(i * frequency))) for i in range(frames))
    with wave.open(str(source), 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate); audio.writeframes(pcm)
    identity = hashlib.sha256(source.read_bytes()).hexdigest()
    role = dict(version=1, samples=frames, rate=rate, hasRoot=True, root=60, confidence=1,
                transients=[0], beats=[], downbeats=[], gateVersion=1, gateStarts=[0], gateStrengths=[1])
    analysis = dict(version=1, id=identity, channels=1, pipeline='test',
                    pitch=dict(role, analysisVersion=5), loop=dict(role, analysisVersion=8),
                    vocal=dict(role, analysisVersion=2, analysisRole='vocal', vocalStarts=[0], vocalDefaults=[0]))
    (metadata / 'entries' / (identity + '.json')).write_text(json.dumps(analysis))
    row = dict(id=identity, path='original.wav', state='ready', samples=frames, rate=rate,
               channels=1, bytes=source.stat().st_size, tags=['synth', 'lead'])
    manifest = dict(version=1, state='complete', entries=[row])
    (metadata / 'library.json').write_text(json.dumps(manifest))
    (metadata / 'workspace.json').write_text(json.dumps(dict(manifest, entries=[row, dict(row, id='b'*64, state='rejected')])))
    (metadata / 'browser' / 'embeddings').mkdir(parents=True)
    (metadata / 'browser' / 'embeddings' / 'unused.json').write_text('{}')
    return manifest, source.read_bytes()

picker = """async () => {
    const root = await navigator.storage.getDirectory();
    window.showDirectoryPicker = async () => root.getDirectoryHandle('destination', {create:true});
}"""
snapshot = """async (name) => {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle('destination');
    const output = await parent.getDirectoryHandle('EGC1 - '+name);
    const files = {};
    async function visit(directory, prefix='') {
        for await (const [name, entry] of directory.entries()) {
            if (entry.kind === 'directory') { await visit(entry, prefix+name+'/'); }
            else { const file=await entry.getFile(); files[prefix+name]=name.endsWith('.json') ? JSON.parse(await file.text()) : file.size; }
        }
    }
    await visit(output); return files;
}"""

server = ThreadingHTTPServer(('127.0.0.1', 8789), functools.partial(Handler, directory=str(repo)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='egc-export-browser-') as temporary:
        parent = Path(temporary) / 'Collection'
        current, sibling = parent / 'Samples', parent / 'Sibling'
        manifest, original = fixture(current, .17)
        fixture(sibling, .23)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chrome, headless=True, args=['--no-sandbox'])
            try:
                page = browser.new_page(viewport=dict(width=1440, height=1000))
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto('http://127.0.0.1:8789/classifier/?no-sw')
                page.locator('#folder-input').set_input_files(str(current))
                assert page.locator('#instrument-export').is_visible()
                page.evaluate(picker)
                page.locator('[data-export-start]').click()
                page.wait_for_function("document.querySelector('[data-export-status]').textContent.startsWith('Export complete:')")
                files = page.evaluate(snapshot, 'Samples')
                assert files['original.wav'] == len(original)
                assert len(files['.egc1/library.json']['entries']) == 1
                assert '.egc1/workspace.json' not in files
                assert '.egc1/browser/embeddings/unused.json' not in files
                page.locator('[data-export-start]').click()
                page.wait_for_function("document.querySelector('[data-export-status]').textContent.includes('0 files copied')")
                assert '4 unchanged' in page.locator('[data-export-status]').inner_text()
                page.evaluate("""() => {
                    window.exportTestLock = navigator.locks.request('egc-classifier-write', () => new Promise(resolve => { window.releaseExportTestLock = resolve; }));
                }""")
                page.wait_for_function('Boolean(window.releaseExportTestLock)')
                page.locator('[data-export-start]').click()
                page.wait_for_function("document.querySelector('[data-export-status]').textContent.includes('pause sample processing')")
                page.evaluate('window.releaseExportTestLock()')
                page.wait_for_function("!document.querySelector('[data-export-start]').disabled")
                # Withholding a sound updates the existing exported catalogue.
                (current / '.egc1/library.json').write_text(json.dumps(dict(manifest, entries=[])))
                page.locator('#folder-input').evaluate("input => { input.value = ''; }")
                page.locator('#folder-input').set_input_files(str(current))
                page.locator('[data-export-start]').click()
                page.wait_for_function("document.querySelector('[data-export-status]').textContent.startsWith('Export complete:')")
                assert page.evaluate(snapshot, 'Samples')['.egc1/library.json']['entries'] == []
                (current / '.egc1/library.json').write_text(json.dumps(manifest))
                # Review exports the current folder or its linked sibling collection.
                page.goto('http://127.0.0.1:8789/classifier/review/?no-sw')
                page.locator('#review-folder-input').set_input_files(str(current))
                page.wait_for_selector('#library-dashboard:not([hidden])')
                page.evaluate(picker)
                page.locator('[data-export-start]').click()
                page.wait_for_function("document.querySelector('[data-export-status]').textContent.startsWith('Export complete:')")
                assert len(page.evaluate(snapshot, 'Samples')['.egc1/library.json']['entries']) == 1
                page.locator('#collection-folder-input').set_input_files(str(parent))
                page.wait_for_function("document.querySelector('#collection-name').textContent === 'Collection'")
                page.locator('#instrument-export-scope').select_option('collection')
                page.locator('[data-export-start]').click()
                page.wait_for_function("document.querySelector('[data-export-status]').textContent.startsWith('Export complete: EGC1 - Collection')")
                files = page.evaluate(snapshot, 'Collection')
                assert len(files['Samples/.egc1/library.json']['entries']) == 1
                assert len(files['Sibling/.egc1/library.json']['entries']) == 1
                assert not any('browser/' in path or 'workspace.json' in path for path in files)
                assert original == (current / 'original.wav').read_bytes()
                assert not errors, errors
                page.set_viewport_size(dict(width=390, height=844))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'export controls overflow on mobile'
                print('PASS: processing/review exports, incremental copy, withdrawal, linked siblings, mobile layout; original audio untouched')
            finally:
                browser.close()
finally:
    server.shutdown()
