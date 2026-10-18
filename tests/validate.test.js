import { validateSong, parseSong, migrateSong } from '../build/es6/validate.js';

const song = () => ({
  format: 'groovr-song',
  version: 2,
  name: 'test',
  bpm: 120,
  loop: true,
  loopStart: 0,
  level: 0.3,
  reverb: { seconds: 1.8, power: 2.5, return: 0.5 },
  buses: [{ id: 'amp', chain: [{ kind: 'gain', value: 1.6 }, { kind: 'distortion', drive: 1, hardness: 4, oversample: '2x', tone: 0 }, { kind: 'filter', type: 'lowpass', freq: 2250 }], gain: 0.22, wet: 0.26 }],
  instruments: [{
    id: 'lead',
    layers: [
      {
        kind: 'voice', duration: { d: 1 }, out: 'amp',
        envelope: [[0, 0], [0.01, { v: 0.5 }], [{ d: 1 }, 0.001, 'exp']],
        filter: { type: 'lowpass', q: 2, envelope: [[0, 800], [{ d: 1 }, 200, 'exp']] },
        voices: [{ type: 'sawtooth', freq: { f: 1 }, detune: -5 }, { pitch: [[0, 160], [0.08, 45, 'exp']] }],
      },
      { kind: 'noise', type: 'highpass', freq: 1800, length: 0.2, level: 0.4 },
    ],
  }],
  patterns: [{ id: 'p1', length: 4, notes: [{ time: 0, duration: 1, pitch: 69, velocity: 1 }] }],
  tracks: [{ id: 't1', instrument: 'lead', clips: [{ pattern: 'p1', start: 0 }] }],
});

describe('validateSong', () => {
  it('accepts a valid song', () => {
    expect(validateSong(song())).toEqual([]);
  });

  it('rejects non-objects', () => {
    expect(validateSong(null)).toHaveLength(1);
  });

  it('rejects wrong format, version, bpm, level and reverb', () => {
    const s = song();
    s.format = 'x';
    s.version = 99;
    s.bpm = 0;
    s.level = 'loud';
    delete s.reverb;
    expect(validateSong(s)).toHaveLength(5);
  });

  it('rejects unknown instrument, pattern and bus references', () => {
    const s = song();
    s.tracks[0].instrument = 'nope';
    s.tracks[0].clips[0].pattern = 'nope';
    s.instruments[0].layers[0].out = 'nope';
    expect(validateSong(s)).toHaveLength(3);
  });

  it('rejects invalid notes, periods, mute and solo flags', () => {
    const s = song();
    s.tracks[0].mute = true;
    s.tracks[0].solo = false;
    expect(validateSong(s)).toEqual([]);
    s.patterns[0].notes[0].duration = 0;
    s.tracks[0].period = -1;
    s.tracks[0].mute = 'yes';
    s.tracks[0].solo = 1;
    expect(validateSong(s)).toHaveLength(4);
  });

  it('rejects invalid layers, oscillators and expressions', () => {
    const s = song();
    s.instruments[0].layers[0].voices[0].type = 'bad';
    s.instruments[0].layers[0].envelope = [[0, { x: 1 }]];
    s.instruments[0].layers[1].type = 'bad';
    s.instruments[0].layers.push({ kind: 'other' });
    expect(validateSong(s).length).toBeGreaterThanOrEqual(4);
  });

  it('rejects invalid buses and loopStart', () => {
    const s = song();
    s.buses[0].chain.push({ kind: 'filter', type: 'bad', freq: 1 });
    s.loopStart = -2;
    expect(validateSong(s)).toHaveLength(2);
  });

  it('accepts instrument and master effects and rejects broken ones', () => {
    const s = song();
    const all = ['delay', 'reverb', 'distortion', 'chorus', 'phaser', 'tremolo', 'compressor', 'eq', 'stereo'].map((kind) => ({ kind }));
    s.instruments[0].fx = { chain: [...all, { kind: 'delay', time: 0.75, mix: 0.4, bypass: true }], gain: 0.9, send: 0.3, out: 'amp' };
    s.master = { chain: [{ kind: 'compressor', threshold: -12 }, { kind: 'eq', high: 2 }], gain: 1 };
    s.buses[0].chain.push({ kind: 'chorus', rate: 2 });
    expect(validateSong(s)).toEqual([]);

    const bad = song();
    bad.instruments[0].fx = { chain: [{ kind: 'flanger' }, { kind: 'delay', mix: 'lots' }, { kind: 'tremolo', bypass: 1 }], out: 'nope', send: 'x' };
    bad.master = { chain: 'none' };
    expect(validateSong(bad)).toHaveLength(6);
    expect(validateSong({ ...song(), master: 5 })).toHaveLength(1);
  });

  it('checks the distortion hardness, oversampling and the voice shaper', () => {
    const s = song();
    s.buses[0].chain.push({ kind: 'distortion', hardness: 6, oversample: 'none' });
    s.instruments[0].layers[0].shaper = 3;
    expect(validateSong(s)).toEqual([]);
    s.instruments[0].layers[0].shaper = true;
    expect(validateSong(s)).toEqual([]);
    s.buses[0].chain.push({ kind: 'distortion', oversample: '8x' });
    s.instruments[0].layers[0].shaper = 'hard';
    expect(validateSong(s)).toHaveLength(2);
  });

  it('no longer knows the fixed shaper node, which migrateSong turns into the equivalent distortion', () => {
    const old = song();
    old.buses[0].chain = [{ kind: 'gain', value: 1.6 }, { kind: 'shaper' }];
    old.instruments[0].fx = { chain: [{ kind: 'shaper', bypass: true }] };
    old.master = { chain: [{ kind: 'shaper' }] };
    old.instruments[0].layers[0].shaper = true;
    expect(validateSong(old).length).toBeGreaterThan(0);
    const migrated = migrateSong(structuredClone(old));
    const amp = { kind: 'distortion', drive: 1, hardness: 4, oversample: '2x', tone: 0, level: 1, mix: 1 };
    expect(migrated.buses[0].chain[1]).toEqual(amp);
    expect(migrated.instruments[0].fx.chain[0]).toEqual({ ...amp, bypass: true });
    expect(migrated.master.chain[0]).toEqual(amp);
    expect(migrated.instruments[0].layers[0].shaper).toBe(4);
    expect(validateSong(migrated)).toEqual([]);
    expect(parseSong(JSON.stringify(old)).buses[0].chain[1].kind).toBe('distortion');
    expect(migrateSong(null)).toBeNull();
  });

  it('accepts rack state and rejects a broken one', () => {
    const s = song();
    s.instruments[0].rack = { template: 'guitar', values: { level: 1.2 } };
    expect(validateSong(s)).toEqual([]);
    s.instruments[0].rack = { template: 'guitar', values: { level: 'loud' } };
    expect(validateSong(s)).toHaveLength(1);
  });

  it('rejects missing arrays', () => {
    const s = song();
    delete s.tracks;
    expect(validateSong(s)).toHaveLength(1);
  });
});

describe('parseSong', () => {
  it('parses valid JSON', () => {
    expect(parseSong(JSON.stringify(song())).name).toBe('test');
  });

  it('throws on invalid songs', () => {
    expect(() => parseSong('{}')).toThrow('Invalid song');
  });
});
