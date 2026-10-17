import { buildChain, buildEffect, softClip } from '../build/es6/effects.js';

class Param {
  constructor() { this.value = 0; this.targets = []; }
  setTargetAtTime(v, t, c) { this.targets.push([v, t, c]); }
}

function makeContext() {
  const ctx = { currentTime: 2, nodes: [] };
  const node = (kind, params = [], extra = {}) => {
    const n = { kind, edges: [], connect(to, out, inp) { this.edges.push([to, out, inp]); return to; }, ...extra };
    for (const p of params) n[p] = new Param();
    ctx.nodes.push(n);
    return n;
  };
  ctx.createGain = () => node('gain', ['gain']);
  ctx.createDelay = (max) => node('delay', ['delayTime'], { max });
  ctx.createBiquadFilter = () => node('filter', ['frequency', 'Q', 'gain', 'detune'], { type: 'lowpass' });
  ctx.createWaveShaper = () => node('shaper', [], { curve: null, oversample: 'none' });
  ctx.createOscillator = () => node('osc', ['frequency'], { type: 'sine', started: false, stopped: false, start() { this.started = true; }, stop() { this.stopped = true; } });
  ctx.createChannelMerger = (n) => node('merger', [], { channels: n });
  ctx.createChannelSplitter = (n) => node('splitter', [], { channels: n });
  ctx.createStereoPanner = () => node('panner', ['pan']);
  ctx.createDynamicsCompressor = () => node('compressor', ['threshold', 'ratio', 'attack', 'release', 'knee']);
  return ctx;
}

const env = (ctx, bpm = 120) => ({ ctx, grit: new Float32Array(256), bpm });
const oscs = (ctx) => ctx.nodes.filter((n) => n.kind === 'osc');

