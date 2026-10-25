Version 0.1.0-alpha.2 (October 24th 2026)
-----------------------------
 * `Player` & `playNote` (`ScheduledNote`):
    * Add `ScheduledNote` handle (`inst`, `when`, `stopAt`, `cancel()`, `update(inst, bpm)`) returned by `playNote()` so pre-scheduled lookahead notes can be cancelled and currently sounding notes can be updated in place.
    * Add `Player.swapBus()` to immediately rewire active instrument gates onto a newly built level bus when effect chains or bypass states change during playback, eliminating lookahead latency.
    * Add `Player.reschedule()` when instrument patches or patterns change during playback to cancel future pre-scheduled notes, update sounding notes in place, and re-schedule from `ctx.currentTime`.
    * Anchor mid-note `envelope()` and `adsr()` updates at `ctx.currentTime` so level, cutoff, and sustain trimpot adjustments take effect immediately on sustained notes.

Version 0.1.0-alpha.1 (October 21st 2026)
-----------------------------
 * Initial pre-release of `@1pizzateam/groovr`:
    * Declarative `groovr-song` v2 format, validator (`validateSong`, `parseSong`, `migrateSong`), and timeline stream builder (`buildTimeline`, `midiToFrequency`, `frequencyToMidi`).
    * Web Audio synthesis engine (`playNote`, `evaluate`, `createNoise`) supporting multi-oscillator voices, per-voice mix gains, Amp & Filter ADSR envelopes, breakpoint envelopes, 3-target LFOs (`pitch`, `cutoff`, `amp`), wave-shapers, and filtered noise percussion.
    * Modular Web Audio effects engine (`buildEffect`, `buildChain`, `softClip`, `createImpulse`) with 12 built-in effects: `gain`, `filter`, `delay`, `reverb`, `distortion`, `chorus`, `phaser`, `tremolo`, `vibrato`, `compressor`, `eq`, and `stereo`.
    * Lookahead Web Audio playback and mix engine (`Player`) with live parameter updates and track mute/solo gating.
