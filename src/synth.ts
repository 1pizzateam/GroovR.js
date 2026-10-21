import { Rand, Utils } from "@1pizzateam/spock";
import { buildEffect, softClip } from "./effects.js";
import type { Adsr, EffectNode, Expr, FilterType, Instrument, NoiseLayer, Point, VoiceLayer, Waveform } from "./song.js";

const NOISE_SECONDS = 4;
// An exponential ramp cannot reach zero, so a patch scaled down to nothing ramps to silence instead
const MIN_EXP_TARGET = 0.0001;
const EMPTY_FX: readonly EffectNode[] = [];

export interface Trigger {
  f: number;
  d: number;
  v: number;
  r: number;
  r2: number;
  r3: number;
}

export interface SynthRouting {
  bpm: number;
  noise: AudioBuffer;
  route(instrument: string, out?: string, gated?: boolean): AudioNode;
  send(node: AudioNode, amount: number, instrument?: string): void;
}

/** Evaluates a constant or linear combination of note frequency, duration, velocity and random draws. */
export function evaluate(e: Expr | undefined, t: Trigger): number {
  if (typeof e === "number") return e;
  if (!e) return 0;
  const v = (e.b ?? 0) + (e.f ?? 0) * t.f + (e.d ?? 0) * t.d + (e.v ?? 0) * t.v + (e.r ?? 0) * t.r + (e.r2 ?? 0) * t.r2 + (e.r3 ?? 0) * t.r3;
  return e.max === undefined ? v : Math.min(v, e.max);
}

/** Creates the shared white-noise buffer used by noise layers. */
export function createNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Rand.float(-1, 1);
  return buffer;
}

function envelope(param: AudioParam, t: number, points: Point[], trig: Trigger): void {
  for (const p of points) {
    const dt = evaluate(p[0], trig);
    const value = evaluate(p[1], trig);
    const ramp = p[2] ?? "linear";
    if (dt === 0 || ramp === "hold") param.setValueAtTime(value, t + dt);
    else if (ramp === "exp") param.exponentialRampToValueAtTime(Math.max(value, MIN_EXP_TARGET), t + dt);
    else param.linearRampToValueAtTime(value, t + dt);
  }
}

function adsr(param: AudioParam, t: number, hold: number, spec: Adsr, trig: Trigger, base = 0, defaultAmount = trig.v): number {
  const attack = Math.max(0.001, evaluate(spec.attack, trig));
  const decay = Math.max(0.001, evaluate(spec.decay, trig));
  const release = Math.max(0.001, evaluate(spec.release, trig));
  const amount = spec.amount === undefined ? defaultAmount : evaluate(spec.amount, trig);
  const sustain = Utils.clamp(evaluate(spec.sustain, trig), 0, 1);
  const startVal = Math.max(MIN_EXP_TARGET, base);
  const peakVal = base === 0 ? Math.max(MIN_EXP_TARGET, amount) : Utils.clamp(base + amount, 20, 20000);
  const sustainVal = base === 0 ? Math.max(MIN_EXP_TARGET, amount * sustain) : Utils.clamp(base + amount * sustain, 20, 20000);
  const releaseAt = Math.max(t + attack, t + hold);
  param.setValueAtTime(base === 0 ? 0 : startVal, t);
  if (base === 0) param.linearRampToValueAtTime(peakVal, t + attack);
  else param.exponentialRampToValueAtTime(peakVal, t + attack);
  if (t + attack + decay < releaseAt) {
    param.exponentialRampToValueAtTime(sustainVal, t + attack + decay);
    param.setValueAtTime(sustainVal, releaseAt);
  } else param.exponentialRampToValueAtTime(sustainVal, releaseAt);
  param.exponentialRampToValueAtTime(startVal, releaseAt + release);
  return releaseAt + release;
}

function filter(
  ctx: AudioContext,
  t: number,
  f: { type?: FilterType; q?: number; freq?: number; envelope?: Point[]; adsr?: Adsr },
  trig: Trigger,
  env = f.envelope,
  hold = trig.d,
): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = f.type ?? "lowpass";
  if (f.q) node.Q.value = f.q;
  if (f.adsr) adsr(node.frequency, t, hold, f.adsr, trig, Math.max(20, f.freq ?? 1000), 0);
  else if (env) envelope(node.frequency, t, env, trig);
  else if (f.freq) node.frequency.value = f.freq;
  return node;
}

function modulate(ctx: AudioContext, param: AudioParam, start: number, stop: number, rate: number, amount: number, type: Waveform = "sine"): void {
  const mod = ctx.createOscillator();
  if (type !== "sine") mod.type = type;
  mod.frequency.value = rate;
  const depth = ctx.createGain();
  depth.gain.value = amount;
  mod.connect(depth);
  depth.connect(param);
  mod.start(start);
  mod.stop(stop);
}

