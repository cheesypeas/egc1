# Sample processor

A buildless, browser-only ToySampler library preparer at `/classifier/`.
No server, account, package installation or local helper is needed by users.

## Using it

Open the HTTPS page in a current desktop browser. Choose a sample folder (or a
USB stick), select the processing options and press **prepare samples**.
Chrome and Edge can save directly into the chosen folder. Other browsers use a
folder input and a metadata ZIP: extract its `.toysampler` folder into the same
sample folder. Keep originals and `.toysampler` together when moving a library.

Progress and completed results appear during processing. Pause finishes the
current sample before saving; reopening and running the same folder reuses
compatible completed analysis. Listen with the play buttons, filter/search the
results and use **edit category** to save a manual override. An individual bad
file is reported without stopping the remaining sources.

Classification, silence splitting and loop timing are enabled by default.
Filename/folder hints can be disabled for acoustic-only evaluation. Extracted
hit kits are optional. Silence-separated regions remain ordinary samples;
extracted kits are generated only from drum loops.

First use downloads approximately 113 MiB of CLAP audio weights, plus 80 MiB
of Beat This! weights when loop timing is enabled. Downloads have pinned SHA-256
checks and use CacheStorage. The page shell is cached by a service worker.
After the required assets are cached, processing works offline. Browser storage
can be evicted; results saved into the sample folder survive that eviction.

WAV PCM/float and PCM AIFF can be scanned in blocks, including long CD sources.
FLAC and Ogg Vorbis decoding depends on the browser. Playable samples must be
mono/stereo, 8–192 kHz and shorter than 60 seconds. Continuous longer regions
are reported for manual splitting. Large compressed files should be converted
to WAV first. Models run in one background worker; processing speed depends on
the computer and sample length. Similarity scores are not probabilities and
suggested categories/cuts still need listening checks.

## Metadata compatibility

Original audio is never rewritten. All writes are confined to `.toysampler/`:

- `library.json`: version 1 ready-only catalogue (failed rows remain explicit).
- `entries/<SHA256>.json`: portable pitch/transient/loop/vocal/gate analysis.
- `regions/`, `imports/`: silence-separated WAVs and source provenance.
- `kits/<source-id>/`: optional hit WAVs and native-format kit manifests.
- `banks.json`: standard 3-by-4 bank layout, created only if absent.
- `overrides.json`: explicit category corrections; existing overrides win.
- `browser/report.json`, `browser/embeddings/`, `semantic/`: resumable browser
  classification results and report.

Identifiers hash exact audio-file bytes. Existing instrument favourites,
attention flags, resolution records and review files are read/preserved.
Browser analysis and embeddings carry their own preprocessing identities;
future native preparation can deliberately recompute them rather than silently
mixing the browser resampler with the PC ffmpeg frontend. The compiled analysis
core and Beat This! preprocessing/postprocessing use the existing native source.

## Hosting and development

Serve this repository as ordinary static files over HTTPS. GitHub Pages works;
COOP/COEP headers are not required. `onnxruntime-web` uses its single-thread CPU
WASM backend. The only external requests are page fonts and pinned model files;
no audio, paths, embeddings or classification results are uploaded.

For development, serve the repository root over localhost (for example
`python3 -m http.server 8780 --bind 127.0.0.1`) and open `/classifier/`.
Append `?no-sw` to bypass service-worker registration in a fresh test profile.
After changing any shell asset, increment the cache name in `sw.js`.

No JS build step is required. `vendor/analysis.mjs` and `analysis.wasm` are
prebuilt from the included corresponding source. To rebuild with Emscripten
4.0.10 installed:

```
python3 classifier/native/build.py --emscripten /path/to/emsdk/upstream/emscripten
```

The browser adapter is `native/browser.cpp`. `native/source-manifest.json`
identifies the unchanged ToySampler analysis source snapshot. Third-party
source and licence notices are retained alongside it. Do not commit audio
fixtures, model weights, browser profiles or generated library metadata.

The ONNX Runtime Web files are from the npm `onnxruntime-web@1.22.0` tarball
with SHA-512 integrity:
`Ud/+EBo6mhuaQWt/OjaOk0iNWjXqJoeeMFr6xQEERZdIZH2OWpGzuujz7lfuOBjUa6TEE/sc4nb7Da5dNL34fg==`.
Model source revisions and SHA-256 hashes are in `assets.json`. Fixed CLAP text
embeddings are bundled in `prototypes.json`, avoiding a second text-model
download. `mel-filters.json` contains the exact 48 kHz Slaney mel filter bank.

Run primitive/interoperability checks with Node 22+:

```
node --test classifier/tests/primitives.test.mjs
```

For an end-to-end test with generated samples, install Playwright in a separate
developer environment and run:

```
python classifier/tests/browser.py --chrome /path/to/chrome
```

This tests real public model downloads, silence-separated regions, corrupt-file
isolation, pause/resume, ZIP integrity, saved analysis reuse and fresh inference
offline. The test starts/stops its own localhost server and uses a temporary
browser profile. `--profile /outside/the/repository/profile` can retain downloaded
models between test runs. Additional validation results are in `VALIDATION.md`.

See `THIRD_PARTY_NOTICES.txt` and the linked licence/source files for attribution.
