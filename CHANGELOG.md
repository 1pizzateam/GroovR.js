# Changelog

## 0.1.0 (2026-10-21)

- Declarative `groovr-song` v2 format, validator (`validateSong`, `parseSong`, `migrateSong`), and timeline stream builder (`buildTimeline`, `midiToFrequency`, `frequencyToMidi`).
- Web Audio synthesis engine (`playNote`, `evaluate`, `createNoise`) supporting multi-oscillator voices, per-voice mix gains, Amp & Filter ADSR envelopes, breakpoint envelopes, 3-target LFOs (`pitch`, `cutoff`, `amp`), wave-shapers, and filtered noise percussion.
- Modular Web Audio effects engine (`buildEffect`, `buildChain`, `softClip`, `createImpulse`) with 12 built-in effects: `gain`, `filter`, `delay`, `reverb`, `distortion`, `chorus`, `phaser`, `tremolo`, `vibrato`, `compressor`, `eq`, and `stereo`.
- Lookahead Web Audio playback and mix engine (`Player`) with seamless live parameter updates and track mute/solo gating.