function voice(ctx: AudioContext, routing: SynthRouting, t: number, l: VoiceLayer, trig: Trigger, inst: Instrument, primary: boolean, gated: boolean): void {
  const dest = routing.route(inst.id, l.out, gated);
  const duration = evaluate(l.duration, trig);
  const gain = ctx.createGain();
  let endAt = t + duration;
  if (l.adsr) endAt = adsr(gain.gain, t, duration, l.adsr, trig);
  else if (l.envelope) envelope(gain.gain, t, l.envelope, trig);
  const stopAt = endAt + (l.pad ?? 0.05);
  gain.connect(dest);
  const wet = evaluate(l.wet, trig);
  if (wet) routing.send(gain, wet, gated ? inst.id : undefined);

  let target: AudioNode = gain;
  if (l.lfo) {
    const pulse = ctx.createGain();
    pulse.gain.value = l.lfo.base;
    modulate(ctx, pulse.gain, t, stopAt, l.lfo.freq, l.lfo.depth);
    pulse.connect(gain);
    target = pulse;
  }
  if (l.lfos)
    for (const m of l.lfos)
      if (m.target === "amp" && m.rate > 0 && m.depth > 0) {
        const d = Utils.clamp(m.depth, 0, 1);
        const pulse = ctx.createGain();
        pulse.gain.value = 1 - d * 0.5;
        modulate(ctx, pulse.gain, t, stopAt, m.rate, d * 0.5, m.type);
        pulse.connect(target);
        target = pulse;
      }

  let chainInput: AudioNode = target;
  const fxChain = primary ? (inst.fx?.chain ?? EMPTY_FX) : EMPTY_FX;
  for (let i = fxChain.length - 1; i >= 0; i--) {
    const n = fxChain[i];
    if (n.bypass || n.kind !== "distortion") continue;
    if ((n.drive ?? 8) === 1 && (n.tone ?? 6000) === 0 && (n.level ?? 0.6) === 1 && (n.mix ?? 1) === 1 && (n.oversample ?? "none") === "none") {
      const shaper = ctx.createWaveShaper();
      shaper.curve = softClip(Utils.clamp(n.hardness ?? 2, 0.1, 20));
      shaper.connect(chainInput);
      chainInput = shaper;
    } else {
      const built = buildEffect({ ctx, bpm: routing.bpm }, n);
      built.output.connect(chainInput);
      chainInput = built.input;
    }
  }
  if (l.filter) {
    const node = filter(ctx, t, l.filter, trig, l.filter.envelope, duration);
    if (l.lfos)
      for (const m of l.lfos)
        if (m.target === "cutoff" && m.rate > 0 && m.depth > 0)
          modulate(ctx, node.frequency, t, stopAt, m.rate, m.depth, m.type);
    node.connect(chainInput);
    chainInput = node;
  }
  if (l.shaper) {
    const drive = ctx.createWaveShaper();
    drive.curve = softClip(l.shaper === true ? 4 : l.shaper);
    drive.connect(chainInput);
    chainInput = drive;
  }

  for (const spec of l.voices) {
    const voiceGain = spec.gain === undefined ? 1 : evaluate(spec.gain, trig);
    if (voiceGain <= 0) continue;
    const osc = ctx.createOscillator();
    if (spec.type) osc.type = spec.type;
    if (spec.pitch) envelope(osc.frequency, t, spec.pitch, trig);
    else osc.frequency.value = evaluate(spec.freq, trig);
    const detune = evaluate(spec.detune, trig);
    if (detune) osc.detune.value = detune;
    if (l.vibrato && l.vibrato.rate > 0 && l.vibrato.depth > 0)
      modulate(ctx, osc.frequency, t, stopAt, l.vibrato.rate, l.vibrato.depth);
    if (l.lfos)
      for (const m of l.lfos)
        if ((m.target ?? "pitch") === "pitch" && m.rate > 0 && m.depth > 0)
          modulate(ctx, osc.detune, t, stopAt, m.rate, m.depth, m.type);
    for (const n of fxChain)
      if (!n.bypass && n.kind === "vibrato" && (n.rate ?? 6) > 0 && (n.depth ?? 12) > 0)
        modulate(ctx, osc.frequency, t, stopAt, n.rate ?? 6, n.depth ?? 12);
    const sink = spec.direct ? target : chainInput;
    if (voiceGain === 1) osc.connect(sink);
    else {
      const g = ctx.createGain();
      g.gain.value = voiceGain;
      osc.connect(g);
      g.connect(sink);
    }
    osc.start(t);
    osc.stop(stopAt);
  }
}

function noiseHit(ctx: AudioContext, routing: SynthRouting, t: number, l: NoiseLayer, trig: Trigger, instrument: string, gated: boolean): void {
  const dest = routing.route(instrument, undefined, gated);
  const length = evaluate(l.length, trig);
  const source = ctx.createBufferSource();
  source.buffer = routing.noise;
  const filterNode = filter(ctx, t, l, trig, l.filterEnvelope);
  const gain = ctx.createGain();
  if (l.envelope) envelope(gain.gain, t, l.envelope, trig);
  else {
    gain.gain.setValueAtTime(evaluate(l.level, trig), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + length);
  }
  source.connect(filterNode);
  filterNode.connect(gain);
  gain.connect(dest);
  const wet = evaluate(l.wet, trig);
  if (wet) routing.send(gain, wet, gated ? instrument : undefined);
  source.start(t, l.offset === undefined ? Rand.float(0, 3) : evaluate(l.offset, trig));
  source.stop(t + length + (l.pad ?? 0.02));
}

/** Synthesizes all voice and noise layers of `inst` for a single note at `when`. */
export function playNote(
  ctx: AudioContext,
  routing: SynthRouting,
  inst: Instrument,
  when: number,
  f: number,
  d: number,
  v: number,
  gated: boolean,
  trig: Trigger,
): void {
  trig.f = f;
  trig.d = d;
  for (let i = 0; i < inst.layers.length; i++) {
    const layer = inst.layers[i];
    trig.v = v;
    trig.r = Rand.float(0, 1);
    trig.r2 = Rand.float(0, 1);
    trig.r3 = Rand.float(0, 1);
    if (layer.velocity !== undefined) trig.v = evaluate(layer.velocity, trig);
    if (layer.kind === "voice") voice(ctx, routing, when, layer, trig, inst, i === 0, gated);
    else noiseHit(ctx, routing, when, layer, trig, inst.id, gated);
  }
}
