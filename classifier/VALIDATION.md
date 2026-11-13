# Browser port validation — 4 November 2026

## Rate-aware pitch and Bass/Lead investigation — 2026-11-13

The native and WASM pitch window now retains at least the 48 kHz detector's
duration at high input rates. A second numerical failure was reproduced at
192 kHz: aubio could return confidence above one with fictitious MIDI-zero or
ultrasonic pitches. Impossible estimates are excluded from the agreement check,
with a majority-valid-frame requirement and the existing minimum evidence and
80% note agreement. Ordinary low-confidence frames still require agreement.

- All 75 tone cases passed in both the compiled native core and rebuilt WASM:
  roots 24/33/45/60/69.23, rates 8/44.1/48/96/192 kHz, durations .25/1/2 seconds.
  Pitch errors stayed below .06 semitone. Embedded tuning, acoustic/playback
  separation, silence, noise, changing melodies, short audio and full-analysis
  parity checks passed.
- The real Chrome pitch-only API passed with left-channel isolation, high-rate
  low bass, embedded tuning and unchanged source PCM, without model downloads.
  Admission/chop and processing-preview Chrome regressions passed.
- Cached high-rate pitch and unconfirmed synth roots upgrade once through the
  pitch-only API. Tests verify unchanged beat/vocal maps, reused embeddings,
  no full inference pass and reuse on the next run. Existing manual tuning and
  approval preservation checks passed. Portable browser pitch schema v5 remains
  compatible with the deployed instrument. Native local cache version is 6;
  its portable reader continues accepting v5.
- The nine Node suites passed. Native core check linked the actual shared
  SampleAnalysis/LoopBeatContext implementation with bundled aubio; no firmware
  or plugin was installed on the instrument.

The EgcSamples parent catalogue audit found 99 Bass and 7 Lead entries. Browser
roles are assigned from CLAP scores and nearest filename/folder hints; measured
root does not select Bass/Lead. A regression covers unchanged Lead assignment
with low/mid/high root estimates. The current Lead prompts describe bright and
high-pitched notes, a plausible source of register/timbre bias rather than a
confirmed correction for particular sounds. The folder has no explicit Lead/LD
source-name labels and no saved Lead judgements to evaluate misclassifications.
Category assignments and prompt vectors were not changed on this evidence.

## Optional synth and vocal pitch/attack checks — 2026-11-13

Preparation policy v4 retains uncertain root and attack estimates as warnings
for pads, leads, bass and vocals. Whole-loop validation remains independent of internal
chop uncertainty. Silent audio, ambiguous categories, unsupported loop phrases,
human rejections and instrument attention flags continue to require review.
Manual approval can leave the root unset for these sounds; an explicit
wrong-root correction still requires a note. Preparation policy changes reuse
the existing model/analysis caches and preserve manual approvals.

All eight Node suites passed. New cases cover all three synth roles, unconfirmed
roots and empty chops, explicit tuning corrections, unchanged checks for keys
and unspecified synths, rejected decay chops, silence and ambiguous categories.
Chrome admission/chop regression also approved legacy pad/lead/bass candidates
with blank root/chop fields; curation and collection regression passed.

A read-only recheck followed by backed-up metadata updates admitted 224 synth
entries and 31 loop entries across the EgcSamples parent and prepared siblings.
These are catalogue placements, not unique sounds across folders. Eight older
loops still failed phrase checks and one duplicate stayed excluded. Existing
published cuts and manual decisions were checked unchanged; reviews, category
overrides and instrument feedback were not written. Each updated catalogue keeps
a receipt and replaced metadata in `.egc1/policy-backups/2026-11-13-synth-loop-warnings-*`.

