# Instrument manual

The manual is a buildless static page at `manual/index.html`. The home page links
to `/manual/`; deploying this repository through the existing GitHub Pages setup
serves it at `https://egc.one/manual/`. Keep the existing `CNAME` and hosting setup.

Edit the HTML for content, `manual/manual.css` for presentation, and
`manual/manual.js` for search, bank selection, and print behaviour. The manual
works without JavaScript: all sections and effects tables remain available. The manual uses system fonts. No package installation or build is needed.

The SVG panel and recording timeline in `manual/assets/` are original drawings.
The supplied reference photo is deliberately not included. Yellow-button order
was confirmed by the owner as Transport, Instrument, Mode, Quantise.
The owner also confirmed the round controls with keys along the bottom: green
turntable upper left, green joystick upper right, orange rollerball lower right,
and purple Loop button lower left.

## Content sources

The first edition was checked against these local source snapshots on
26 October 2026:

- ToySequencer `49b2b71`, branch `codex/instrument-sound-click`: input gestures in
  `Controller.cpp` and `PianoKeyInput.cpp`; mode/bank coupling in `ModeManager.cpp`;
  default channels in `ChannelConfiguration.h/.cpp`; effects in `Parameters.cpp`
  and `FxKnobControl.cpp`; timing and capture in `Sequencer.cpp`.
- Bundled ToySampler `240bcf2`: `PluginProcessor.cpp/.h`, `Sounds.cpp`,
  `RecordAudio.cpp`, and `ToySampler.json`, including the master backspin route.
- Standalone ToySampler `ee53283`: cross-check of sampler modes, loading,
  chopping, audio capture, and host effects. This checkout has later host
  configuration changes; the manual describes the shared player controls.
- ToySpinBack README and implementation: master effect, transport requirement,
  busy handling, and next-bar return.
- ToySequencer master `8d18762`: older rollerball sound-advance mapping and the
  Repeat-enable latch fix. The manual calls out differences rather than assuming
  the instrument has every branch's changes installed.

User-facing instrument numbers 1–8 correspond to firmware channels 0–7. The
manual describes defaults at startup; full-channel clearing can reset recording
policy in the firmware. A panel reset preserves selected channel and sound-choice
values, while restarting the audio engine reshuffles loaded file ordering.

Before updating the control reference, inspect the actual installed firmware and
Sushi configuration. Do not turn intended behaviour or a TODO into a user-facing
claim. Hardware audition is still needed for sound, latency, capture boundary
behaviour, and effect routing.

## Verification

Check both narrow and wide layouts, local links and SVG XML, search (including
no results and clearing), all three effects tables, contents navigation, and
Print / PDF. Printing should include filtered-out sections, every effects table,
and expanded troubleshooting answers. Keep original source/photo files out of
the public asset directory.
