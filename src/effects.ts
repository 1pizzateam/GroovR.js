import { Rand } from "@1pizzateam/spock";
import type { EffectNode } from "./song.js";

/** One effect, ready to be wired: sound goes into `input` and comes out of `output`. */
export interface Built {
  input: AudioNode;
  output: AudioNode;
  // Moves the parameters to a node's new values without rebuilding anything
  update(node: EffectNode, bpm: number): void;
  // Stops the oscillators that modulate the effect
  dispose(): void;
}

export interface FxEnv {
  ctx: AudioContext;
  bpm: number;
}

const curves = new Map<number, Float32Array<ArrayBuffer>>();

/** The soft-clipping curve tanh(hardness * x), shared by every distortion, voice shaper and amp. */
export function softClip(hardness: number): Float32Array<ArrayBuffer> {
  let curve = curves.get(hardness);
  if (!curve) {
    curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) curve[i] = Math.tanh((i / 127.5 - 1) * hardness);
    curves.set(hardness, curve);
  }
  return curve;
}

type Of<K extends EffectNode["kind"]> = Extract<EffectNode, { kind: K }>;

const SMOOTH = 0.02;
const MAX_DELAY = 4;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** A parameter setter that sets the value outright while building, then glides to it so knobs do not click. */
function setter(ctx: AudioContext) {
  let initial = true;
  return {
    done: () => (initial = false),
    set(param: AudioParam, value: number) {
      if (initial) param.value = value;
      else param.setTargetAtTime(value, ctx.currentTime, SMOOTH);
    },
  };
}

/** Dry and wet paths crossfaded by a mix amount. The effect goes between `input` and `wet`. */
function dryWet(ctx: AudioContext) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  return {
    input,
    output,
    wet,
    mix(s: ReturnType<typeof setter>, amount: number) {
      const m = clamp(amount, 0, 1);
      s.set(dry.gain, 1 - m);
      s.set(wet.gain, m);
    },
  };
}

function lfo(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.start();
  return osc;
}

const noop = () => {};

function buildGain(env: FxEnv, n: Of<"gain">): Built {
  const g = env.ctx.createGain();
  const s = setter(env.ctx);
  const apply = (x: Of<"gain">) => s.set(g.gain, x.value);
  apply(n);
  s.done();
  return { input: g, output: g, update: (x) => apply(x as Of<"gain">), dispose: noop };
}

function buildFilter(env: FxEnv, n: Of<"filter">): Built {
  const f = env.ctx.createBiquadFilter();
  f.type = n.type;
  const apply = (x: Of<"filter">, initial: boolean) => {
    f.type = x.type;
    const at = initial ? undefined : env.ctx.currentTime;
    if (x.q) initial ? (f.Q.value = x.q) : f.Q.setTargetAtTime(x.q, at!, SMOOTH);
    if (x.freq) initial ? (f.frequency.value = x.freq) : f.frequency.setTargetAtTime(x.freq, at!, SMOOTH);
  };
  apply(n, true);
  return { input: f, output: f, update: (x) => apply(x as Of<"filter">, false), dispose: noop };
}

function buildDelay(env: FxEnv, n: Of<"delay">): Built {
  const { ctx } = env;
  const w = dryWet(ctx);
  const delay = ctx.createDelay(MAX_DELAY);
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  const feedback = ctx.createGain();
  w.input.connect(delay);
  delay.connect(tone);
  tone.connect(feedback);
  feedback.connect(delay);
  tone.connect(w.wet);
  const s = setter(ctx);
  const apply = (x: Of<"delay">, bpm: number) => {
    s.set(delay.delayTime, clamp(((x.time ?? 0.5) * 60) / bpm, 0.001, MAX_DELAY));
    s.set(feedback.gain, clamp(x.feedback ?? 0.35, 0, 0.95));
    s.set(tone.frequency, x.tone ?? 4000);
    w.mix(s, x.mix ?? 0.3);
  };
  apply(n, env.bpm);
  s.done();
  return { input: w.input, output: w.output, update: (x, bpm) => apply(x as Of<"delay">, bpm), dispose: noop };
}

/** Impulse response parameters of a reverb effect, which decide when a new convolver buffer is needed. */
export const reverbShape = (n: Of<"reverb">) => `${n.seconds ?? 1.8}:${n.power ?? 2.5}`;

function buildReverb(env: FxEnv, n: Of<"reverb">): Built {
  const { ctx } = env;
  const w = dryWet(ctx);
  const convolver = ctx.createConvolver();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  const seconds = clamp(n.seconds ?? 1.8, 0.1, 6);
  const power = clamp(n.power ?? 2.5, 0.5, 6);
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = Rand.float(-1, 1) * (1 - i / length) ** power;
  }
  convolver.buffer = impulse;
  w.input.connect(convolver);
  convolver.connect(tone);
  tone.connect(w.wet);
  const s = setter(ctx);
  const apply = (x: Of<"reverb">) => {
    s.set(tone.frequency, clamp(x.tone ?? 4000, 200, 16000));
    w.mix(s, x.mix ?? 0.3);
  };
  apply(n);
  s.done();
  return { input: w.input, output: w.output, update: (x) => apply(x as Of<"reverb">), dispose: noop };
}

