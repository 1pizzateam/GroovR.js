import { Rand } from "@1pizzateam/spock";
import { buildTimeline, midiToFrequency } from "./events.js";
import type { NoteEvent, Stream, Timeline } from "./events.js";
import { buildChain, distortionShape, softClip } from "./effects.js";
import type { Chain, FxEnv } from "./effects.js";
import type { Bus, EffectNode, Expr, FilterType, Fx, Instrument, NoiseLayer, Point, Song, VoiceLayer } from "./song.js";

const LOOKAHEAD = 3;
const INTERVAL_MS = 100;
const NOISE_SECONDS = 4;
const RELEASE_DELAY_MS = 30000;
// An exponential ramp cannot reach zero, so a patch scaled down to nothing ramps to silence instead
const MIN_EXP_TARGET = 0.0001;

interface Trigger {
  f: number;
  d: number;
  v: number;
  r: number;
  r2: number;
  r3: number;
}

// An effects chain as built, with what is needed to move its parameters later
interface ChainRef {
  chain: Chain | null;
  spec: (song: Song) => { nodes: EffectNode[]; gain: number; send?: number } | undefined;
  out: GainNode;
  send?: GainNode;
}

interface Level {
  level: GainNode;
  wetBus: GainNode;
  convolver: ConvolverNode;
  tail: GainNode;
  buses: Map<string, AudioNode>;
  // Input of each instrument's effects chain
  fx: Map<string, AudioNode>;
  chains: ChainRef[];
}

const isActive = (nodes: EffectNode[]) => nodes.some((n) => !n.bypass);
const usesFx = (fx: Fx | undefined, master = false): fx is Fx =>
  !!fx && (isActive(fx.chain) || (fx.gain ?? 1) !== 1 || (!master && (fx.send ?? 0) > 0));

/** What decides the shape of the audio graph: which effects exist, in what order and where they send. */
function structureKey(song: Song): string {
  const kinds = (nodes: EffectNode[]) => nodes.map((n) => (n.bypass ? `-${n.kind}` : n.kind === "distortion" ? `distortion:${distortionShape(n)}` : n.kind));
  return JSON.stringify([
    [song.reverb.seconds, song.reverb.power],
    song.buses.map((b) => [b.id, kinds(b.chain)]),
    song.instruments.filter((i) => usesFx(i.fx)).map((i) => [i.id, kinds(i.fx!.chain), i.fx!.out ?? ""]),
    usesFx(song.master, true) ? kinds(song.master!.chain) : null,
  ]);
}

interface StreamState {
  stream: Stream;
  cursor: number;
  pass: number;
  done: boolean;
}

export interface PlayerOptions {
  // Where the song is sent. Defaults to a master gain and limiter feeding ctx.destination
  destination?: AudioNode;
  volume?: number;
  // Initial gain of the song's dry bus, the song's own level when omitted
  level?: number;
}

// Timers must not keep a Node process alive
function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

function evaluate(e: Expr | undefined, t: Trigger): number {
  if (typeof e === "number") return e;
  if (!e) return 0;
  const v = (e.b ?? 0) + (e.f ?? 0) * t.f + (e.d ?? 0) * t.d + (e.v ?? 0) * t.v + (e.r ?? 0) * t.r + (e.r2 ?? 0) * t.r2 + (e.r3 ?? 0) * t.r3;
  return e.max === undefined ? v : Math.min(v, e.max);
}

export class Player {
  private ctx: AudioContext;
  private destination: AudioNode;
  private song!: Song;
  private timeline!: Timeline;
  private instruments = new Map<string, Instrument>();
  private bus: Level | null = null;
  private busKey = "";
  private options: PlayerOptions;
  private noise: AudioBuffer;
  private timer: ReturnType<typeof setInterval> | null = null;
  private streams: StreamState[] = [];
  private startTime = 0;
  // Beat up to which notes were already handed to the audio clock
  private scheduledTo = 0;
  private impulse: { key: string; buffer: AudioBuffer } | null = null;

  constructor(ctx: AudioContext, song: Song, options: PlayerOptions = {}) {
    this.ctx = ctx;
    this.options = options;
    this.destination = options.destination ?? Player.createOutput(ctx, options.volume);
    this.noise = this.createNoise();
    this.setSong(song);
  }

