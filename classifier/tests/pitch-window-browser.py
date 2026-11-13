#!/usr/bin/env python3
"""Verify the browser pitch-only API using generated in-memory PCM."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--chrome', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 8791), functools.partial(Handler, directory=str(repo)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chrome, headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page()
            errors, requests = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: requests.append(request.url))
            page.goto('http://127.0.0.1:8791/classifier/?no-sw')
            result = page.evaluate('''async () => {
                const {Inference} = await import('./inference.js');
                const inference = new Inference(()=>{}), rate = 192000;
                const left = Float32Array.from({length:rate*2}, (_,i)=>.4*Math.sin(i*2*Math.PI*32.70319566/rate));
                const original = left.slice();
                const right = Float32Array.from({length:left.length}, (_,i)=>.8*Math.sin(i*2*Math.PI*440/rate));
                const measured = await inference.pitch([left,right],rate);
                const embedded = await inference.pitch([left,right],rate,64.25);
                const full = await inference.analyse([left,right],rate,null,false);
                return {measured,embedded,full:full.pitch,
                    unchanged:left.every((value,i)=>value===original[i])};
            }''')
            assert result['measured']['pitch']['hasRoot']
            assert abs(result['measured']['pitch']['root'] - 24) < .06
            assert result['embedded']['pitch']['root'] == 64.25
            assert abs(result['embedded']['acousticPitch']['root'] - 24) < .06
            assert result['full'] == result['measured']['pitch']
            assert result['unchanged']
            assert not errors, errors
            assert not any('audio_model.onnx' in url or 'beat-this' in url for url in requests)
            print('PASS: browser pitch-only API, high-rate bass, left-channel isolation, embedded tuning, full-analysis parity; no model downloads')
        finally:
            browser.close()
finally:
    server.shutdown()
