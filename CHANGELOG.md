Version 0.1.0 (November 11th 2026)
-----------------------------
 * Speech synthesis (`speak`, `textToPhonemes`, `PHONEMES`, `VOICE_GENDERS`):
    * Add robotic formant speech synthesis engine (`src/speech.ts`) with a continuous 3-bandpass parallel vocal tract (`F1`, `F2`, `F3`), sawtooth fundamental + sub-octave chest oscillator, vocal-cord soft-clipping waveshaper, vibrato LFO, and unvoiced consonant burst/frication noise.
    * Support selectable `gender` presets (`"male"`, `"female"`, `"neutral"`), custom `pitch`, `speed`, `gain`, `drive`, `vibratoRate`, `vibratoDepth`, custom pitch `contour`, and automatic rising interrogative (`?`) vs. falling statement cadence with legato voiced word liaisons.
    * Add English-to-phoneme conversion (`textToPhonemes`) supporting domain lexicon words, digraphs, silent trailing `e`, doubled consonant collapsing, digits (`0`–`9`), and direct phoneme code arrays.
    * Export `speak`, `textToPhonemes`, `PHONEMES`, `VOICE_GENDERS`, and types (`PhonemeSpec`, `SpeechOptions`, `SpeechResult`, `VoiceGender`, `VoiceGenderPreset`) from the package entry point.
 * Upgraded `@1pizzateam/spock` to `4.6.0`:
    * Re-export `Vec2` from the package entry point alongside `spatial2D`.
    * Delegate 2D spatial distance, listener-relative cross product pan, inverse-square attenuation normalization, and symmetric pan clamping in `spatial2D()` to `Vec2.getMagnitude()`, `Trigo.cosinePrecise()`, `Trigo.sinePrecise()`, `Vec2.crossProduct()`, `Utils.normalize()`, and `Utils.clampToExtent()`.
    * Delegate unvoiced/liaison formant midpoint blending in `speak()` to `Utils.mix()`, stereo width crossfade gains in `buildStereo()` to `Utils.map()`, opposite right-channel chorus depth in `buildChorus()` to `Utils.opposite()`, reverb impulse decay normalization in `createImpulse()` to `Utils.normalize()`, and filter ADSR sustain interpolation in `adsr()` to `Utils.lerp()`.

Version 0.1.0-alpha.4 (November 6th 2026)
-----------------------------
 * Implement spatial2D in a new module
 * Export spatial2D from the package entry point
 * Document the new public export
 * Add unit tests for spatial2D

Version 0.1.0-alpha.3 (October 25th 2026)
-----------------------------
 * Upgraded `@1pizzateam/spock` to `4.5.0`:
    * Use `Rand.next()` in `playNote()` for per-layer uniform `[0, 1)` random trigger draws (`r`, `r2`, `r3`).
    * Delegate mid-segment breakpoint envelope interpolation in `envelope()` and wave-shaper curve domain mapping in `softClip()` to `Utils.map()`.
    * Delegate symmetric stereo pan clamping in `buildStereo()` to `Utils.clampToExtent()`.

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