  /** A master gain into a limiter, like the DoomR game output. */
  static createOutput(ctx: AudioContext, volume = 0.8): AudioNode {
    const master = ctx.createGain();
    master.gain.value = volume;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    return master;
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  /** Current position in beats, wrapped by the loop. */
  get position(): number {
    if (!this.playing) return 0;
    const beats = ((this.ctx.currentTime - this.startTime) * this.song.bpm) / 60;
    const { length, span } = this.timeline.main;
    if (!this.song.loop || span <= 0 || beats < length) return Math.max(0, beats);
    return length - span + ((beats - length) % span);
  }

  setSong(song: Song): void {
    this.song = song;
    this.timeline = buildTimeline(song);
    this.instruments = new Map(song.instruments.map((i) => [i.id, i]));
    // The buses only change with the mix settings, so editing notes or patches keeps the sounding notes on theirs
    const key = structureKey(song);
    if (this.bus && key !== this.busKey) {
      if (this.playing) this.releaseLater(this.bus);
      else this.release(this.bus, 0);
      this.bus = null;
    } else if (this.bus) this.updateParams(this.bus, song);
    this.busKey = key;
    if (this.playing) this.streams = this.seek();
  }

  /** Plays one note of an instrument right now, to audition a patch. */
  preview(instrument: string, pitch = 57, seconds = 0.5, velocity = 1): void {
    const inst = this.instruments.get(instrument);
    if (inst) this.playNote(inst, this.ctx.currentTime + 0.02, { f: midiToFrequency(pitch), d: seconds, v: velocity, r: 0, r2: 0, r3: 0 });
  }

  /** Sets the dry level, easing towards it with the given time constant in seconds. */
  setLevel(level: number, timeConstant = 0.15): void {
    this.getBus().level.gain.setTargetAtTime(level, this.ctx.currentTime, timeConstant);
  }

  /** Silences the song, then ramps its dry level up to `level` over `seconds`, starting after `delay`. */
  fadeIn(level: number, seconds: number, delay = 0): void {
    const g = this.getBus().level.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    if (delay) g.setValueAtTime(0, now + delay);
    g.linearRampToValueAtTime(level, now + delay + seconds);
  }

  /** Starts the song `delay` seconds from now. */
  play(delay = 0.05): void {
    if (this.playing) return;
    this.scheduledTo = 0;
    this.streams = this.seek();
    this.startTime = this.ctx.currentTime + delay;
    this.timer = setInterval(() => this.schedule(), INTERVAL_MS);
    this.schedule();
  }

  /** Stops scheduling and fades what is already sounding out over `fade` seconds, tail included. */
  stop(fade = 0.25): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.release(this.bus, fade);
    this.bus = null;
  }

  private getBus(): Level {
    return (this.bus ??= this.createLevel(this.song));
  }

