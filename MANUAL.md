# Instrument manual

The manual is a buildless static page at `manual/index.html`. The home page links
to `/manual/`; the existing GitHub Pages setup serves it at
`https://egc.one/manual/` once this branch is integrated and published. Keep the
existing `CNAME` and hosting setup. Updating this branch does not publish it.

Edit the HTML for content, `manual/manual.css` for presentation, and
`manual/manual.js` for search, bank selection, and print behaviour. All sections
and effects tables remain available without JavaScript. The manual uses system
fonts. No package installation or build is needed.

The SVG panel and recording timeline in `manual/assets/` are original drawings.
The supplied reference photo is deliberately not included. The owner confirmed
the yellow-button order as Transport, Instrument, Mode, Quantise. With keys
along the bottom, the green turntable is upper left, green joystick upper right,
orange rollerball lower right, and purple Loop button lower left.

## Content sources

This edition was checked on 12 November 2026 against:

- ToySequencer local `master`, `8b65d27`: input dispatch in `Controller.cpp` and
  `PianoKeyInput.cpp`; channel mapping/defaults in `ChannelConfiguration.cpp/.h`;
  mode/bank coupling in `ModeManager.cpp`; FX maps in `Parameters.cpp` and keyed
  values/Hold in `FxKnobControl.cpp`; first-loop rounding, recording, grids and
  undo/redo in `Sequencer.cpp` and `FirstLoopQuantise.cpp`; readiness display in
  `StartupSequence.cpp`; cut editing in `LoopCutControl.cpp`.
- Its pinned ToySampler `993cf998ab5c22de4a143f1e81e50e9b782d67e0`: sample bank
  discovery, feedback and held-key assignments in `docs/SAMPLE_LIBRARY.md`;
  left-channel loading, beat/content cuts and sample quantisation in
  `docs/SAMPLE_ANALYSIS.md`; capture/padded stop in `RecordAudio.cpp` and the
  matching parent `docs/AUDIO_RECORDING.md`.
- Parent `docs/RECORDING_BEHAVIOUR.md`, `docs/SCALES.md`, `docs/FX_KEYS.md` and
  `docs/KNOB_LEDS.md`, cross-checked with the source above. Earlier passages and
  historical deployment records can describe superseded controls: the current
  source and later recording sections take precedence.
- ToyDynamics README and source for Amount/Character and Drive/Muffle.
- ToyReverb README and `configure.py` for the optional Dragonfly Hall amount
  control. The pinned sampler JSON is a historical reference, not the active
  rig configuration. The manual qualifies host-dependent reverb and USB discovery.
- ToySpinBack README and controller trigger for transport-only backspin and
  next-bar return.

Player channels 1–8 correspond to firmware channels 0–7: two drums, three loops,
two sampled synths and the 303. There is no dedicated Vocal/Recorded channel.
The channel table describes startup defaults, not a reading of the live rig.
Global root/layout controls, per-channel octave automation and held-key offsets
have different scopes; keep those distinctions in the shortcuts and prose.

This was a source-based documentation update. No device was queried, installed,
flashed or restarted. The actual installed firmware and active Sushi config were
not rechecked in this session. Before describing a feature as verified on the
rig, inspect its deployed revisions/configuration and complete the appropriate
physical checks. Sound, live-input routing, readiness, capture boundaries and
latency need hardware validation; passing page checks does not establish them.

## Verification

Check narrow and wide layouts, local links and SVG XML, search (including no
results and clearing), all three FX tables, contents navigation and Print/PDF.
Printing must include filtered-out sections, all FX tables and expanded help
answers. Keep original source/photo files out of the public asset directory.

Update checks on 12 November 2026: balanced HTML, unique IDs, all 28 local
links/assets and both SVG documents passed, as did `node --check manual/manual.js`
and `git diff --check`. No firmware or DSP files changed. Browser QA was
attempted but Chrome crashed in this environment, including its single-process
fallback; visual layouts, search interactions and rendered Print/PDF remain
unverified for this edition. The existing stylesheet and JavaScript are unchanged.