Pitch investigation used the existing WASM detector on clean two-second sine
waves at 32.7032, 55, 110 and 440 Hz at 44.1/48/96/192 kHz. Thirteen of sixteen
cases returned the expected root. The 32.7032 Hz tone was unconfirmed at 96 and
192 kHz; 55 Hz was unconfirmed at 192 kHz. The fixed 4096-sample pitch window
loses low-frequency coverage at higher sample rates. This release changes
acceptance policy, not the pitch estimator. Longer rate-aware bass windows and
stable-body pitch evidence need separate detector validation.

## Instrument export — 2026-11-12

- Fourteen export checks passed, including the existing native `ToyLibrary
  banks` reader accepting the exported drum-loop cut and extracted kit.
  Coverage includes dependency selection, exact bytes, unchanged exports with
  zero writes, same-size metadata edits, destination damage, protected feedback
  and recordings, withdrawn samples/hits, removed collection catalogues,
  missing/changed sources, stop/resume, disk-full rollback, legacy sources,
  case collisions, unique sound counts and source/destination overlap.
- Chrome integration passed for exports from processing and review, repeated
  exports, withdrawing an existing exported sound, linked sibling folders,
  concurrent processing lock refusal and 390-pixel layout. Destination writes
  used isolated browser storage; no USB stick or user library was changed.
- Existing curation, admission/chop and processing-preview Chrome regressions,
  all eight Node test suites, and shared native/browser review UI checks passed.
- A read-only dependency plan for the then-current EgcSamples parent catalogue
  selected 453 unique samples and 159 kit hits: 1,523 files, approximately 1,004 MiB.
  All five prepared catalogues selected 3,113 files, approximately 1,490 MiB.
  The complete working collection contained about 14,650 files / 3.18 GiB.
  These are inventory measurements, not USB transfer-speed benchmarks.

Reproduce export checks with Node 22:
`EGC_TOY_LIBRARY=/path/to/ToyLibrary node classifier/tests/instrument-export.test.mjs`.
The optional native-reader check is skipped when that variable is absent.
Browser workflow: `python classifier/tests/instrument-export-browser.py --chrome /path/to/chrome`.

## Initial browser port

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


## Library building, collection totals and playable preview — 2026-11-12

The main review action now records feedback and approves/rejects the sound, updates
counts and advances. Optional notes no longer require a separate judgement save.
Waveform marks update the approval fields immediately; approval uses those exact
source frames. Default playback starts at proposed playable bounds rather than
padded analysis context. Root/category/start edits are emphasised for synths;
loop approval requires a beat count and retains exact marked endpoints.

The later saved Future Music CD1 reviews are retained as reference evidence in
`tests/curation-review-cases.json`. Five Track 01 start proposals differ from the
human marks by 2–12 samples (under 0.3 ms), while the old default review audio
included about 20–24 ms of context. The Track 12 loop has matching starts but a
substantially different end; the merged Track 01 region remains a manual phrase
selection. This change corrects audition/approval consistency; it does not claim
that arbitrary loop boundaries or merged phrases are now automatically correct.

Chrome checks cover single-action approval/rejection, exact marked exported WAV
bounds, a zero-relative first drum chop, mandatory loop beat count, a closed
four-beat grid, unchanged original audio, native-reader compatibility and bank
updates. Category inventory checks cover duplicate audio across siblings, zero
categories, pending-versus-ready states, legacy kit hashes and unreadable metadata.
Parent/sibling browsing passes with both file-input/ZIP mode and real writable
OPFS directory handles. The parent receives a collection index, never a generated
playable catalogue. Changing packs preserves independent outputs, queue settings
and drafts. Desktop/mobile layouts and shared/native review regressions pass.

Collection counts read saved catalogues and audio presence without rerunning
models or rehashing whole packs. They are a catalogue inventory, not a new audio
quality benchmark. Pack metadata/review histories remain independent.

## Similar loop consolidation (2026-11-12)

Publication compares left-channel waveforms at 2 kHz and energy envelopes in
three frequency bands. It requires waveform correlation >= 0.995, agreement
within each of eight sections, and band-envelope correlation >= 0.98. Duration
must agree within 0.5%, or every repetition of an integer-length alternative
(up to eight repetitions) must match. Alignment searches cover +/-8 ms.
Groups compare directly against their retained representative to avoid
transitive chains collapsing distinct material. These thresholds are similarity
criteria, not probabilities or a guarantee of musical interchangeability.