  private release(bus: Level | null, fade: number): void {
    if (!bus) return;
    const now = this.ctx.currentTime;
    for (const g of [bus.level, bus.wetBus, bus.tail]) {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + fade);
    }
    unref(setTimeout(() => {
      for (const n of [bus.level, bus.wetBus, bus.convolver, bus.tail]) n.disconnect();
      for (const c of bus.chains) c.chain?.dispose();
    }, fade * 1000 + 100));
  }

  // A replaced bus keeps sounding until its scheduled notes have died away
  private releaseLater(bus: Level | null): void {
    if (bus) unref(setTimeout(() => this.release(bus, 0.25), RELEASE_DELAY_MS));
  }

  /** Streams positioned on the first note not yet scheduled, so an edited song carries on without repeating notes. */
  private seek(): StreamState[] {
    const at = this.scheduledTo;
    return [this.timeline.main, ...this.timeline.periodic].map((stream) => {
      const state: StreamState = { stream, cursor: 0, pass: 0, done: false };
      if (at >= stream.length) {
        if (!this.song.loop || stream.span <= 0) state.done = true;
        else state.pass = Math.floor((at - stream.length) / stream.span) + 1;
      }
      const list = state.pass === 0 ? stream.events : stream.loopEvents;
      const offset = state.pass > 0 ? state.pass * stream.span : 0;
      while (state.cursor < list.length && list[state.cursor].time + offset <= at && at > 0) state.cursor++;
      return state;
    });
  }

  private schedule(): void {
    const beat = 60 / this.song.bpm;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    this.scheduledTo = Math.max(this.scheduledTo, (horizon - this.startTime) / beat);
    for (const s of this.streams) this.pump(s, horizon, beat);
    if (this.streams.every((s) => s.done) && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private pump(s: StreamState, horizon: number, beat: number): void {
    const { stream } = s;
    while (!s.done) {
      const list = s.pass === 0 ? stream.events : stream.loopEvents;
      if (s.cursor >= list.length) {
        if (!this.song.loop || stream.loopEvents.length === 0 || stream.span <= 0) s.done = true;
        else {
          s.pass++;
          s.cursor = 0;
        }
        continue;
      }
      const e = list[s.cursor];
      const when = this.startTime + (e.time + (s.pass > 0 ? s.pass * stream.span : 0)) * beat;
      if (when > horizon) return;
      s.cursor++;
      if (when >= this.ctx.currentTime) this.trigger(e, when, beat);
    }
  }

  private trigger(e: NoteEvent, when: number, beat: number): void {
    const inst = this.instruments.get(this.song.tracks[e.track].instrument);
    if (inst) this.playNote(inst, when, { f: midiToFrequency(e.pitch), d: e.duration * beat, v: e.velocity, r: 0, r2: 0, r3: 0 });
  }

  private playNote(inst: Instrument, when: number, base: Trigger): void {
    for (const layer of inst.layers) {
      const t = { ...base, r: Rand.float(0, 1), r2: Rand.float(0, 1), r3: Rand.float(0, 1) };
      if (layer.velocity !== undefined) t.v = evaluate(layer.velocity, t);
      if (layer.kind === "voice") this.voice(when, layer, t, inst.id);
      else this.noiseHit(when, layer, t, inst.id);
    }
  }

  private createLevel(song: Song): Level {
    const { ctx } = this;
    const env: FxEnv = { ctx, bpm: song.bpm };
    const chains: ChainRef[] = [];

    // The whole mix goes through the master chain when there is one, reverb tail included
    let sink: AudioNode = this.destination;
    if (usesFx(song.master, true)) {
      const master = song.master;
      const input = ctx.createGain();
      const chain = buildChain(env, master.chain);
      const out = ctx.createGain();
      out.gain.value = master.gain ?? 1;
      if (chain) {
        input.connect(chain.input);
        chain.output.connect(out);
      } else input.connect(out);
      out.connect(this.destination);
      chains.push({ chain, spec: (x) => x.master && { nodes: x.master.chain, gain: x.master.gain ?? 1 }, out });
      sink = input;
    }

    const level = ctx.createGain();
    level.gain.value = this.options.level ?? song.level;
    level.connect(sink);
    const wetBus = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = this.createImpulse(song);
    const tail = ctx.createGain();
    tail.gain.value = song.reverb.return;
    wetBus.connect(convolver);
    convolver.connect(tail);
    tail.connect(sink);
    const bus: Level = { level, wetBus, convolver, tail, buses: new Map(), fx: new Map(), chains };
    for (const b of song.buses) bus.buses.set(b.id, this.createBus(b, bus, env));
    for (const inst of song.instruments) if (usesFx(inst.fx)) this.createInstrumentFx(inst, bus, env);
    return bus;
  }

  private createBus(b: Bus, level: Level, env: FxEnv): AudioNode {
    const { ctx } = env;
    const chain = buildChain(env, b.chain);
    const out = ctx.createGain();
    out.gain.value = b.gain;
    if (chain) chain.output.connect(out);
    out.connect(level.level);
    const send = this.send(level, out, b.wet);
    const spec = (x: Song) => {
      const found = x.buses.find((y) => y.id === b.id);
      return found && { nodes: found.chain, gain: found.gain, send: found.wet };
    };
    level.chains.push({ chain, spec, out, send });
    return chain?.input ?? out;
  }

  /** Routes an instrument through its own effects chain, then on to the level bus or the bus it names. */
  private createInstrumentFx(inst: Instrument, level: Level, env: FxEnv): void {
    const fx = inst.fx!;
    const { ctx } = env;
    const chain = buildChain(env, fx.chain);
    const out = ctx.createGain();
    out.gain.value = fx.gain ?? 1;
    if (chain) chain.output.connect(out);
    out.connect((fx.out && level.buses.get(fx.out)) || level.level);
    const send = this.send(level, out, fx.send ?? 0);
    const spec = (x: Song) => {
      const found = x.instruments.find((i) => i.id === inst.id)?.fx;
      return found && { nodes: found.chain, gain: found.gain ?? 1, send: found.send ?? 0 };
    };
    level.chains.push({ chain, spec, out, send });
    level.fx.set(inst.id, chain?.input ?? out);
  }

  /** Moves the parameters of the built effects to the song's new values. */
  private updateParams(bus: Level, song: Song): void {
    const now = this.ctx.currentTime;
    bus.tail.gain.setTargetAtTime(song.reverb.return, now, 0.02);
    for (const ref of bus.chains) {
      const spec = ref.spec(song);
      if (!spec) continue;
      ref.chain?.built.forEach((b, i) => b.update(spec.nodes[ref.chain!.indices[i]], song.bpm));
      ref.out.gain.setTargetAtTime(spec.gain, now, 0.02);
      if (ref.send && spec.send !== undefined) ref.send.gain.setTargetAtTime(spec.send, now, 0.02);
    }
  }

  private send(level: Level, node: AudioNode, amount: number): GainNode {
    const wet = this.ctx.createGain();
    wet.gain.value = amount;
    node.connect(wet);
    wet.connect(level.wetBus);
    return wet;
  }

  private envelope(param: AudioParam, t: number, points: Point[], trig: Trigger): void {
    for (const p of points) {
      const dt = evaluate(p[0], trig);
      const value = evaluate(p[1], trig);
      const ramp = p[2] ?? "linear";
      if (dt === 0 || ramp === "hold") param.setValueAtTime(value, t + dt);
      else if (ramp === "exp") param.exponentialRampToValueAtTime(Math.max(value, MIN_EXP_TARGET), t + dt);
      else param.linearRampToValueAtTime(value, t + dt);
    }
  }

  private filter(t: number, f: { type?: FilterType; q?: number; freq?: number; envelope?: Point[] }, trig?: Trigger): BiquadFilterNode {
    const node = this.ctx.createBiquadFilter();
    node.type = f.type ?? "lowpass";
    if (f.q) node.Q.value = f.q;
    if (f.envelope && trig) this.envelope(node.frequency, t, f.envelope, trig);
    else if (f.freq) node.frequency.value = f.freq;
    return node;
  }

  private voice(t: number, l: VoiceLayer, trig: Trigger, instrument: string): void {
    const { ctx } = this;
    const level = this.getBus();
    const duration = evaluate(l.duration, trig);
    const pad = l.pad ?? 0.05;
    const gain = ctx.createGain();
    this.envelope(gain.gain, t, l.envelope, trig);
    gain.connect(level.fx.get(instrument) ?? ((l.out && level.buses.get(l.out)) || level.level));
    const wet = evaluate(l.wet, trig);
    if (wet) this.send(level, gain, wet);

    let target: AudioNode = gain;
    if (l.lfo) {
      const pulse = ctx.createGain();
      pulse.gain.value = l.lfo.base;
      const mod = ctx.createOscillator();
      mod.frequency.value = l.lfo.freq;
      const depth = ctx.createGain();
      depth.gain.value = l.lfo.depth;
      mod.connect(depth);
      depth.connect(pulse.gain);
      pulse.connect(gain);
      mod.start(t);
      mod.stop(t + duration + pad);
      target = pulse;
    }

    let chainInput: AudioNode = target;
    if (l.filter) {
      const node = this.filter(t, l.filter, trig);
      node.connect(target);
      chainInput = node;
    }
    if (l.shaper) {
      const drive = ctx.createWaveShaper();
      drive.curve = softClip(l.shaper === true ? 4 : l.shaper);
      drive.connect(chainInput);
      chainInput = drive;
    }

    for (const spec of l.voices) {
      const osc = ctx.createOscillator();
      if (spec.type) osc.type = spec.type;
      if (spec.pitch) this.envelope(osc.frequency, t, spec.pitch, trig);
      else osc.frequency.value = evaluate(spec.freq, trig);
      const detune = evaluate(spec.detune, trig);
      if (detune) osc.detune.value = detune;
      osc.connect(spec.direct ? target : chainInput);
      osc.start(t);
      osc.stop(t + duration + pad);
    }
  }

  private noiseHit(t: number, l: NoiseLayer, trig: Trigger, instrument: string): void {
    const { ctx } = this;
    const level = this.getBus();
    const length = evaluate(l.length, trig);
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filterNode = this.filter(t, { type: l.type, q: l.q, freq: l.freq, envelope: l.filterEnvelope }, trig);
    const gain = ctx.createGain();
    this.envelope(gain.gain, t, l.envelope ?? [[0, l.level ?? 0], [length, 0.001, "exp"]], trig);
    source.connect(filterNode);
    filterNode.connect(gain);
    gain.connect(level.fx.get(instrument) ?? level.level);
    const wet = evaluate(l.wet, trig);
    if (wet) this.send(level, gain, wet);
    source.start(t, l.offset === undefined ? Rand.float(0, 3) : evaluate(l.offset, trig));
    source.stop(t + length + (l.pad ?? 0.02));
  }

  private createNoise(): AudioBuffer {
    const { ctx } = this;
    const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Rand.float(-1, 1);
    return buffer;
  }

  private createImpulse(song: Song): AudioBuffer {
    const { ctx } = this;
    const key = `${song.reverb.seconds}:${song.reverb.power}`;
    if (this.impulse?.key === key) return this.impulse.buffer;
    const length = Math.round(ctx.sampleRate * song.reverb.seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] = Rand.float(-1, 1) * (1 - i / length) ** song.reverb.power;
    }
    this.impulse = { key, buffer: impulse };
    return impulse;
  }
}
