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

Review styling follow-up: rendered header geometry, body/heading fonts and primary
button styling match the processing page. The open-library folder controls become
compact while keeping all actions accessible. Desktop and 390px mobile layouts,
primary button contrast, playback, native review import, folder persistence and
processing-to-review handoff passed after applying the shared stylesheet.

## Processing investigation and bank summary — 2026-11-11

The completed Hotcakes report records 67 min 30 s for 159 source files, 207
prepared samples and 13 extracted hits, with zero reused analyses/embeddings.
57 samples exceed ten seconds. From the cached loop analyses and browser context
rule, 145 samples qualify for beat inference, expanding to approximately 78.3
minutes of repeated audio. These workload counts explain why source-file count
and dropping one analysis channel do not imply proportionate processing speed.
They do not measure the share of elapsed time taken by each stage. The old
report has no stage timings, so it cannot establish an inference-speed regression.
The mono commit leaves the model weights, one-thread WASM runtime, crop policy
and beat repetition policy unchanged.

Two exported Future Music CD1 judgements are retained in
`tests/boundary-review-cases.json` as open accuracy failures. Both marked attacks
are about 20.4 ms after the extracted region start, consistent with the splitter's
fixed 20 ms pre-roll and 5 ms envelope bins. The hat's marked end is 52.8 ms
earlier, consistent with the fixed 50 ms post-roll. The drum loop's marked end is
161.3 ms earlier and its cached loop-boundary confidence is zero. Its category
agrees with the reviewer; the hat was predicted as cymbal. The current change
does not tune cuts, beat tracking or classification against these two examples.
Original samples, prepared-library metadata and saved reviews were read only.

The completion panel counts unique prepared audio against the folder's actual
bank configuration, includes empty banks and separates kit/sound counts.
Catalogue publication drops one redundant full-manifest write per completed
source while retaining partial-region pause checkpoints. Reports retain run
options, stage wall times and overlapping metadata-write time/count.

Node primitive, pipeline and review checks pass. The real Chrome integration
passes WASM left-channel analysis, classification, silence-separated regions,
malformed-file isolation, immediate pause/resume, ZIP integrity, cached reuse,
offline processing, report timings and all twelve bank-summary entries. Desktop
and 390 px mobile screenshots were inspected; mobile has no horizontal overflow.
Pipeline checks also cover category-correction summaries, duplicate placements,
custom bank predicates and pausing after an intermediate region. These checks
verify the new workflow; they do not resolve the recorded accuracy failures.

### Follow-up accuracy audit

The reviewed Track 02 loop exposes an acceptance error, beyond a model prediction
error. Its internal beat intervals are predominantly 24,696 frames (107.14 BPM),
but the wrap interval is 32,175 frames. `ResolveLoopBarReference` derives the saved
25,630.875-frame period (103.23 BPM) from full region length divided by eight
beats. Its confidence of 1 measures downbeat-phase voting, without checking that
the source duration closes the beat cycle. `BuildLoopBoundaryAnalysis` then skips
end-fragment detection because `HasReliableLoopGrid` accepts that confidence.
The user's marked end is region frame 197,933, exactly an existing transient;
the padded region instead ends at frame 205,047. A reliable beat phase cannot be
used as evidence that the extracted region is a complete, correctly bounded loop.

Fresh runs of the current WASM core, without model inference, reproduce seven
transients on Track 06's region 0–40,925, thirty on its region 413,158–428,125,
and twelve on Track 25's region 387,198–420,645. These match the saved analysis.
The thirty-marker case has roughly 8 ms spacing through one sustained region;
the Track 25 case includes a run of roughly 9.2 ms intervals. These are concrete
candidates for the reported repeated triggering during decay. The detector
combines two spectral-flux windows, adaptive spectral whitening and compression,
a 6 ms minimum spacing and 2/10 ms before/after energy checks. Those checks can
admit local fluctuations without establishing a distinct new musical event.
Increasing minimum spacing alone would risk discarding genuine flams and ghosts.

The review adapter also auditions full extracted regions; it does not apply
`LoopPlaybackEnd`. Any boundary correction must be evaluated through the sampler
playback path as well as region review, with the two behaviours made explicit.
Another consistency issue remains: native cuts and pitch use the left channel,
while CLAP still chooses the strongest channel. Classification can therefore
describe a channel discarded by instrument playback.

