[![License: MIT](https://img.shields.io/npm/l/@1pizzateam/groovr.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/%401pizzateam%2Fgroovr.svg)](https://www.npmjs.com/package/@1pizzateam/groovr)
![Jest:coverage](https://img.shields.io/badge/Jest:coverage-100%25-brightgreen.svg)

## Synopsis

[GroovR.js](https://github.com/1pizzateam/GroovR.js) is an open source Web Audio synthesis/playback engine.

- Zero external audio assets — synthesizes oscillators, noise percussion, envelopes, buses, and effects live via Web Audio API
- Lookahead scheduling with loop points, independent periodic tracks, and seamless live hot-reloading (`setSong`)
- Full insert/bus/master effects rack: gain, filter, tempo-synced delay, convolution reverb, soft-clipping distortion, stereo chorus, 4-stage phaser, tremolo, vibrato, compressor, 3-band EQ, and stereo pan/width

## Installation

```bash
$ npm install @1pizzateam/groovr
```

## Usage

```ts
import { Player, parseSong } from "@1pizzateam/groovr";

const song = parseSong(jsonString);
const ctx = new AudioContext();
const player = new Player(ctx, song);

player.play();
player.setLevel(0.25);
player.stop(0.25);
```

## API Reference

### Song Format & Validation
- `SONG_FORMAT` (`"groovr-song"`) and `SONG_VERSION` (`2`): Canonical format identifier and schema version.
- `validateSong(input: unknown): string[]`: Validates a candidate song object and returns an array of human-readable validation errors (empty when valid).
- `parseSong(json: string | unknown): Song`: Parses and validates a `groovr-song` payload (throwing on invalid input).
- `migrateSong(raw: unknown): Song`: Migrates legacy song payloads to the current schema version and validates the result.

### Playback & Timeline
- `Player`: Lookahead Web Audio playback and mix engine (`play()`, `stop(fadeOutSeconds?)`, `setSong(song)`, `setLevel(gain)`, `setTrackMute(index, muted)`, `setTrackSolo(index, solo)`).
- `buildTimeline(song: Song, includeMuted?: boolean): Timeline`: Flattens song tracks, clips, and patterns into sorted main and periodic `NoteEvent` streams.
- `midiToFrequency(midi: number): number` & `frequencyToMidi(freq: number): number`: Convert between MIDI note numbers and frequencies in Hz.

### Synthesis & Effects
- `playNote(ctx, inst, freq, when, duration, velocity, routing): ScheduledNote`: Schedules a multi-layer voice/noise note with live `cancel()` and `update(inst, bpm)` handles.
- `evaluate(expr: Expr | undefined, trigger: Trigger): number`: Evaluates a constant or affine modulation expression (`b`, `f`, `d`, `v`, `r`, `r2`, `r3`, `max`).
- `createNoise(ctx: AudioContext): AudioBuffer`: Generates the shared white-noise buffer used by percussion/noise layers.
- `buildEffect(env: FxEnv, node: EffectNode): Built` & `buildChain(env: FxEnv, nodes: EffectNode[]): Chain`: Constructs modular Web Audio effect nodes and chains (`gain`, `filter`, `delay`, `reverb`, `distortion`, `chorus`, `phaser`, `tremolo`, `vibrato`, `compressor`, `eq`, `stereo`).
- `softClip(drive: number, hardness?: number): Float32Array<ArrayBuffer>` & `distortionShape(node): string`: Builds wave-shaper transfer curves and structural cache keys for distortion stages.
- `createImpulse(ctx: AudioContext, seconds: number, power: number): AudioBuffer` & `reverbShape(node): string`: Generates stereo algorithmic impulse responses and structural cache keys for convolution reverb.
