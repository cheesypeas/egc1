#!/usr/bin/env python3
"""Check current-folder and parent-collection loop consolidation in Chrome."""
import argparse,functools,hashlib,json,math,struct,tempfile,threading,wave,zipfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
args=argparse.ArgumentParser();args.add_argument('--chrome',required=True);args=args.parse_args()
repo=Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',8792),functools.partial(Handler,directory=str(repo)))
threading.Thread(target=server.serve_forever,daemon=True).start()
def pack(root,specs):
 metadata=root/'.egc1';(metadata/'entries').mkdir(parents=True)
 rows=[]
 for name,gain,pattern in specs:
  rate=8000;audio=[0.0]*(rate*2)
  for at in pattern:
   start=round(at*rate)
   for i in range(1200):audio[start+i]+=gain*.6*(math.sin(i*.071)+.15*math.sin(i*1.37))*math.exp(-i/200)
  file=root/name
  with wave.open(str(file),'wb') as output:
   output.setnchannels(1);output.setsampwidth(2);output.setframerate(rate);output.writeframes(b''.join(struct.pack('<h',round(max(-1,min(1,sample))*32767)) for sample in audio))
  identity=hashlib.sha256(file.read_bytes()).hexdigest()
  row=dict(id=identity,path=name,bytes=file.stat().st_size,state='ready',tags=['loops','drum-loop'],channels=1,rate=rate,samples=len(audio))
  rows.append(row);role=dict(samples=len(audio),rate=rate,transients=[0,4000,8000,12000],beats=[0,4000,8000,12000],downbeats=[0],hasRoot=False)
  (metadata/'entries'/f'{identity}.json').write_text(json.dumps(dict(version=1,id=identity,pipeline='test',pitch=role,loop=role,vocal=role)))
 (metadata/'library.json').write_text(json.dumps(dict(version=1,state='complete',entries=rows)))
 return rows
try:
 with tempfile.TemporaryDirectory(prefix='egc-similarity-ui-') as temporary:
  root=Path(temporary)/'Sources';a=root/'A';b=root/'B'
  pack(a,[('a.wav',1,[0,.5,1,1.5]),('variant.wav',.3,[0,.5,1,1.5])])
  pack(b,[('copy.wav',.7,[0,.5,1,1.5]),('different.wav',1,[0,.25,.75,1.5])])
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=args.chrome,headless=True,args=['--no-sandbox'])
   page=browser.new_page(viewport=dict(width=1440,height=1000));errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   page.goto('http://127.0.0.1:8792/classifier/review/');page.evaluate('window.showDirectoryPicker=undefined')
   page.locator('#review-folder-input').set_input_files(str(a));page.wait_for_function("!document.querySelector('#deduplicate-loops').disabled")
   page.locator('#deduplicate-loops').click();page.wait_for_function("document.querySelector('#loop-similarity-status').textContent.includes('1 very similar')")
   page.locator('#filter').select_option('excluded');assert page.locator('#queue .queue-item').count()==1
   assert 'Similar loop excluded' in page.locator('#admission-state').inner_text()
   assert 'a.wav' in page.locator('#admission-reasons').inner_text()
   page.locator('#collection-folder-input').set_input_files(str(root));page.wait_for_function("document.querySelector('#collection-name').textContent === 'Sources'")
   page.locator('#deduplicate-loops').click();page.wait_for_function("document.querySelector('#loop-similarity-status').textContent.includes('2 representatives kept')")
   assert '2 unique sounds ready' in page.locator('#inventory-total').inner_text()
   with page.expect_download() as event:page.locator('#review-download').click()
   archive=Path(temporary)/'collection.zip';event.value.save_as(archive)
   with zipfile.ZipFile(archive) as saved:
    manifests=[json.loads(saved.read(f'{name}/.egc1/library.json')) for name in ['A','B']]
    assert sum(len(manifest['entries']) for manifest in manifests)==2
    assert 'different.wav' in [row['path'] for manifest in manifests for row in manifest['entries']]
   assert not errors,errors
   page.screenshot(path='/tmp/egc-loop-similarity-desktop.png',full_page=True)
   browser.close()
 print('Loop similarity browser checks passed')
finally:server.shutdown()
