import { Player } from '../build/es6/player.js';

class Param {
  constructor() { this.calls = []; this.value = 0; }
  setValueAtTime(v, t) { this.calls.push(['set', v, t]); }
  linearRampToValueAtTime(v, t) { this.calls.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); }
  setTargetAtTime(v, t, c) { this.calls.push(['target', v, t, c]); this.targets = (this.targets ?? []).concat([[v, t, c]]); }
  cancelScheduledValues() { this.calls.push(['cancel']); }
}

function makeContext() {
  const ctx = { oscillators: [], sources: [], currentTime: 0, sampleRate: 100 };
  const node = (extra = {}) => ({ edges: [], connect(n) { this.edges.push(n); return n; }, disconnect() {}, start(t) { this.started = t; }, stop(t) { this.stopped = t; }, ...extra });
  ctx.destination = node();
  ctx.createGain = () => node({ gain: new Param() });
  ctx.createOscillator = () => {
    const o = node({ frequency: new Param(), detune: new Param(), type: 'sine' });
    ctx.oscillators.push(o);
    return o;
  };
  ctx.createBiquadFilter = () => node({ frequency: new Param(), Q: new Param(), type: 'lowpass' });
  ctx.createWaveShaper = () => node();
  ctx.createBufferSource = () => {
    const s = node();
    ctx.sources.push(s);
    return s;
  };
  ctx.createConvolver = () => node();
  ctx.createDynamicsCompressor = () => node({ threshold: new Param(), ratio: new Param(), attack: new Param(), release: new Param() });
  ctx.createDelay = () => node({ delayTime: new Param() });
  ctx.createChannelMerger = () => node();
  ctx.createChannelSplitter = () => node();
  ctx.createStereoPanner = () => node({ pan: new Param() });
  ctx.createBuffer = (c, length) => ({ getChannelData: () => new Float32Array(length) });
  return ctx;
}

const song = (extra = {}) => ({
  format: 'groovr-song',
  version: 2,
  name: 't',
  bpm: 60,
  loop: true,
  level: 0.3,
  reverb: { seconds: 0.1, power: 2, return: 0.5 },
  buses: [{ id: 'amp', chain: [{ kind: 'gain', value: 2 }, { kind: 'distortion', drive: 1, hardness: 4, oversample: '2x', tone: 0, level: 1, mix: 1 }, { kind: 'filter', type: 'lowpass', freq: 1000 }], gain: 1, wet: 0.2 }],
  instruments: [{
    id: 'i',
    layers: [
      {
        kind: 'voice', duration: { d: 1 }, wet: 0.5, out: 'amp', shaper: true, lfo: { freq: 5, base: 1, depth: 0.1 }, vibrato: { rate: 11, depth: 14 },
        velocity: { b: 0.5, r: 0.5 },
        envelope: [[0, 0], [0.1, { v: 1 }], [{ d: 0.5, max: 0.2 }, 0.2, 'hold'], [{ d: 1 }, 0.001, 'exp']],
        filter: { type: 'lowpass', q: 2, envelope: [[0, 500], [{ d: 1 }, 100, 'exp']] },
        voices: [{ type: 'sawtooth', freq: { f: 2 }, detune: { b: -10, r: 20 } }, { pitch: [[0, { f: 1 }], [0.1, 50, 'exp']], direct: true }],
      },
      { kind: 'noise', type: 'bandpass', q: 1, filterEnvelope: [[0, 300], [1, 900, 'exp']], length: 0.5, level: 0.4, wet: 0.2 },
      { kind: 'noise', type: 'highpass', freq: 100, length: 0.1, envelope: [[0, 0.5], [0.1, 0.001, 'exp']], offset: 1, pad: 0.1 },
    ],
  }],
  patterns: [{ id: 'p', length: 4, notes: [{ time: 0, duration: 1, pitch: 69, velocity: 1 }, { time: 2, duration: 1, pitch: 81, velocity: 1 }] }],
  tracks: [{ id: 't', instrument: 'i', clips: [{ pattern: 'p', start: 0 }] }],
  ...extra,
});

function run(ctx, player, until, tickMs = 0.5) {
  let tick = null;
  const set = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  globalThis.setInterval = (fn) => ((tick = fn), 1);
  globalThis.clearInterval = () => { tick = null; };
  try {
    player.play();
    while (ctx.currentTime < until && tick) {
      ctx.currentTime += tickMs;
      tick();
    }
  } finally {
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
  }
}