/** Whether a distortion needs a low-pass or a dry path of its own, which decides what gets built. */
export const distortionShape = (n: Of<"distortion">) => `${(n.tone ?? 6000) > 0}:${(n.mix ?? 1) < 1}:${n.oversample ?? "4x"}`;

function buildDistortion(env: FxEnv, n: Of<"distortion">): Built {
  const { ctx } = env;
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const post = ctx.createGain();
  shaper.oversample = n.oversample ?? "4x";
  pre.connect(shaper);
  let tone: BiquadFilterNode | null = null;
  if ((n.tone ?? 6000) > 0) {
    tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    shaper.connect(tone);
    tone.connect(post);
  } else shaper.connect(post);
  // The dry path only exists when the effect is mixed in part
  const w = (n.mix ?? 1) < 1 ? dryWet(ctx) : null;
  if (w) {
    w.input.connect(pre);
    post.connect(w.wet);
  }
  const s = setter(ctx);
  const apply = (x: Of<"distortion">) => {
    s.set(pre.gain, clamp(x.drive ?? 8, 0.1, 100));
    shaper.curve = softClip(clamp(x.hardness ?? 2, 0.1, 20));
    if (tone) s.set(tone.frequency, x.tone || 6000);
    s.set(post.gain, x.level ?? 0.6);
    w?.mix(s, x.mix ?? 1);
  };
  apply(n);
  s.done();
  return { input: w?.input ?? pre, output: w?.output ?? post, update: (x) => apply(x as Of<"distortion">), dispose: noop };
}

function buildChorus(env: FxEnv, n: Of<"chorus">): Built {
  const { ctx } = env;
  const w = dryWet(ctx);
  const osc = lfo(ctx);
  const left = ctx.createDelay(0.1);
  const right = ctx.createDelay(0.1);
  const depthL = ctx.createGain();
  const depthR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  osc.connect(depthL);
  osc.connect(depthR);
  depthL.connect(left.delayTime);
  depthR.connect(right.delayTime);
  w.input.connect(left);
  w.input.connect(right);
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  merger.connect(w.wet);
  const s = setter(ctx);
  const apply = (x: Of<"chorus">) => {
    const base = clamp(x.delay ?? 15, 1, 80);
    const depth = clamp(x.depth ?? 4, 0, base);
    s.set(left.delayTime, base / 1000);
    s.set(right.delayTime, base / 1000);
    s.set(depthL.gain, depth / 1000);
    s.set(depthR.gain, -depth / 1000);
    s.set(osc.frequency, x.rate ?? 0.8);
    w.mix(s, x.mix ?? 0.5);
  };
  apply(n);
  s.done();
  return { input: w.input, output: w.output, update: (x) => apply(x as Of<"chorus">), dispose: () => osc.stop() };
}

function buildPhaser(env: FxEnv, n: Of<"phaser">): Built {
  const { ctx } = env;
  const w = dryWet(ctx);
  const osc = lfo(ctx);
  const sweep = ctx.createGain();
  osc.connect(sweep);
  const stages = Array.from({ length: 4 }, () => {
    const f = ctx.createBiquadFilter();
    f.type = "allpass";
    f.Q.value = 0.7;
    sweep.connect(f.frequency);
    return f;
  });
  stages.forEach((f, i) => i && stages[i - 1].connect(f));
  w.input.connect(stages[0]);
  stages[3].connect(w.wet);
  // A delay in the feedback path keeps the loop legal
  const loop = ctx.createDelay(0.01);
  loop.delayTime.value = 0.003;
  const feedback = ctx.createGain();
  stages[3].connect(loop);
  loop.connect(feedback);
  feedback.connect(stages[0]);
  const s = setter(ctx);
  const apply = (x: Of<"phaser">) => {
    const freq = clamp(x.freq ?? 800, 100, 8000);
    for (const f of stages) s.set(f.frequency, freq);
    s.set(sweep.gain, freq * clamp(x.depth ?? 0.7, 0, 1) * 0.9);
    s.set(osc.frequency, x.rate ?? 0.4);
    s.set(feedback.gain, clamp(x.feedback ?? 0.3, 0, 0.9));
    w.mix(s, x.mix ?? 0.5);
  };
  apply(n);
  s.done();
  return { input: w.input, output: w.output, update: (x) => apply(x as Of<"phaser">), dispose: () => osc.stop() };
}

