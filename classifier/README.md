# Sample processor

A buildless, browser-only EGC1 library preparer at `/classifier/`.
No server, account, package installation or local helper is needed by users.

## Using it

Open the HTTPS page in a current desktop browser. Choose a sample folder (or a
USB stick), select the processing options and press **prepare samples**.
Chrome and Edge can save directly into the chosen folder. Other browsers use a
folder input and a metadata ZIP: extract its `.egc1` folder into the same
sample folder. Keep originals and `.egc1` together when moving a library.

Progress and completed results appear during processing. Pause finishes the
current sample before saving; reopening and running the same folder reuses
compatible completed analysis. Listen with the play buttons, filter/search the
results and use **edit category** to send a correction to manual review. An individual bad
file is reported without stopping the remaining sources.

Completed runs show all twelve banks, including empty banks, using this folder's
`banks.json`. Sample counts deduplicate identical audio and allow membership in
several banks. Extracted-kit banks show both kit and sound counts; sample banks
show source sounds rather than the instrument's assembled drum-kit choices.
Manual approval and exclusion refresh the summary. These are prepared catalogue
counts; the instrument still checks audio when loading it.

The saved processing report includes elapsed time, wall time spent in each
displayed processing stage, and metadata-write time/count. Stage times include
subsequent bookkeeping until the next stage begins; write time overlaps those
stages. The report's own final write is excluded. The mono core reduces native
analysis work; CLAP and Beat This! already infer on one channel. Long samples
use up to three CLAP crops, and beat tracking repeats the source for context.

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

Original audio is never rewritten. All writes are confined to `.egc1/`:

- `library.json`: version 1 accepted-only playable catalogue.
- `workspace.json`: all candidates, validation failures and manual admission history.
- `entries/<SHA256>.json`: portable pitch/transient/loop/vocal/gate analysis.
- `regions/`, `imports/`: silence-separated WAVs and source provenance.
- `kits/<source-id>/`: optional hit WAVs and native-format kit manifests.
- `banks.json`: standard 3-by-4 bank layout, created only if absent.
- `overrides.json`: explicit category corrections; existing overrides win.
- `browser/report.json`, `browser/raw-analysis/`, `browser/embeddings/`, `semantic/`: resumable browser
  classification results and report.

Identifiers hash exact audio-file bytes. Existing instrument favourites,
attention flags, resolution records and review files are read/preserved.
Browser analysis and embeddings carry their own preprocessing identities;
native readers can consume the published catalogue. Updated native preparation,
tag editing and review tools refuse to overwrite an approval-managed library;
make corrections in the browser. The compiled analysis
core and Beat This! preprocessing/postprocessing use the existing native source.

Pitch, transient, vocal, gate and beat analysis use the left source channel,
matching mono instrument playback. Transient and vocal cuts search backwards
up to 2 ms for a quieter zero crossing without moving past the detected attack.
Original stereo files retain their channel layout. Published playable regions
are mono and classification uses the same left channel. Compatible left-channel
embeddings and raw analysis are reused; right-channel embeddings are recomputed.
Manual labels, approvals and feedback survive reprocessing.
Prepare packs separately: each folder's audio and `.egc1` can be combined with
other prepared packs on the updated instrument, without a merge or combined pass.

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
node --test classifier/tests/*.test.mjs
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
models between test runs. `--models /path/to/models` serves the pinned model
bytes locally instead of downloading them; their SHA-256 checks still apply.
It also checks the real WASM left-only analysis, beat frontend, shared gate cuts
and invalidation of older analysis. Additional validation results are in `VALIDATION.md`.

See `THIRD_PARTY_NOTICES.txt` and the linked licence/source files for attribution.

## Detailed sample review

Use **review prepared samples** to open `/classifier/review/` with the selected
folder and generated metadata. It can also open a prepared folder independently.
Review opens without model downloads; approval runs the local WASM analysis core
on the corrected phrase. Attention flags, original/region/hit provenance,
source-frame marks, marked playback, loop-join audition and issue choices use
the native review format. Filenames, source paths and current categories are
visible immediately. Categories start from the current assignment or your saved
correction. The queue defaults to pending manual review, with search across names,
categories, notes and review reasons; folder/category/reason filters; and source,
category or duration sorting. Included and explicitly excluded sounds have
separate views. Filters and drafts survive reopening. New saves are recorded as
curation reviews; existing blind judgements and comparison history are preserved.

Automatic preparation separates analysis context from playable bounds. It checks
audible start/end positions, fresh attack evidence across frequency bands and
time scales, performed beat intervals and candidate loop joins. A loopable phrase
can sit inside the source with extra events at either end. Model confidence alone
does not approve a loop. Dense periodic triggers and ambiguous cuts/categories
go to **manual review** instead of becoming playable sounds or kit hits.

Both automatic checks and human issue reports can flag an exception. Flagged
sounds are excluded from `library.json`, generated kits and accepted bank counts.
In **review prepared samples**, use the **manual review** filter, choose clear
categories, mark corrected source bounds and save the judgement. The admission
panel lets you correct source-second chop positions, MIDI root and loop beat
count. Then explicitly approve the corrected sound, or exclude it. Saving a
judgement alone does not publish it. Resolve any instrument attention flag
separately before approval. **Audition published sound** plays the actual output.

Approval publishes a mono WAV of the marked phrase with rebased analysis. A
corrected extracted kit hit is admitted as a standalone sound; it does not
silently rejoin its old kit. Continuous sources over 60 seconds can also enter
manual review so a shorter phrase can be selected. Original predictions, failed
checks, source-frame marks, processing identity and admission decisions are
retained in the workspace/review export for subsequent pipeline evaluation.
These checks are conservative heuristics; broad listening validation is still
needed, especially for quiet attacks, dense rolls and unusual phrase lengths.

Direct folder access saves `.egc1/evaluation.json`; download mode also retains
reviews in IndexedDB, keyed by dataset identity, and exports `egc1-metadata.zip`.
Use `egc1-reviews.json` to export/import judgements independently. Existing legacy
exports are accepted. Import retains newer saved judgements. Explicitly resolving
an instrument flag is separate from saving a judgement.

Legacy `.toysampler` metadata is copied into `.egc1` before any new writes; the
catalogue is published last and old metadata is retained. Audio IDs, hand labels,
feedback and source-frame bounds remain unchanged. Never migrate a USB library
under a playing instrument, and update its reader before using `.egc1` alone.

The native `tools/audition/app.js` and `style.css` are the common player/UI source.
After editing them, synchronise this static copy and check both issue lists:

```sh
python3 classifier/sync-review-ui.py /path/to/sampler-checkout
python3 classifier/sync-review-ui.py /path/to/sampler-checkout --check
```

`review/library.js` provides the browser folder adapter; `review/bootstrap.js`
handles folder selection and browser persistence. `review/site.css` adapts the
shared player to the processor stylesheet, including the common site header,
spacing, typography and controls. No local HTTP API is needed.

The manual correction/approval integration check uses generated audio and the
real WASM core in Chrome:

```sh
python classifier/tests/admission-browser.py --chrome /path/to/chrome \
  --library-tool /path/to/ToyLibrary --check-prepare-guard
```

The visible curation/navigation check is `tests/curation-browser.py --chrome
/path/to/chrome`. It covers filters, sorted navigation, empty results, saved
preferences, draft recovery and desktop/mobile layouts using generated audio.
