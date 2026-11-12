#!/usr/bin/env python3
"""Manual exclusion/correction/admission through real Chrome and the WASM core."""
import argparse
import functools
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import threading
import wave
import math
import zipfile
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--chrome', required=True)
parser.add_argument('--library-tool', type=Path)
parser.add_argument('--check-prepare-guard', action='store_true')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
server = ThreadingHTTPServer(('127.0.0.1', 8785), functools.partial(Handler,directory=str(repo)))
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='egc-admission-') as temporary:
        root = Path(temporary)
        folder = root/'samples'
        folder.mkdir()
        rate = 8000
        pcm = bytearray(rate*2)
        for i in range(400,2400):
            value = int(20000*math.sin((i-400)*.41)*math.exp(-(i-400)/500))
            struct.pack_into('<h',pcm,i*2,value)
        source = folder/'source.wav'
        with wave.open(str(source),'wb') as audio:
            audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(rate);audio.writeframes(pcm)
        identity = hashlib.sha256(source.read_bytes()).hexdigest()
        metadata = folder/'.egc1'
        (metadata/'entries').mkdir(parents=True)
        row = dict(id=identity,path='source.wav',bytes=source.stat().st_size,rate=rate,samples=rate,channels=1,
                   state='needs-review',tags=['drums','snare'],preparation=dict(reasons=['uncertain-attacks'],bounds=dict(start=400,end=2400),attacks=dict(accepted=[400],rejected=[800])))
        (metadata/'library.json').write_text(json.dumps(dict(version=1,state='complete',entries=[])))
        (metadata/'workspace.json').write_text(json.dumps(dict(version=1,state='complete',entries=[row])))
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chrome,headless=True,args=['--no-sandbox'])
            try:
                page = browser.new_page(viewport=dict(width=1440,height=1000),accept_downloads=True)
                errors=[]
                page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto('http://127.0.0.1:8785/classifier/?no-sw')
                data = page.evaluate('''async () => {
                    const {Inference} = await import('./inference.js');
                    const audio = new Float32Array(8000);
                    for(let i=400;i<2400;i++){audio[i]=.6*Math.sin((i-400)*.41)*Math.exp(-(i-400)/500);}
                    return new Inference(()=>{}).analyse([audio],8000,null,false);
                }''')
                data.update(id=identity,pipeline='test')
                (metadata/'entries'/f'{identity}.json').write_text(json.dumps(data))
                page.evaluate('window.showDirectoryPicker=undefined')
                page.locator('#folder-input').set_input_files(str(folder))
                processor=page
                with processor.expect_popup() as popup:
                    processor.locator('#open-review').click()
                page=popup.value
                page.on('pageerror',lambda error:errors.append(str(error)))
                page.wait_for_selector('#admission:not([hidden])')
                assert page.locator('#filter').input_value() == 'pending'
                assert 'Excluded' in page.locator('#admission-state').inner_text()
                page.locator('[data-category="drums"]').click()
                page.locator('[data-role="kick"]').click()
                page.locator('[data-quality="keep"]').click()
                page.locator('#admission-start').fill('.05')
                page.locator('#admission-end').fill('.30')
                page.locator('#admission-bounds').click()
                page.locator('#admission-transients').fill('.05')
                page.locator('#admission-save').click()
                page.wait_for_function("document.querySelector('#admission-status').textContent.includes('Judgement saved')")
                exported = page.evaluate("window.egcReview.request('/api/export')")
                assert exported['reviews']['s-'+identity]['boundaries']['attackFrame']==400
                assert not exported['admissions']
                page.locator('#admission-approve').click()
                page.wait_for_function("document.querySelector('#admission-status').textContent.includes('Corrected sound added')",timeout=30000)
                assert 'Included' in page.locator('#admission-state').inner_text()
                processor.wait_for_function("document.querySelector('#bank-summary-note').textContent.startsWith('1 accepted samples')")
                assert processor.locator('#bank-summary').is_visible()
                page.locator('#admission-audition').click()
                page.wait_for_selector('#admission-player:not([hidden])')
                with page.expect_download() as event:
                    page.locator('#review-download').click()
                archive=root/'metadata.zip'
                event.value.save_as(archive)
                with zipfile.ZipFile(archive) as saved:
                    assert saved.testzip() is None
                    manifest=json.loads(saved.read('.egc1/library.json'))
                    assert len(manifest['entries'])==1
                    output=manifest['entries'][0]
                    assert output['samples']==2000
                    assert output['tags']==['drums','kick']
                    assert output['provenance']['start']==400 and output['provenance']['end']==2400
                    assert hashlib.sha256(saved.read(output['path'])).hexdigest()==output['id']
                    saved.extractall(folder)
                if args.library_tool:
                    result=subprocess.run([str(args.library_tool),'banks',str(folder)],capture_output=True,text=True,check=True)
                    assert any(line.startswith('0:0 ') and line.endswith(': 1') for line in result.stdout.splitlines()),result.stdout
                    print('Native library reader accepted the manually published sound',flush=True)
                    if args.check_prepare_guard:
                        before=(folder/'.egc1/library.json').read_bytes()
                        result=subprocess.run([str(args.library_tool),'prepare',str(folder),'--no-beats'],capture_output=True,text=True)
                        assert result.returncode != 0 and 'browser review approval' in result.stderr,result.stderr
                        assert (folder/'.egc1/library.json').read_bytes()==before
                        print('Native preparation refuses to overwrite approval-managed metadata',flush=True)
                page.set_viewport_size(dict(width=390,height=844))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.locator('#admission').screenshot(path='/tmp/egc-admission-mobile.png')
                page.set_viewport_size(dict(width=1440,height=1000))
                page.locator('#admission').screenshot(path='/tmp/egc-admission-desktop.png')
                # A new human flag withdraws the already approved output.
                page.locator('#issues input[value="leading-silence"]').check()
                page.locator('#admission-save').click()
                page.wait_for_function("document.querySelector('#admission-status').textContent.includes('Judgement saved')")
                assert 'Excluded' in page.locator('#admission-state').inner_text()
                processor.wait_for_function("document.querySelector('#bank-summary-note').textContent.startsWith('0 accepted samples')")
                page.locator('#admission-reject').click()
                page.wait_for_function("document.querySelector('#admission-status').textContent.includes('Sound excluded')")
                with page.expect_download() as event:
                    page.locator('#review-download').click()
                event.value.save_as(archive)
                with zipfile.ZipFile(archive) as saved:
                    assert not json.loads(saved.read('.egc1/library.json'))['entries']
                    workspace=json.loads(saved.read('.egc1/workspace.json'))
                    assert workspace['entries'][0]['state']=='rejected'
                    assert len(workspace['decisions']['s-'+identity])==2
                assert hashlib.sha256(source.read_bytes()).hexdigest()==identity
                assert not errors,errors
                print('PASS: excluded-only review, marked correction, explicit approval, native output, published audition, reflagging, rejection and retained decisions',flush=True)
            finally:
                browser.close()
finally:
    server.shutdown();server.server_close()