function buildTremolo(env: FxEnv, n: Of<"tremolo">): Built {
  const { ctx } = env;
  const g = ctx.createGain();
  const osc = lfo(ctx);
  const depth = ctx.createGain();
  osc.connect(depth);
  depth.connect(g.gain);
  const s = setter(ctx);
  const apply = (x: Of<"tremolo">) => {
    const d = clamp(x.depth ?? 0.5, 0, 1);
    s.set(g.gain, 1 - d / 2);
    s.set(depth.gain, d / 2);
    s.set(osc.frequency, x.rate ?? 5);
  };
  apply(n);
  s.done();
  return { input: g, output: g, update: (x) => apply(x as Of<"tremolo">), dispose: () => osc.stop() };
}

function buildCompressor(env: FxEnv, n: Of<"compressor">): Built {
  const { ctx } = env;
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  comp.connect(makeup);
  const s = setter(ctx);
  const apply = (x: Of<"compressor">) => {
    s.set(comp.threshold, x.threshold ?? -24);
    s.set(comp.ratio, clamp(x.ratio ?? 4, 1, 20));
    s.set(comp.attack, x.attack ?? 0.01);
    s.set(comp.release, x.release ?? 0.2);
    s.set(comp.knee, x.knee ?? 12);
    s.set(makeup.gain, x.makeup ?? 1);
  };
  apply(n);
  s.done();
  return { input: comp, output: makeup, update: (x) => apply(x as Of<"compressor">), dispose: noop };
}

function buildEq(env: FxEnv, n: Of<"eq">): Built {
  const { ctx } = env;
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  low.connect(mid);
  mid.connect(high);
  const s = setter(ctx);
  const apply = (x: Of<"eq">) => {
    s.set(low.frequency, x.lowFreq ?? 200);
    s.set(low.gain, x.low ?? 0);
    s.set(mid.frequency, x.midFreq ?? 1000);
    s.set(mid.gain, x.mid ?? 0);
    s.set(mid.Q, x.q ?? 0.8);
    s.set(high.frequency, x.highFreq ?? 4000);
    s.set(high.gain, x.high ?? 0);
  };
  apply(n);
  s.done();
  return { input: low, output: high, update: (x) => apply(x as Of<"eq">), dispose: noop };
}

function buildStereo(env: FxEnv, n: Of<"stereo">): Built {
  const { ctx } = env;
  const panner = ctx.createStereoPanner();
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  // Width crossfades the channels: 1 leaves them alone, 0 makes mono, above 1 pushes them apart
  const straight = [ctx.createGain(), ctx.createGain()];
  const across = [ctx.createGain(), ctx.createGain()];
  panner.connect(splitter);
  splitter.connect(straight[0], 0);
  splitter.connect(across[0], 0);
  splitter.connect(across[1], 1);
  splitter.connect(straight[1], 1);
  straight[0].connect(merger, 0, 0);
  across[0].connect(merger, 0, 1);
  across[1].connect(merger, 0, 0);
  straight[1].connect(merger, 0, 1);
  const s = setter(ctx);
  const apply = (x: Of<"stereo">) => {
    const w = clamp(x.width ?? 1, 0, 2);
    s.set(panner.pan, clamp(x.pan ?? 0, -1, 1));
    for (const g of straight) s.set(g.gain, (1 + w) / 2);
    for (const g of across) s.set(g.gain, (1 - w) / 2);
  };
  apply(n);
  s.done();
  return { input: panner, output: merger, update: (x) => apply(x as Of<"stereo">), dispose: noop };
}

export function buildEffect(env: FxEnv, node: EffectNode): Built {
  switch (node.kind) {
    case "gain":
      return buildGain(env, node);
    case "filter":
      return buildFilter(env, node);
    case "delay":
      return buildDelay(env, node);
    case "reverb":
      return buildReverb(env, node);
    case "distortion":
      return buildDistortion(env, node);
    case "chorus":
      return buildChorus(env, node);
    case "phaser":
      return buildPhaser(env, node);
    case "tremolo":
      return buildTremolo(env, node);
    case "compressor":
      return buildCompressor(env, node);
    case "eq":
      return buildEq(env, node);
    case "stereo":
      return buildStereo(env, node);
  }
}

export interface Chain {
  input: AudioNode;
  output: AudioNode;
  built: Built[];
  // Index in the song's chain of each built effect, bypassed ones being skipped
  indices: number[];
  dispose(): void;
}

/** The active effects of a chain wired in series, or null when there is nothing to wire. */
export function buildChain(env: FxEnv, nodes: EffectNode[]): Chain | null {
  const indices = nodes.flatMap((n, i) => (n.bypass ? [] : [i]));
  if (indices.length === 0) return null;
  const built = indices.map((i) => buildEffect(env, nodes[i]));
  for (let i = 0; i < built.length - 1; i++) built[i].output.connect(built[i + 1].input);
  return {
    input: built[0].input,
    output: built[built.length - 1].output,
    built,
    indices,
    dispose: () => built.forEach((b) => b.dispose()),
  };
}
