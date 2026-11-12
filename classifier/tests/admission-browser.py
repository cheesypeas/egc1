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
                assert page.locator('#item-title').inner_text() == 'source.wav'
                assert page.locator('[data-category="drums"]').get_attribute('aria-pressed') == 'true'
                page.locator('[data-role="snare"]').click()
                page.locator('[data-role="kick"]').click()
                assert page.locator('#marked-range').inner_text().startswith('Your cut: 0.05000')
                # Waveform edits must feed the decision without a separate apply/save step.
                page.evaluate('state.draft.boundaries={attackFrame:410,endFrame:2350}; marksChanged()')
                assert page.locator('#admission-start').input_value() == '0.051250'
                assert page.locator('#admission-end').input_value() == '0.293750'
                page.locator('#admission-transients').fill('.05')
                page.locator('#curate-add').click()
                processor.wait_for_function("document.querySelector('#bank-summary-note').textContent.startsWith('1 accepted samples')",timeout=30000)
                assert processor.locator('#bank-summary').is_visible()
                assert page.locator('#queue .queue-item').count()==0
                page.locator('#filter').select_option('accepted')
                page.wait_for_selector('#admission:not([hidden])')
                assert 'Included' in page.locator('#admission-state').inner_text()
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
                    assert output['samples']==1940
                    assert output['tags']==['drums','kick']
                    assert output['provenance']['start']==410 and output['provenance']['end']==2350
                    assert hashlib.sha256(saved.read(output['path'])).hexdigest()==output['id']
                    analysis=json.loads(saved.read('.egc1/entries/'+output['id']+'.json'))
                    assert analysis['loop']['transients'][0]==0
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
                page.locator('.feedback-details summary').click()
                page.locator('#issues input[value="leading-silence"]').check()
                page.locator('#curate-exclude').click()
                processor.wait_for_function("document.querySelector('#bank-summary-note').textContent.startsWith('0 accepted samples')")
                with page.expect_download() as event:
                    page.locator('#review-download').click()
                event.value.save_as(archive)
                with zipfile.ZipFile(archive) as saved:
                    assert not json.loads(saved.read('.egc1/library.json'))['entries']
                    workspace=json.loads(saved.read('.egc1/workspace.json'))
                    assert workspace['entries'][0]['state']=='rejected'
                    assert len(workspace['decisions']['s-'+identity])==2
                assert hashlib.sha256(source.read_bytes()).hexdigest()==identity
                # Loops keep explicit, mandatory beat counts and use the marked phrase exactly.
                pcm=bytearray(16800*2)
                for onset in [400,4400,8400,12400]:
                    for i in range(1600):
                        struct.pack_into('<h',pcm,(onset+i)*2,round(18000*math.sin(i*.39)*math.exp(-i/300)))
                loopfile=folder/'loop.wav'
                with wave.open(str(loopfile),'wb') as audio:
                    audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(8000);audio.writeframes(pcm)
                loopid=hashlib.sha256(loopfile.read_bytes()).hexdigest()
                looprow=dict(id=loopid,path='loop.wav',bytes=loopfile.stat().st_size,rate=8000,samples=16800,channels=1,state='needs-review',tags=['loops','drum-loop'],preparation=dict(reasons=['uncertain-loop-phrase'],bounds=dict(start=400,end=16400),attacks=dict(accepted=[400,4400,8400,12400],rejected=[])))
                role=dict(samples=16800,rate=8000,transients=[400,4400,8400,12400],beats=[],downbeats=[],hasRoot=False)
                (metadata/'entries'/f'{loopid}.json').write_text(json.dumps(dict(version=1,id=loopid,pipeline='test',pitch=role,loop=role,vocal=role)))
                (metadata/'workspace.json').write_text(json.dumps(dict(version=1,state='complete',entries=[looprow])))
                (metadata/'library.json').write_text(json.dumps(dict(version=1,state='complete',entries=[])))
                page.reload()
                page.locator('#review-folder-input').set_input_files(str(folder))
                page.wait_for_selector('#workspace:not([hidden])')
                assert page.locator('#loop').is_checked()
                assert page.locator('#sound-corrections').get_attribute('open') is not None
                page.locator('#curate-add').click()
                page.wait_for_function("document.querySelector('#admission-status').textContent.includes('Enter the beat count')")
                assert not page.evaluate("window.egcReview.request('/api/export')")['admissions']
                page.locator('#admission-beats').fill('4')
                page.locator('#curate-add').click()
                page.wait_for_function("document.querySelector('#current-pack-counts').textContent.startsWith('1 ready')")
                with page.expect_download() as event:
                    page.locator('#review-download').click()
                event.value.save_as(archive)
                with zipfile.ZipFile(archive) as saved:
                    output=json.loads(saved.read('.egc1/library.json'))['entries'][0]
                    analysis=json.loads(saved.read('.egc1/entries/'+output['id']+'.json'))
                    assert output['samples']==16000 and output['provenance']['start']==400 and output['provenance']['end']==16400
                    assert analysis['loop']['beats']==[0,4000,8000,12000]
                    assert analysis['loop']['beatPeriod']==4000
                assert not errors,errors
                print('PASS: excluded-only review, marked correction, explicit approval, native output, published audition, reflagging, rejection and retained decisions',flush=True)
            finally:
                browser.close()
finally:
    server.shutdown();server.server_close()
