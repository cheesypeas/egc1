#!/usr/bin/env python3
"""Check the processing player's actual Web Audio buffers with synthetic audio."""
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


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(repo)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='egc-preview-') as temporary:
        folder = Path(temporary) / 'samples'
        folder.mkdir()
        rate, frames = 8000, 16000
        left = [round(9000 * math.sin(i * .19)) for i in range(frames)]
        right = [22000 if i % 2 else -22000 for i in range(frames)]

        def wav(path, channels):
            path.parent.mkdir(parents=True, exist_ok=True)
            pcm = b''.join(struct.pack('<' + 'h' * len(channels), *(channel[i] for channel in channels))
                           for i in range(len(channels[0])))
            with wave.open(str(path), 'wb') as audio:
                audio.setnchannels(len(channels))
                audio.setsampwidth(2)
                audio.setframerate(rate)
                audio.writeframes(pcm)
            return hashlib.sha256(path.read_bytes()).hexdigest()

        rows = []
        for name, state, bounds in [('published.wav', 'ready', (400, 10000)),
                                    ('pending.wav', 'needs-review', (1600, 9600)),
                                    ('legacy.wav', 'ready', None),
                                    ('invalid.wav', 'needs-review', (400, 17000))]:
            identity = wav(folder / name, [left, [value+len(rows) for value in right]])
            row = dict(id=identity, path=name, samples=frames, rate=rate, channels=2,
                       state=state, tags=['loops', 'drum-loop'])
            if bounds:
                row['preparation'] = dict(bounds=dict(start=bounds[0], end=bounds[1]))
            analysis = dict(loop=dict(loopEndSample=12000 if bounds else 8000,
                                      transients=[0, 1600, 5600, 9600, 12000]))
            entries = folder / '.egc1/entries'
            entries.mkdir(parents=True, exist_ok=True)
            (entries / (identity + '.json')).write_text(json.dumps(analysis))
            if name == 'published.wav':
                # A manual output differs deliberately from the old proposal.
                path = '.egc1/regions/published-playable.wav'
                output_id = wav(folder / path, [left[1000:9000]])
                row['output'] = dict(id=output_id, path=path, samples=8000, rate=rate, channels=1)
                (entries / (output_id + '.json')).write_text(json.dumps(dict(loop=dict(
                    loopEndSample=8000, transients=[0, 4000]))))
            rows.append(row)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chrome, headless=True, args=['--no-sandbox'])
            try:
                page = browser.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.add_init_script('''
                    window.__previewNodes=[];
                    const original=AudioContext.prototype.createBufferSource;
                    AudioContext.prototype.createBufferSource=function(...args){
                        const node=original.apply(this,args);window.__previewNodes.push(node);return node;
                    };
                    window.Worker=class {
                        addEventListener(type,callback){if(type==='message'){this.callback=callback;}}
                        terminate(){}
                        postMessage(message){
                            if(message.type!=='run'){return;}
                            for(const row of window.__fixtureRows){this.callback({data:{type:'result',row}});}
                            this.callback({data:{type:'complete',rows:window.__fixtureRows,
                                report:{completedFiles:4,readySamples:2,reusedEmbeddings:0,newEmbeddings:0,failures:[]}}});
                        }
                    };
                ''')
                page.goto(f'http://127.0.0.1:{server.server_port}/classifier/?no-sw')
                page.evaluate('window.showDirectoryPicker=undefined')
                page.evaluate('(rows)=>window.__fixtureRows=rows', rows)
                page.locator('#folder-input').set_input_files(str(folder))
                page.locator('#run').click()
                page.wait_for_selector('#results:not([hidden])')
                for name, expected_start, label in [('published.wav', 1000, 'library sound'),
                                                     ('pending.wav', 1600, 'proposed cut'),
                                                     ('legacy.wav', 0, 'source audio')]:
                    row = page.locator('#result-rows tr').filter(has_text=name)
                    if row.count() == 0:
                        row = page.locator('tbody tr').filter(has_text=name)
                    before_count = page.evaluate('window.__previewNodes.length')
                    row.locator('.row-play').click()
                    page.wait_for_function('(before)=>window.__previewNodes.length>before && window.__previewNodes.at(-1)?.buffer?.length===8000', arg=before_count)
                    assert label in page.locator('#player-info').inner_text()
                    actual = page.evaluate('''()=>{
                        const node=window.__previewNodes.at(-1),buffer=node.buffer;
                        return {channels:buffer.numberOfChannels,frames:buffer.length,
                            first:buffer.getChannelData(0)[0],last:buffer.getChannelData(0).at(-1),
                            start:node.loopStart,end:node.loopEnd,loop:node.loop};
                    }''')
                    assert actual['channels'] == 1 and actual['frames'] == 8000, actual
                    assert abs(actual['first'] - left[expected_start] / 32768) < 1e-6, actual
                    assert abs(actual['last'] - left[expected_start + 7999] / 32768) < 1e-6, actual
                    assert actual['start'] == 0 and actual['end'] == 1 and actual['loop'], actual
                    if name != 'legacy.wav':
                        assert row.locator('.duration-cell').inner_text() == '1.00s'
                count = page.evaluate('window.__previewNodes.length')
                page.locator('tbody tr').filter(has_text='invalid.wav').locator('.row-play').click()
                page.wait_for_function("document.querySelector('#notice').textContent.includes('Saved playable boundaries are invalid')")
                assert page.evaluate('window.__previewNodes.length') == count
                assert not errors, errors
                print('PASS: exact published WAV, proposed bounds, left-only audio, rebased loop range, legacy fallback, invalid-cut refusal and playable durations', flush=True)
            finally:
                browser.close()
finally:
    server.shutdown()
    server.server_close()