describe('Player', () => {
  it('schedules notes with the instrument patch at the right times and pitches', () => {
    const ctx = makeContext();
    const player = new Player(ctx, song(), { destination: ctx.destination });
    run(ctx, player, 1);
    const saws = ctx.oscillators.filter((o) => o.type === 'sawtooth');
    expect(saws[0].started).toBeCloseTo(0.05);
    expect(saws[0].frequency.value).toBeCloseTo(880);
    expect(saws[1].started).toBeCloseTo(2.05);
    expect(saws[1].frequency.value).toBeCloseTo(1760);
    expect(ctx.sources.length).toBeGreaterThan(0);
  });

  it('loops the song', () => {
    const ctx = makeContext();
    const player = new Player(ctx, song(), { destination: ctx.destination });
    run(ctx, player, 9);
    const saws = ctx.oscillators.filter((o) => o.type === 'sawtooth');
    expect(saws.map((o) => Math.round(o.started * 100) / 100).slice(0, 5)).toEqual([0.05, 2.05, 4.05, 6.05, 8.05]);
  });

  it('plays once when not looping and stops itself', () => {
    const ctx = makeContext();
    const player = new Player(ctx, song({ loop: false }), { destination: ctx.destination });
    run(ctx, player, 20);
    expect(ctx.oscillators.filter((o) => o.type === 'sawtooth')).toHaveLength(2);
    expect(player.playing).toBe(false);
  });

  it('repeats a periodic track independently of the loop', () => {
    const ctx = makeContext();
    const s = song();
    s.patterns.push({ id: 'd', length: 3, notes: [{ time: 1, duration: 1, pitch: 60, velocity: 1 }] });
    s.tracks.push({ id: 'drone', instrument: 'i', period: 3, clips: [{ pattern: 'd', start: 0 }] });
    const player = new Player(ctx, s, { destination: ctx.destination });
    run(ctx, player, 8);
    const times = ctx.oscillators.filter((o) => o.type === 'sawtooth').map((o) => Math.round(o.started * 100) / 100);
    expect(times).toEqual(expect.arrayContaining([1.05, 4.05, 7.05]));
  });

  it('carries on without repeating notes when the song is replaced while playing', () => {
    const ctx = makeContext();
    const player = new Player(ctx, song(), { destination: ctx.destination });
    run(ctx, player, 1);
    const before = ctx.oscillators.length;
    player.setSong(song());
    expect(player.playing).toBe(true);
    expect(ctx.oscillators.length).toBe(before);
    expect(player.position).toBeGreaterThan(0);
    player.stop();
    expect(player.playing).toBe(false);
  });

  it('mutes and unmutes tracks in place without restarting the song or duplicating scheduled notes', () => {
    const ctx = makeContext();
    const s = song();
    const player = new Player(ctx, s, { destination: ctx.destination });
    run(ctx, player, 1);
    const beforeCount = ctx.oscillators.length;
    const beforePos = player.position;
    const muted = song();
    muted.tracks[0].mute = true;
    player.setSong(muted);
    expect(player.playing).toBe(true);
    expect(player.position).toBeCloseTo(beforePos);
    expect(ctx.oscillators.length).toBe(beforeCount);
    player.setSong(song());
    expect(player.position).toBeCloseTo(beforePos);
    expect(ctx.oscillators.length).toBe(beforeCount);
    player.stop();
  });

  it('reports a looped position and zero when stopped', () => {
    const ctx = makeContext();
    const player = new Player(ctx, song({ loopStart: 2 }), { destination: ctx.destination });
    expect(player.position).toBe(0);
    run(ctx, player, 1);
    ctx.currentTime = 5.05;
    expect(player.position).toBeCloseTo(3);
  });

  it('fades in, eases the level and fades out with the tail', () => {
    const ctx = makeContext();
    const gains = [];
    const create = ctx.createGain;
    ctx.createGain = () => { const g = create(); gains.push(g); return g; };
    ctx.currentTime = 10;
    const player = new Player(ctx, song(), { destination: ctx.destination, level: 0 });
    player.play(2);
    const level = gains[0];
    expect(level.gain.value).toBe(0);
    player.fadeIn(0.3, 0.25, 0.25);
    expect(level.gain.calls.slice(-3)).toEqual([['set', 0, 10], ['set', 0, 10.25], ['lin', 0.3, 10.5]]);
    player.setLevel(0.12, 0.2);
    expect(level.gain.calls.at(-1)).toEqual(['target', 0.12, 10, 0.2]);
    player.stop(0.25);
    expect(gains.slice(0, 3).every((g) => g.gain.calls.at(-1)[0] === 'lin' && g.gain.calls.at(-1)[2] === 10.25)).toBe(true);
    expect(player.playing).toBe(false);
    player.fadeIn(0.3, 0.25);
    expect(gains.length).toBeGreaterThan(4);
  });

  it('starts after the given delay', () => {
    const ctx = makeContext();
    const player = new Player(ctx, song(), { destination: ctx.destination });
    run(ctx, player, 1);
    player.stop();
    const first = ctx.oscillators.length;
    const p2 = new Player(ctx, song(), { destination: ctx.destination });
    ctx.currentTime = 0;
    p2.play(2);
    expect(ctx.oscillators.length).toBeGreaterThan(first);
    expect(ctx.oscillators.at(-1).started).toBeGreaterThanOrEqual(2);
    p2.stop();
  });

  it('starts from a beat offset and includes notes right on that beat', () => {
    const ctx = makeContext();
    const player = new Player(ctx, song(), { destination: ctx.destination });
    player.play(0.05, 2);
    expect(player.position).toBeCloseTo(2);
    const saws = ctx.oscillators.filter((o) => o.type === 'sawtooth');
    expect(saws[0].started).toBeCloseTo(0.05);
    expect(saws[0].frequency.value).toBeCloseTo(1760);
    expect(saws[1].started).toBeCloseTo(2.05);
    expect(saws[1].frequency.value).toBeCloseTo(880);
    player.stop();
  });

  it('keeps playing and advancing position when looping an empty pattern', () => {
    const ctx = makeContext();
    const empty = song({ patterns: [{ id: 'p', length: 4, notes: [] }] });
    const player = new Player(ctx, empty, { destination: ctx.destination });
    run(ctx, player, 1);
    ctx.currentTime = 2.05;
    expect(player.playing).toBe(true);
    expect(player.position).toBeCloseTo(2);
    player.stop();
  });

  it('auditions a single note of an instrument at once', () => {
    const ctx = makeContext();
    ctx.currentTime = 3;
    const player = new Player(ctx, song(), { destination: ctx.destination });
    player.preview('i', 69, 0.5, 1);
    const saw = ctx.oscillators.find((o) => o.type === 'sawtooth');
    expect(saw.started).toBeCloseTo(3.02);
    expect(saw.frequency.value).toBeCloseTo(880);
    const before = ctx.oscillators.length;
    player.preview('missing');
    expect(ctx.oscillators.length).toBe(before);
  });

  it('keeps the buses when only a patch changes, and rebuilds them when the mix changes', () => {
    const ctx = makeContext();
    let buses = 0;
    const create = ctx.createConvolver;
    ctx.createConvolver = () => { buses++; return create(); };
    const player = new Player(ctx, song(), { destination: ctx.destination });
    run(ctx, player, 1);
    expect(buses).toBe(1);
    const edited = song();
    edited.instruments[0].layers[2].length = 0.2;
    player.setSong(edited);
    player.preview('i');
    expect(buses).toBe(1);
    const mix = song();
    mix.reverb.seconds = 0.5;
    player.setSong(mix);
    player.preview('i');
    expect(buses).toBe(2);
  });

  it('ramps exponentially to silence instead of failing when a value is scaled to zero', () => {
    const ctx = makeContext();
    const s = song();
    s.instruments[0].layers[0].envelope = [[0, 0], [0.1, 0.5], [{ d: 1 }, 0, 'exp']];
    const gains = [];
    const create = ctx.createGain;
    ctx.createGain = () => { const g = create(); gains.push(g); return g; };
    const player = new Player(ctx, s, { destination: ctx.destination });
    player.preview('i', 69, 1);
    const exp = gains.flatMap((g) => g.gain.calls).find((c) => c[0] === 'exp' && c[2] > 0.9);
    expect(exp[1]).toBe(0.0001);
  });

  describe('effects', () => {
    const withGains = (ctx) => {
      const gains = [];
      const create = ctx.createGain;
      ctx.createGain = () => { const g = create(); gains.push(g); return g; };
      return gains;
    };
    const fxSong = (fx, extra = {}) => {
      const s = song(extra);
      s.instruments[0].fx = fx;
      return s;
    };

    it('routes an instrument through its own chain, then on to the level bus', () => {
      const ctx = makeContext();
      const gains = withGains(ctx);
      const player = new Player(ctx, fxSong({ chain: [{ kind: 'gain', value: 7 }], gain: 0.83, send: 0.41 }), { destination: ctx.destination });
      player.preview('i');
      const input = gains.find((g) => g.gain.value === 7);
      const out = gains.find((g) => g.gain.value === 0.83);
      const sends = gains.filter((g) => g.gain.value === 0.41);
      expect(input.edges).toContain(out);
      expect(gains.some((g) => g !== input && g.edges.includes(input))).toBe(true);
      expect(sends).toHaveLength(1);
      expect(out.edges).toContain(sends[0]);
    });

    it('lets an instrument chain feed a bus such as the amp, and ignores the layer routing', () => {
      const ctx = makeContext();
      const gains = withGains(ctx);
      const s = fxSong({ chain: [{ kind: 'gain', value: 7 }], out: 'amp' });
      const player = new Player(ctx, s, { destination: ctx.destination });
      player.preview('i');
      const amp = gains.find((g) => g.gain.value === 2);
      const input = gains.find((g) => g.gain.value === 7);
      expect(amp).toBeDefined();
      const out = input.edges[0];
      expect(out.edges).toContain(amp);
    });

    it('does not build anything for an instrument whose effects do nothing', () => {
      const ctx = makeContext();
      const gains = withGains(ctx);
      const plain = new Player(ctx, song(), { destination: ctx.destination });
      plain.preview('i');
      const without = gains.length;
      const ctx2 = makeContext();
      const gains2 = withGains(ctx2);
      const idle = new Player(ctx2, fxSong({ chain: [{ kind: 'delay', bypass: true }] }), { destination: ctx2.destination });
      idle.preview('i');
      expect(gains2.length).toBe(without);
    });

    it('sends the whole mix, reverb tail included, through the master chain', () => {
      const ctx = makeContext();
      const gains = withGains(ctx);
      const s = song({ master: { chain: [{ kind: 'gain', value: 0.77 }], gain: 0.91 } });
      const player = new Player(ctx, s, { destination: ctx.destination });
      player.preview('i');
      const out = gains.find((g) => g.gain.value === 0.91);
      expect(out.edges).toContain(ctx.destination);
      const chainIn = gains.find((g) => g.gain.value === 0.77);
      const masterIn = gains.find((g) => g.edges.includes(chainIn));
      expect(gains.filter((g) => g.edges.includes(masterIn)).length).toBe(2);
      expect(gains.filter((g) => g.edges.includes(ctx.destination))).toEqual([out]);
    });

    it('moves effect parameters in place when only their values change, and rebuilds when the structure changes', () => {
      const ctx = makeContext();
      let buses = 0;
      const create = ctx.createConvolver;
      ctx.createConvolver = () => { buses++; return create(); };
      const gains = withGains(ctx);
      const delay = (feedback, extra = {}) => fxSong({ chain: [{ kind: 'delay', time: 1, feedback, mix: 0.3, ...extra }], gain: 1 });
      const player = new Player(ctx, delay(0.4), { destination: ctx.destination });
      player.preview('i');
      const feedbackGain = gains.find((g) => g.gain.value === 0.4);
      player.setSong(delay(0.7));
      expect(buses).toBe(1);
      expect(feedbackGain.gain.targets.at(-1)[0]).toBe(0.7);
      player.setSong(delay(0.7, { bypass: true }));
      player.preview('i');
      expect(buses).toBe(2);
    });

    it('moves the reverb return live, and rebuilds the reverb when its size changes', () => {
      const ctx = makeContext();
      let reverbs = 0;
      const create = ctx.createConvolver;
      ctx.createConvolver = () => { reverbs++; return create(); };
      const gains = withGains(ctx);
      const mk = (ret, seconds = 0.1) => song({ reverb: { seconds, power: 2, return: ret } });
      const player = new Player(ctx, mk(0.73), { destination: ctx.destination });
      player.preview('i');
      const tail = gains.find((g) => g.gain.value === 0.73);
      player.setSong(mk(0.9));
      expect(reverbs).toBe(1);
      expect(tail.gain.targets.at(-1)[0]).toBe(0.9);
      player.setSong(mk(0.9, 0.3));
      player.preview('i');
      expect(reverbs).toBe(2);
    });

    it('rebuilds when a distortion gains a tone filter or a dry path, and keeps the graph when it only moves a knob', () => {
      const ctx = makeContext();
      let reverbs = 0;
      const create = ctx.createConvolver;
      ctx.createConvolver = () => { reverbs++; return create(); };
      const mk = (d) => fxSong({ chain: [{ kind: 'distortion', mix: 1, tone: 0, level: 1, ...d }] });
      const player = new Player(ctx, mk({ drive: 4 }), { destination: ctx.destination });
      player.preview('i');
      player.setSong(mk({ drive: 9 }));
      player.preview('i');
      expect(reverbs).toBe(1);
      player.setSong(mk({ drive: 9, mix: 0.5 }));
      player.preview('i');
      expect(reverbs).toBe(2);
      player.setSong(mk({ drive: 9, mix: 0.5, tone: 4000 }));
      player.preview('i');
      expect(reverbs).toBe(3);
    });

    it('updates an insert reverb tone/mix in place and rebuilds when its impulse shape changes', () => {
      const ctx = makeContext();
      let convolvers = 0;
      const create = ctx.createConvolver;
      ctx.createConvolver = () => { convolvers++; return create(); };
      const mk = (r) => fxSong({ chain: [{ kind: 'reverb', ...r }] });
      const player = new Player(ctx, mk({ tone: 3000, mix: 0.25 }), { destination: ctx.destination });
      player.preview('i');
      expect(convolvers).toBe(2);
      player.setSong(mk({ tone: 5000, mix: 0.4 }));
      player.preview('i');
      expect(convolvers).toBe(2);
      player.setSong(mk({ seconds: 2.5, power: 3, tone: 5000, mix: 0.4 }));
      player.preview('i');
      expect(convolvers).toBe(4);
    });

    it('moves the master and send gains with the song', () => {
      const ctx = makeContext();
      const gains = withGains(ctx);
      const mk = (gain, send) => fxSong({ chain: [{ kind: 'tremolo' }], gain, send }, { master: { chain: [{ kind: 'stereo' }], gain: 1 } });
      const player = new Player(ctx, mk(0.57, 0.23), { destination: ctx.destination });
      player.preview('i');
      const out = gains.find((g) => g.gain.value === 0.57);
      const send = gains.find((g) => g.gain.value === 0.23);
      player.setSong(mk(0.61, 0.29));
      expect(out.gain.targets.at(-1)[0]).toBe(0.61);
      expect(send.gain.targets.at(-1)[0]).toBe(0.29);
    });

    it('applies instrument distortion and vibrato effects per-voice before the voice envelope', () => {
      const ctx = makeContext();
      const oscs = [];
      const shapers = [];
      const createOsc = ctx.createOscillator;
      const createShaper = ctx.createWaveShaper;
      ctx.createOscillator = () => { const o = createOsc(); oscs.push(o); return o; };
      ctx.createWaveShaper = () => { const w = createShaper(); shapers.push(w); return w; };
      const s = fxSong({
        chain: [
          { kind: 'distortion', drive: 1, hardness: 5, tone: 0, level: 1, mix: 1, oversample: 'none' },
          { kind: 'vibrato', rate: 26, depth: 34 },
        ],
      });
      delete s.instruments[0].layers[0].shaper;
      delete s.instruments[0].layers[0].vibrato;
      const player = new Player(ctx, s, { destination: ctx.destination });
      player.preview('i');
      expect(shapers.some((w) => w.curve && !w.oversample)).toBe(true);
      expect(oscs.some((o) => o.frequency.value === 26)).toBe(true);

      const s2 = fxSong({
        chain: [{ kind: 'distortion', drive: 8, hardness: 2, tone: 4000, level: 0.6, mix: 0.8 }],
      });
      delete s2.instruments[0].layers[0].shaper;
      delete s2.instruments[0].layers[0].vibrato;
      player.setSong(s2);
      player.preview('i');
      expect(shapers.some((w) => w.oversample === '2x')).toBe(true);
    });
  });

  it('creates a default output with a limiter', () => {
    const ctx = makeContext();
    expect(new Player(ctx, song()).playing).toBe(false);
  });
});