Seven targeted tests cover gain/offset edits, changed rhythms and fills,
repeated phrases, deterministic publication, manual representative changes,
promotion after rejection, sibling packs, category boundaries, favourites and
instrument attention. Existing primitive, pipeline, preparation, review,
admission and inventory suites pass. Real Chrome checks cover the new control,
excluded-member explanation, combined sibling totals, and collection-relative
metadata ZIP contents; the existing curation/browser workflow also passes.

A read-only comparison of the 93 whole-file drum-loop entries from the previous
Sam Samples manifest excluded ten very similar alternatives in eight groups,
retaining 83. These counts describe that subset of the old run, not a new
validation of its loop classifications or the 117 generated fragments. No user
audio or live instrument metadata was changed for this check. Initial comparison
took approximately 11 seconds on the development machine; fingerprints and pair
results are cached for subsequent publications.

## Performed phrase cuts against saved approvals — 2026-11-12

Seven saved Future Music CD1 loop approvals were compared read-only with the
new phrase search. All seven beat counts match. Maximum absolute start error
is 0.681 ms and end error 6.282 ms; the old proposals differed by as much as
283 ms. These are agreement measurements against seven human marks, not a
listening certification of the remaining library. No source audio or live
folder metadata was changed. The generic comparison can be repeated with
Node 22: `node classifier/tests/check-reviewed-loops.mjs FOLDER --check`.

Preparation v2 fits performed onset spans against beat/subdivision evidence,
retains the earliest supported start, and checks the join. Non-binary beat
spans require bar evidence; melodic/vocal phrases also require matching
performed context. Rejected chop candidates warn separately from whole-loop
admission, and prevent automatic kit generation. Published clocks use the
fitted phrase grid, so missed or extra raw detector beats cannot reconstruct
the old timing. Original raw analysis remains available for evaluation.

A broader read-only scan of 64 loop-labelled candidates proposes 50 as
automatically eligible and withholds 14. This is candidate eligibility, not
50 auditioned or certified loops. The scan took about 27 seconds on this
development machine; no neural model was invoked. Both previously admitted
bad cuts receive new proposed endpoints.

A read-through pipeline check preserved all seven existing approved outputs
and their review timestamps exactly, reusing all seven analyses and embeddings
with zero new embeddings or model calls. Outputs were captured in memory,
with no writes to the source folder. A preparation-version regression also
checks that approved sounds remain published during the upgrade.

The preparation suite covers missed/subdivided beats, an extra final hit,
three-beat bar evidence, ringing single hits, independent chop warnings,
melodic context and the fitted exported clock. All seven JavaScript test
suites pass. The Chrome admission workflow passes marked correction,
explicit approval, exact native output, publication, reflagging, rejection
and retained decisions.

## Filename hint precedence — 2026-11-12

The in-progress EgcSamples parent run contained 36 drum hits: ten hats,
fourteen kicks and twelve snares. Whole-path token union incorrectly added
`synth + bass + fx` from the Hotcakes pack title and its `Sounds And Fx`
ancestor to every hit. The resulting synth tag also introduced irrelevant
`uncertain-root` validation failures. Saved acoustic predictions correctly
identified the drum roles in these examples.

Hint policy `nearest-name-hints-v3` uses the filename first and the nearest
informative folder as fallback, including plural role directories. The recorded
modifier can still be inherited. Explicit assigned roles resolve acoustic
alternatives for admission while raw model evidence remains unchanged. On
resumption, obsolete automatic hint assignments are withdrawn until checked;
saved human approvals and manual overrides retain their authority.

