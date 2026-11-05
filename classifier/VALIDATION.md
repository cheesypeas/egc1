# Browser port validation — 4 November 2026

Verified in installed desktop Google Chrome on Linux. Browser tests used fresh
or dedicated test profiles; no instrument, USB stick or user Chrome profile was
changed. This verifies execution, interoperability and workflow, not classifier
accuracy across sample packs.

- Full GUI, direct folder-write path (browser OPFS directory handle), five valid
  output sounds from four source files plus one deliberately broken WAV. Two
  hits were split from a silence-separated source. Kick, pad (with name hints)
  and Amen drum-loop destinations appeared correctly. One broken source was
  reported while all valid sounds completed.
- First run with beat timing disabled: about 17.5 s for those five sounds on
  this PC. Subsequent run: about 0.4 s, five reused analyses/embeddings and zero
  new embeddings. A manually edited pad-to-lead category survived the rerun.
  These are small-fixture observations, not general processing-speed claims.
- A separate full run with the original Amen break and timing/kits enabled
  completed in about 44 s: beat grid present, one kit, eight hits, no failures.
- Existing native `ToyLibrary banks` accepted both exported libraries: drum and
  synth sample choices, drum loop and extracted-kit choice were available.
- Native processing of the same five playable sounds matched browser sample
  counts, rates, transient positions, vocal start/default cuts and gate starts;
  root values agreed within 0.001 MIDI semitones. Derived WAV identities were
  independently checked against SHA-256 of exported file bytes.
- Public pinned CLAP and Beat This! model URLs successfully downloaded in Chrome
  with CORS and SHA-256 verification. Model weights are not stored in Git.
- Folder-input fallback produced a ZIP with valid CRCs and only `.egc1/`
  members. Pause/resume reused the completed file instead of reclassifying it.
- After the page and CLAP model were cached, the browser was set fully offline,
  the page reloaded, and a fresh multi-region source produced two new sounds.
- Existing favourites and attention metadata retained its exact stored data;
  resolved attention tokens were interpreted correctly by the result filter.
- Network requests observed during classification/export/offline tests were GET
  asset/model requests. No sample audio, filenames, embeddings or labels were
  sent to an audio-processing server.
- Desktop 1440 px and mobile 390 px screenshots inspected; no document overflow
  at 390 px. Audition, manual category save and filtering exercised in Chrome.
- Primitive checks cover SHA-256 boundaries and large-file streaming, PCM24
  round-trip including RIFF padding, antiphase stereo, silence segmentation,
  write path restrictions, ZIP records, category timing gates and bank schema.
- The JS CLAP log-mel frontend matches selected points from the native Python
  Transformers 4.45.2/NumPy 1.26.4 frontend within 0.0002 dB on an exact synthetic
  float32 signal. The golden values and their provenance are included in tests.

Not yet verified in Firefox/Safari or on Windows/macOS. Direct folder saving
requires a browser implementing the writable File System Access picker; the
folder-input/ZIP fallback was exercised in Chrome. Beat/cut quality on a broad
sample collection remains a listening/evaluation task.

The included reproducible browser integration test also passed against the final
page code with a dedicated profile: deterministic immediate pause, resume,
classification, separated regions, corrupt-file isolation, ZIP CRC validation,
cache reuse and new inference after offline reload. Buffered page-asset commits
avoid an observed streamed CacheStorage failure on the large WASM runtime.

## EGC1 review and metadata migration — 2026-11-05

- Browser review tested against all 19 fetched instrument-attention samples,
  including separated regions. All 19 existing native reviews import and survive.
- Direct-folder writes, fallback IndexedDB save/reload, metadata ZIP output,
  source/marked playback, undo and explicit flag resolution verified.
- The processor hands its selected folder to the static review page. Review
  opens without model downloads or calls to a local API.
- Blind session data omits filenames and predictions. All 18 issue choices
  round-trip through the native-compatible format.
- Desktop and 390-pixel mobile layouts checked; no horizontal overflow or
  JavaScript page errors. Zero-amplitude lines remain above the waveform.
- Processing regression rerun with generated audio and pinned local model bytes:
  classification, silence regions, malformed files, pause/resume, cached analysis,
  `.egc1` ZIP contents and offline processing passed.
- Node tests cover legacy migration, source-frame region/kit identities,
  changed audio, review import/export, independent review sessions and save failure.
