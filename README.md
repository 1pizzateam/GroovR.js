[![License: MIT](https://img.shields.io/npm/l/@1pizzateam/groovr.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/%401pizzateam%2Fgroovr.svg)](https://www.npmjs.com/package/@1pizzateam/groovr)
![Jest:coverage](https://img.shields.io/badge/Jest:coverage-100%25-brightgreen.svg)

## Synopsis

[GroovR.js](https://github.com/1pizzateam/GroovR.js) is an open source declarative song format and Web Audio synthesis/playback engine for games, authored with the Cadenza editor.

- Zero external audio assets — synthesizes oscillators, noise percussion, envelopes, buses, and effects live via Web Audio API
- Lookahead scheduling with loop points, independent periodic tracks, and seamless live hot-reloading (`setSong`)
- Full insert/bus/master effects rack: gain, filter, tempo-synced delay, convolution reverb, soft-clipping distortion, stereo chorus, 4-stage phaser, tremolo, vibrato, compressor, 3-band EQ, and stereo pan/width
- Powered by `@1pizzateam/spock` math utilities

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