Recommended next work is to establish and test the preparation contract: separate
analysis context from playable bounds; estimate timing from performed intervals;
validate loop seams even with a confident beat phase; distinguish attack
candidates from accepted chops; and expose uncertainty instead of implying that
all automatically found regions have valid musical boundaries. These are proposed
pipeline changes, not changes deployed with the bank-summary update.

## Left-channel analysis and zero-crossing cuts — 2026-11-11

- Rebuilt the included ToySampler `802b986` analysis snapshot with pinned
  Emscripten 4.0.10. Corresponding-source SHA-256 hashes were verified.
- Real WASM checks in a separate Chrome profile confirm that louder unrelated
  right-channel hits cannot change pitch, transients, vocal cuts, gate strengths
  or Beat This! frontend features. Source channel counts remain intact.
- Isolated attacks retain zero-amplitude cut positions shared with the gate.
  Left-only silence remains silent to timing analysis even with right-channel audio.
- Fresh pitch/loop/vocal versions 5/8/2 are reusable; old pipeline identities
  and analysis versions are rejected for recomputation.
- All 16 JavaScript primitive/review tests and shared review-asset checks pass.
- Full generated-folder Chrome regression passed: classification, separated
  regions, malformed-file isolation, pause/resume, ZIP CRC validation, saved
  analysis reuse and fresh offline inference after reload. This run served the
  pinned model bytes locally; the production model URLs are unchanged.
- Shell cache advanced to v9 so the updated JS and WASM install together.

These checks establish execution and compatibility, not listening quality across
all sample packs or deployment of the updated instrument firmware/plugin.

## Validated preparation and manual admission — 2026-11-12

The browser now publishes only accepted sounds. All original candidates, failed
checks and explicit admission decisions remain in a separate workspace. A human
issue report withdraws a sound; saving a judgement is separate from approving
corrected audio. Source audio is unchanged. Classification follows the left
channel used for playback. Compatible raw analyses/left-channel embeddings are
reused without rerunning the model solely for the new validation identity.

The checked loop search on the reviewed Track 02 region found relative frames
902–197,933, versus the user's 901–197,933. The reviewed Track 06 hat's audible
bounds were 879–22,973 versus the user's 903–22,980 (less than 0.6 ms apart).
The thirty-marker sustained region retained two supported candidates and rejected
twenty-eight; its ambiguous attacks send it to manual review. These observations
are diagnostic examples, not independent proof of general accuracy. The hat's
wrong category remains a manual correction, not a claim of classifier retraining.

Checks cover ringing-decay rejection, real attacks 8 ms apart, interior phrase
search with multiple surrounding hits, ambiguous loops/categories, DC/silence,
left-channel cache migration, write-failure withdrawal, stale review revisions,
changed source audio, approval persistence, long-source manual rescue and kit-hit
withdrawal. A collision regression ensures forced raw reanalysis cannot overwrite
an approved manual root when source/output bytes have the same audio identity.

Real Chrome integration verifies an excluded-only library, corrected bounds and
chops, explicit approval, published-output audition, review-to-processor bank
updates, valid ZIP hashes/provenance, renewed human flagging and rejection with
decision history intact. The native `ToyLibrary banks` reader accepts the export;
the updated native preparation command refuses to overwrite approval-managed
metadata. Desktop/390 px layouts have no horizontal overflow. The full processing
integration also passes real model inference, pause/resume, cache reuse, malformed
file isolation and fresh inference offline. The shared native/browser review UI
remains synchronised. Native library integration and Python review checks pass.

No broad sample-pack accuracy score or processing-speed improvement is established
by these tests. The stage diagnostics are needed to measure the next real run.


## Visible library curation — 2026-11-12

Names, source paths, current categories and review reasons are shown immediately;
there is no reveal step or post-save prediction-rating card. Category controls
start from the current assignment or saved correction. Pending review is the
default; explicit exclusions have a separate view. Search, category/folder/reason
filters and source/category/duration sorting apply to browsing and save-next.
Preferences and unsaved judgements survive navigation/reopening. New saves record
`assisted: true` and `reviewMode: curation`; historical blind judgements are not
rewritten when opening the library. Legacy comparison records remain exportable.

Chrome checks pass visible details, natural source ordering, combined filters,
sorted next/save-next, empty results, draft recovery, saved organisation settings,
unchanged historical reviews, mobile queue access and no horizontal overflow.
The full correction/admission test still passes publication, reflagging, bank
updates, valid exported audio and native reader compatibility. Shared review
assets match and Python review/API regression checks pass.