describe('effects', () => {
  it('builds every effect with an input and an output', () => {
    const nodes = [
      { kind: 'gain', value: 0.5 }, { kind: 'filter', type: 'lowpass', freq: 800, q: 2 },
      { kind: 'delay' }, { kind: 'distortion' }, { kind: 'chorus' }, { kind: 'phaser' }, { kind: 'tremolo' },
      { kind: 'compressor' }, { kind: 'eq' }, { kind: 'stereo' },
    ];
    for (const n of nodes) {
      const ctx = makeContext();
      const b = buildEffect(env(ctx), n);
      expect(b.input).toBeDefined();
      expect(b.output).toBeDefined();
      b.update(n, 120);
      b.dispose();
    }
  });

  it('builds the amp stages with no extra nodes', () => {
    const ctx = makeContext();
    const gain = buildEffect(env(ctx), { kind: 'gain', value: 1.6 });
    expect(ctx.nodes).toHaveLength(1);
    expect(gain.input).toBe(gain.output);
    expect(gain.input.gain.value).toBe(1.6);
    const filter = buildEffect(env(ctx), { kind: 'filter', type: 'highpass', q: 0.8, freq: 85 });
    expect(filter.input.type).toBe('highpass');
    expect(filter.input.Q.value).toBe(0.8);
    expect(filter.input.frequency.value).toBe(85);
    expect(ctx.nodes).toHaveLength(2);
  });

  it('makes the soft clip of the amp: a plain drive stage, tanh(4x) at 2x oversampling, no filter and no dry path', () => {
    const ctx = makeContext();
    const amp = { kind: 'distortion', drive: 1, hardness: 4, oversample: '2x', tone: 0, level: 1, mix: 1 };
    const d = buildEffect(env(ctx), amp);
    expect(ctx.nodes.map((n) => n.kind)).toEqual(['gain', 'shaper', 'gain']);
    const shaper = ctx.nodes[1];
    expect(shaper.oversample).toBe('2x');
    expect(shaper.curve).toBe(softClip(4));
    expect(d.input).toBe(ctx.nodes[0]);
    expect(d.output).toBe(ctx.nodes[2]);
    expect(d.input.gain.value).toBe(1);
    expect(d.output.gain.value).toBe(1);
  });

  it('shares one tanh curve per hardness, 256 points from -1 to 1', () => {
    const c = softClip(4);
    expect(c).toBe(softClip(4));
    expect(softClip(2)).not.toBe(c);
    expect(c).toHaveLength(256);
    expect(c[0]).toBeCloseTo(Math.tanh(-4));
    expect(c[255]).toBeCloseTo(Math.tanh(4 * (255 / 127.5 - 1)));
    expect(c[128]).toBeCloseTo(Math.tanh(4 * (128 / 127.5 - 1)));
  });

  it('adds the tone filter and the dry path to a distortion only when they are used', () => {
    const ctx = makeContext();
    buildEffect(env(ctx), { kind: 'distortion', mix: 1, tone: 3000 });
    expect(ctx.nodes.filter((n) => n.kind === 'filter')).toHaveLength(1);
    const ctx2 = makeContext();
    buildEffect(env(ctx2), { kind: 'distortion', mix: 0.5, tone: 0 });
    expect(ctx2.nodes.filter((n) => n.kind === 'filter')).toHaveLength(0);
    expect(ctx2.nodes.filter((n) => n.kind === 'gain')).toHaveLength(2 + 4);
  });

  it('moves the distortion drive, level and curve in place', () => {
    const ctx = makeContext();
    const d = buildEffect(env(ctx), { kind: 'distortion', drive: 5, hardness: 2, level: 0.5 });
    const shaper = ctx.nodes.find((n) => n.kind === 'shaper');
    expect(shaper.curve).toBe(softClip(2));
    d.update({ kind: 'distortion', drive: 20, hardness: 6, level: 0.3 }, 120);
    expect(d.input.gain.targets.at(-1)[0]).toBe(20);
    expect(shaper.curve).toBe(softClip(6));
  });

  it('syncs the delay time to the tempo and glides to new values', () => {
    const ctx = makeContext();
    const b = buildEffect(env(ctx, 120), { kind: 'delay', time: 0.5, feedback: 0.4, mix: 0.25 });
    const delay = ctx.nodes.find((n) => n.kind === 'delay');
    expect(delay.delayTime.value).toBeCloseTo(0.25);
    b.update({ kind: 'delay', time: 1 }, 60);
    expect(delay.delayTime.targets.at(-1)[0]).toBeCloseTo(1);
    b.update({ kind: 'delay', time: 8 }, 60);
    expect(delay.delayTime.targets.at(-1)[0]).toBe(4);
  });

  it('keeps feedback below runaway and mixes dry and wet', () => {
    const ctx = makeContext();
    buildEffect(env(ctx), { kind: 'delay', feedback: 5, mix: 2 });
    const gains = ctx.nodes.filter((n) => n.kind === 'gain').map((g) => g.gain.value);
    expect(gains).toContain(0.95);
    expect(gains.filter((g) => g === 0 || g === 1).length).toBeGreaterThanOrEqual(2);
  });

  it('modulates the chorus with opposite depths and stops its oscillator', () => {
    const ctx = makeContext();
    const b = buildEffect(env(ctx), { kind: 'chorus', delay: 10, depth: 3, rate: 1.5 });
    const [lfo] = oscs(ctx);
    expect(lfo.started).toBe(true);
    expect(lfo.frequency.value).toBe(1.5);
    const depths = ctx.nodes.filter((n) => n.kind === 'gain').map((g) => g.gain.value).filter((v) => Math.abs(v) === 0.003);
    expect(depths.sort()).toEqual([-0.003, 0.003]);
    b.dispose();
    expect(lfo.stopped).toBe(true);
  });

  it('limits the chorus depth to its delay so the delay time never goes negative', () => {
    const ctx = makeContext();
    buildEffect(env(ctx), { kind: 'chorus', delay: 5, depth: 50 });
    expect(ctx.nodes.filter((n) => n.kind === 'gain').some((g) => g.gain.value === 0.005)).toBe(true);
  });

  it('makes a phaser of four all-pass stages swept by an oscillator, with its feedback through a delay', () => {
    const ctx = makeContext();
    const b = buildEffect(env(ctx), { kind: 'phaser', freq: 1000, depth: 1, rate: 0.3 });
    expect(ctx.nodes.filter((n) => n.kind === 'filter' && n.type === 'allpass')).toHaveLength(4);
    expect(ctx.nodes.some((n) => n.kind === 'delay')).toBe(true);
    expect(ctx.nodes.some((n) => n.kind === 'gain' && Math.abs(n.gain.value - 900) < 1e-9)).toBe(true);
    b.dispose();
    expect(oscs(ctx)[0].stopped).toBe(true);
  });

  it('turns the tremolo depth into a gain swing between 1 - depth and 1', () => {
    const ctx = makeContext();
    const b = buildEffect(env(ctx), { kind: 'tremolo', depth: 0.6, rate: 7 });
    expect(b.input.gain.value).toBeCloseTo(0.7);
    expect(ctx.nodes.find((n) => n.kind === 'gain' && n !== b.input).gain.value).toBeCloseTo(0.3);
    expect(b.input).toBe(b.output);
  });

  it('sets the compressor and the three EQ bands', () => {
    const ctx = makeContext();
    const c = buildEffect(env(ctx), { kind: 'compressor', threshold: -30, ratio: 8, makeup: 1.5 });
    expect(ctx.nodes.find((n) => n.kind === 'compressor').threshold.value).toBe(-30);
    expect(c.output.gain.value).toBe(1.5);
    const e = buildEffect(env(ctx), { kind: 'eq', low: 3, mid: -2, high: 4, midFreq: 500 });
    expect(e.input.type).toBe('lowshelf');
    expect(e.output.type).toBe('highshelf');
    expect(e.input.gain.value).toBe(3);
    expect(e.output.gain.value).toBe(4);
  });

  it('pans and widens: width 1 keeps the channels, 0 is mono, 2 swaps them apart', () => {
    for (const [width, straight, across] of [[1, 1, 0], [0, 0.5, 0.5], [2, 1.5, -0.5]]) {
      const ctx = makeContext();
      const b = buildEffect(env(ctx), { kind: 'stereo', pan: -0.5, width });
      expect(b.input.pan.value).toBe(-0.5);
      const gains = ctx.nodes.filter((n) => n.kind === 'gain').map((g) => g.gain.value);
      expect(gains.filter((g) => g === straight)).toHaveLength(straight === across ? 4 : 2);
      expect(gains.filter((g) => g === across)).toHaveLength(straight === across ? 4 : 2);
    }
  });
});

describe('buildChain', () => {
  it('wires the effects in series and skips bypassed ones', () => {
    const ctx = makeContext();
    const chain = buildChain(env(ctx), [{ kind: 'gain', value: 2 }, { kind: 'filter', type: 'lowpass', freq: 500, bypass: true }, { kind: 'gain', value: 3 }]);
    expect(chain.indices).toEqual([0, 2]);
    expect(chain.built).toHaveLength(2);
    expect(chain.input.gain.value).toBe(2);
    expect(chain.output.gain.value).toBe(3);
    expect(chain.input.edges[0][0]).toBe(chain.output);
    expect(ctx.nodes.some((n) => n.kind === 'filter')).toBe(false);
  });

  it('returns nothing for an empty or fully bypassed chain', () => {
    expect(buildChain(env(makeContext()), [])).toBeNull();
    expect(buildChain(env(makeContext()), [{ kind: 'delay', bypass: true }])).toBeNull();
  });

  it('disposes every effect', () => {
    const ctx = makeContext();
    buildChain(env(ctx), [{ kind: 'chorus' }, { kind: 'tremolo' }]).dispose();
    expect(oscs(ctx).every((o) => o.stopped)).toBe(true);
  });
});