A read-only pipeline replay of all 36 saved rows produces only their expected
`drums + hat/kick/snare` assignments, removes every irrelevant root failure,
and reuses all 36 analyses and embeddings with zero model calls. Thirty pass
the remaining preparation checks; six still need attack review. All outputs
were captured in memory without changing source audio or live metadata.
Regression tests cover nested pack names, nearest plural directories, Windows
paths, inherited recorded modifiers, resolved role alternatives, and cached
repair of stale assignments with accurate bank totals. All seven JavaScript
suites pass.

## Selective beat inference — 2026-11-12

The paused 37-source EgcSamples report records 291.7 seconds elapsed, including
134.0 seconds under finding loop beats and 119.9 under classification. Metadata
writes total 3.8 seconds and overlap those stages. The older complete Future
Music run records 2738.4 seconds elapsed and 2040.4 under loop beats. These
stage measurements include subsequent bookkeeping until the next stage begins;
they are evidence of the dominant cost, not pure model benchmarks.

The pipeline skips beat inference for explicit non-loop assignments and unnamed
sounds shorter than one second. Otherwise, unnamed sounds use the existing
loop-classification prerequisite (at least four original attacks spanning 45%
of the source) before generating repeated beat-model context. Explicit loop
hints/overrides bypass this precheck. Pitch, attacks, acoustic classification,
playable-bound validation and manual approval still run as before.

Saved skip reasons distinguish assigned one-shots from sounds without an event
sequence. A later loop assignment upgrades that partial cache while reusing
its CLAP embedding. Complete old analyses retain their identity and remain
reusable. Reports count newly analysed, reused and skipped timing work.

Pipeline regressions cover named one-shots, unnamed short/long sounds, disabled
hints, explicit short loops, cached skips and later loop overrides. The real
WASM Chrome check confirms sparse sounds skip the timing frontend, original
event sequences retain the identical full loop analysis, and explicit loops
still reach the timing frontend. All JavaScript suites pass. These checks do
not establish a whole-folder wall-time speedup; that depends on its candidate
mix and existing cache.

## Processing preview matches playable cuts — 2026-11-12

The processing-page player loaded the raw analysis-region file from frame zero,
using the old raw loop-end hint instead of preparation bounds or the exported
WAV. This included the extra final event even where review and publication
had a correct shorter cut. The issue was reproduced independently of phrase
selection; no preparation/model changes are required for this correction.

The player now loads the actual published output for included sounds. Pending
sounds use their stored proposed start/end on the left channel. Waveforms,
loop limits, seeking, transient overlays and displayed prepared durations use
the cropped audio. Manual publication refreshes an existing preview. Invalid
stored cuts fail visibly rather than auditioning the whole source.

A synthetic Chrome regression inspects actual AudioBufferSourceNode buffers:
the published cut deliberately differs from its old proposed bounds; pending
audio has a different start and a loud incompatible right channel. Both yield
the expected mono frames and exact first/last samples, with a closed one-second
loop. The legacy loop-end fallback and invalid-cut refusal also pass. All seven
JavaScript suites and the existing browser correction/admission workflow pass.

## Selectable chop audition and correction — 2026-11-12

The browser review now has numbered chop buttons, previous/next controls and
waveform-marker selection. Audition starts at the exact source frame and stops
at the playable end, or optionally the next kept chop. It plays once without
changing saved phrase bounds or the full-loop preference. Kept and excluded
detector points remain distinct; auditioning an excluded detection does not add
it to the map. A selected point can be removed/restored, and the playhead can
insert a missing point. Marked previews route the left channel to match export.

Chrome checks exact playback offsets/endpoints, one-shot audition, previous/next
selection, waveform selection, excluded-candidate audition, unchanged boundaries,
remove/restore/add operations, draft recovery after reload and the corrected
transients in the published analysis. Existing bank totals, parent/sibling
navigation, manual publication, source hashes, metadata ZIPs and mobile layout
still pass. The common player/styling copies match; all JavaScript suites and
the Python auditioner tests pass. No source audio/model outputs are reprocessed
or modified by auditioning points.
