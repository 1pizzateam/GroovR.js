import { Rand, Utils } from "@1pizzateam/spock";
import { buildEffect, softClip } from "./effects.js";
import type { Built } from "./effects.js";
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

export interface ScheduledNote {
  inst: string;
  when: number;
  stopAt: number;
  cancel(): void;
  update(inst: Instrument, bpm: number): void;
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

function envelope(param: AudioParam, t: number, points: Point[], trig: Trigger, now = t): void {
  let prevTime = t;
  let prevVal = 0;
  let anchored = now <= t;
  for (const p of points) {
    const at = t + evaluate(p[0], trig);
    const value = evaluate(p[1], trig);
    const ramp = p[2] ?? "linear";
    if (!anchored && at > now) {
      const cur = ramp === "hold" ? prevVal : Utils.map(now, prevTime, at, prevVal, value);
      param.setValueAtTime(ramp === "exp" ? Math.max(cur, MIN_EXP_TARGET) : cur, now);
      anchored = true;
    }
    if (at >= now)
      if (at === t || ramp === "hold") param.setValueAtTime(value, at);
      else if (ramp === "exp") param.exponentialRampToValueAtTime(Math.max(value, MIN_EXP_TARGET), at);
      else param.linearRampToValueAtTime(value, at);
    prevTime = at;
    prevVal = value;
  }
}

function adsr(param: AudioParam, t: number, hold: number, spec: Adsr, trig: Trigger, base = 0, defaultAmount = trig.v, now = t): number {
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
    if (now > t + attack + decay && now < releaseAt) param.setValueAtTime(sustainVal, now);
    param.setValueAtTime(sustainVal, releaseAt);
  } else param.exponentialRampToValueAtTime(sustainVal, releaseAt);
  param.exponentialRampToValueAtTime(startVal, releaseAt + release);
  return releaseAt + release;
}

function applyFilter(
  node: BiquadFilterNode,
  t: number,
  f: { type?: FilterType; q?: number; freq?: number; envelope?: Point[]; adsr?: Adsr },
  trig: Trigger,
  env = f.envelope,
  hold = trig.d,
  now = t,
): void {
  node.type = f.type ?? "lowpass";
  if (f.q) node.Q.value = f.q;
  if (f.adsr) adsr(node.frequency, t, hold, f.adsr, trig, Math.max(20, f.freq ?? 1000), 0, now);
  else if (env) envelope(node.frequency, t, env, trig, now);
  else if (f.freq) node.frequency.value = f.freq;
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
  applyFilter(node, t, f, trig, env, hold);
  return node;
}

function modulate(
  ctx: AudioContext,
  param: AudioParam,
  start: number,
  stop: number,
  rate: number,
  amount: number,
  type: Waveform = "sine",
  sources?: AudioScheduledSourceNode[],
): void {
  const mod = ctx.createOscillator();
  if (type !== "sine") mod.type = type;
  mod.frequency.value = rate;
  const depth = ctx.createGain();
  depth.gain.value = amount;
  mod.connect(depth);
  depth.connect(param);
  mod.start(start);
  mod.stop(stop);
  sources?.push(mod);
}

function voice(
  ctx: AudioContext,
  routing: SynthRouting,
  t: number,
  l: VoiceLayer,
  trig: Trigger,
  inst: Instrument,
  layerIndex: number,
   gated: boolean,
  outputs: AudioNode[],
  sources: AudioScheduledSourceNode[],
  updaters: ((inst: Instrument, bpm: number) => void)[],
): number {
  const primary = layerIndex === 0;
  const layerTrig = { ...trig };
  const dest = routing.route(inst.id, l.out, gated);
  const duration = evaluate(l.duration, trig);
  const gain = ctx.createGain();
  outputs.push(gain);
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
    modulate(ctx, pulse.gain, t, stopAt, l.lfo.freq, l.lfo.depth, "sine", sources);
    pulse.connect(gain);
    target = pulse;
  }
  if (l.lfos)
    for (const m of l.lfos)
      if (m.target === "amp" && m.rate > 0 && m.depth > 0) {
        const d = Utils.clamp(m.depth, 0, 1);
        const pulse = ctx.createGain();
        pulse.gain.value = 1 - d * 0.5;
        modulate(ctx, pulse.gain, t, stopAt, m.rate, d * 0.5, m.type, sources);
        pulse.connect(target);
        target = pulse;
      }

  let chainInput: AudioNode = target;
  const fxChain = primary ? (inst.fx?.chain ?? EMPTY_FX) : EMPTY_FX;
  const fxBuilt: { index: number; built: Built }[] = [];
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
      fxBuilt.push({ index: i, built });
    }
  }
  let filterNode: BiquadFilterNode | null = null;
  if (l.filter) {
    filterNode = filter(ctx, t, l.filter, trig, l.filter.envelope, duration);
    if (l.lfos)
      for (const m of l.lfos)
        if (m.target === "cutoff" && m.rate > 0 && m.depth > 0)
          modulate(ctx, filterNode.frequency, t, stopAt, m.rate, m.depth, m.type, sources);
    filterNode.connect(chainInput);
    chainInput = filterNode;
  }
  if (l.shaper) {
    const drive = ctx.createWaveShaper();
    drive.curve = softClip(l.shaper === true ? 4 : l.shaper);
    drive.connect(chainInput);
    chainInput = drive;
  }

  const oscRefs: { osc: OscillatorNode; index: number }[] = [];
  for (let i = 0; i < l.voices.length; i++) {
    const spec = l.voices[i];
    const voiceGain = spec.gain === undefined ? 1 : evaluate(spec.gain, trig);
    if (voiceGain <= 0) continue;
    const osc = ctx.createOscillator();
    if (spec.type) osc.type = spec.type;
    if (spec.pitch) envelope(osc.frequency, t, spec.pitch, trig);
    else osc.frequency.value = evaluate(spec.freq, trig);
    const detune = evaluate(spec.detune, trig);
    if (detune) osc.detune.value = detune;
    if (l.vibrato && l.vibrato.rate > 0 && l.vibrato.depth > 0)
      modulate(ctx, osc.frequency, t, stopAt, l.vibrato.rate, l.vibrato.depth, "sine", sources);
    if (l.lfos)
      for (const m of l.lfos)
        if ((m.target ?? "pitch") === "pitch" && m.rate > 0 && m.depth > 0)
          modulate(ctx, osc.detune, t, stopAt, m.rate, m.depth, m.type, sources);
    for (const n of fxChain)
      if (!n.bypass && n.kind === "vibrato" && (n.rate ?? 6) > 0 && (n.depth ?? 12) > 0)
        modulate(ctx, osc.frequency, t, stopAt, n.rate ?? 6, n.depth ?? 12, "sine", sources);
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
    sources.push(osc);
    oscRefs.push({ osc, index: i });
  }
  updaters.push((nextInst, bpm) => {
    const now = ctx.currentTime;
    const next = nextInst.layers[layerIndex] as VoiceLayer;
    gain.gain.cancelScheduledValues(t);
    if (next.adsr) adsr(gain.gain, t, duration, next.adsr, layerTrig, 0, layerTrig.v, now);
    else if (next.envelope) envelope(gain.gain, t, next.envelope, layerTrig, now);
    if (filterNode && next.filter) {
      filterNode.frequency.cancelScheduledValues(t);
      applyFilter(filterNode, t, next.filter, layerTrig, next.filter.envelope, duration, now);
    }
    for (const b of fxBuilt) {
      const fxNode = nextInst.fx?.chain[b.index];
      if (fxNode) b.built.update(fxNode, bpm);
    }
    for (const { osc, index } of oscRefs) {
      const spec = next.voices[index];
      if (!spec) continue;
      if (spec.type) osc.type = spec.type;
      if (!spec.pitch) osc.frequency.value = evaluate(spec.freq, layerTrig);
      osc.detune.value = evaluate(spec.detune, layerTrig);
    }
  });
  return stopAt;
}

function noiseHit(
  ctx: AudioContext,
  routing: SynthRouting,
  t: number,
  l: NoiseLayer,
  trig: Trigger,
  instrument: string,
  gated: boolean,
  outputs: AudioNode[],
  sources: AudioScheduledSourceNode[],
): number {
  const dest = routing.route(instrument, undefined, gated);
  const length = evaluate(l.length, trig);
  const source = ctx.createBufferSource();
  source.buffer = routing.noise;
  const filterNode = filter(ctx, t, l, trig, l.filterEnvelope);
  const gain = ctx.createGain();
  outputs.push(gain);
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
  const stopAt = t + length + (l.pad ?? 0.02);
  source.start(t, l.offset === undefined ? Rand.float(0, 3) : evaluate(l.offset, trig));
  source.stop(stopAt);
  sources.push(source);
  return stopAt;
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
): ScheduledNote {
  trig.f = f;
  trig.d = d;
  const outputs: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  const updaters: ((inst: Instrument, bpm: number) => void)[] = [];
  let stopAt = when;
  for (let i = 0; i < inst.layers.length; i++) {
    const layer = inst.layers[i];
    trig.v = v;
    trig.r = Rand.next();
    trig.r2 = Rand.next();
    trig.r3 = Rand.next();
    if (layer.velocity !== undefined) trig.v = evaluate(layer.velocity, trig);
    const layerStop =
      layer.kind === "voice"
        ? voice(ctx, routing, when, layer, trig, inst, i, gated, outputs, sources, updaters)
        : noiseHit(ctx, routing, when, layer, trig, inst.id, gated, outputs, sources);
    stopAt = Math.max(stopAt, layerStop);
  }
  return {
    inst: inst.id,
    when,
    stopAt,
    cancel() {
      for (const g of outputs) g.disconnect();
      for (const s of sources) s.stop(when);
    },
    update(nextInst, bpm) {
      for (const fn of updaters) fn(nextInst, bpm);
    },
  };
}
