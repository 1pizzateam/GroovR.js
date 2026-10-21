import { Time } from "@1pizzateam/spock";
import { buildTimeline, midiToFrequency } from "./events.js";
import type { NoteEvent, Stream, Timeline } from "./events.js";
import { buildChain, createImpulse, distortionShape, reverbShape } from "./effects.js";
import type { Chain, FxEnv } from "./effects.js";
import { createNoise, playNote } from "./synth.js";
import type { SynthRouting, Trigger } from "./synth.js";
import type { Bus, EffectNode, Fx, Instrument, Song } from "./song.js";

const LOOKAHEAD = 3;
const INTERVAL_MS = 100;
const RELEASE_DELAY_MS = 30000;

// An effects chain as built, with what is needed to move its parameters later
interface ChainRef {
  chain: Chain | null;
  spec: (song: Song) => { nodes: EffectNode[]; gain: number; send?: number };
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
  gates: Map<string, { inst: string; node: GainNode }>;
  chains: ChainRef[];
}

const isActive = (nodes: EffectNode[]) => nodes.some((n) => !n.bypass);
const usesFx = (fx: Fx | undefined, master = false): fx is Fx =>
  !!fx && (isActive(fx.chain) || (fx.gain ?? 1) !== 1 || (!master && ((fx.send ?? 0) > 0 || Boolean(fx.out))));
const isVoiceFx = (inst: Instrument, n: EffectNode) =>
  inst.layers[0]?.kind === "voice" && (n.kind === "vibrato" || n.kind === "distortion");
const postFxNodes = (inst: Instrument, nodes: EffectNode[]) => nodes.filter((n) => !isVoiceFx(inst, n));
const usesPostFx = (inst: Instrument, fx: Fx | undefined): fx is Fx =>
  !!fx && (isActive(postFxNodes(inst, fx.chain)) || (fx.gain ?? 1) !== 1 || (fx.send ?? 0) > 0 || Boolean(fx.out));

/** What decides the shape of the audio graph: which effects exist, in what order and where they send. */
function structureKey(song: Song): string {
  const kinds = (nodes: EffectNode[]) =>
    nodes.map((n) =>
      n.bypass
        ? `-${n.kind}`
        : n.kind === "distortion"
          ? `distortion:${distortionShape(n)}`
          : n.kind === "reverb"
            ? `reverb:${reverbShape(n)}`
            : n.kind,
    );
  return JSON.stringify([
    [song.reverb.seconds, song.reverb.power],
    song.buses.map((b) => [b.id, kinds(b.chain)]),
    song.instruments.filter((i) => usesFx(i.fx)).map((i) => [i.id, kinds(i.fx!.chain), i.fx!.out ?? "", usesPostFx(i, i.fx)]),
    usesFx(song.master, true) ? kinds(song.master!.chain) : null,
  ]);
}

function isInstrumentAudible(song: Song, instrumentId: string): boolean {
  const hasSolo = song.tracks.some((t) => t.solo);
  let hasTrack = false;
  for (const t of song.tracks) {
    if (t.instrument !== instrumentId) continue;
    hasTrack = true;
    if (!t.mute && (!hasSolo || Boolean(t.solo))) return true;
  }
  return !hasTrack;
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
  private startOffset = 0;
  // Beat up to which notes were already handed to the audio clock
  private scheduledTo = 0;
  private impulse: { key: string; buffer: AudioBuffer } | null = null;
  private trig: Trigger = { f: 0, d: 0, v: 0, r: 0, r2: 0, r3: 0 };
  private routing: SynthRouting;

  constructor(ctx: AudioContext, song: Song, options: PlayerOptions = {}) {
    this.ctx = ctx;
    this.options = options;
    this.destination = options.destination ?? Player.createOutput(ctx, options.volume);
    this.noise = createNoise(ctx);
    this.routing = {
      bpm: song.bpm,
      noise: this.noise,
      route: (instId, out, gated) => {
        const level = this.getBus();
        const dest = level.fx.get(instId) ?? ((out && level.buses.get(out)) || level.level);
        return gated ? this.gate(level, instId, out ?? "", dest) : dest;
      },
      send: (node, amount, instId) => {
        this.send(this.getBus(), node, amount, instId);
      },
    };
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
    const beats = Math.max(this.startOffset, ((this.ctx.currentTime - this.startTime) * this.song.bpm) / 60);
    const { length, span } = this.timeline.main;
    if (!this.song.loop || span <= 0 || beats < length) return Math.max(0, beats);
    return length - span + ((beats - length) % span);
  }

  setSong(song: Song): void {
    this.song = song;
    this.routing.bpm = song.bpm;
    this.timeline = buildTimeline(song, true);
    this.instruments.clear();
    for (const i of song.instruments) this.instruments.set(i.id, i);
    const key = structureKey(song);
    // The buses only change with the mix settings, so editing notes or patches keeps the sounding notes on theirs
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
    if (inst) playNote(this.ctx, this.routing, inst, this.ctx.currentTime + 0.02, midiToFrequency(pitch), seconds, velocity, false, this.trig);
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

  /** Starts the song `delay` seconds from now, optionally starting at `offset` beats. */
  play(delay = 0.05, offset = 0): void {
    if (this.playing) return;
    this.startOffset = Math.max(0, offset);
    this.scheduledTo = this.startOffset;
    this.streams = this.seek(true);
    this.startTime = this.ctx.currentTime + delay - (this.startOffset * 60) / this.song.bpm;
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
      for (const g of bus.gates.values()) g.node.disconnect();
      for (const c of bus.chains) {
        c.chain?.dispose();
        c.out.disconnect();
        c.send?.disconnect();
      }
    }, Time.secToMillisec(fade) + 100));
  }

  // A replaced bus keeps sounding until its scheduled notes have died away
  private releaseLater(bus: Level): void {
    unref(setTimeout(() => this.release(bus, 0.25), RELEASE_DELAY_MS));
  }

  /** Streams positioned on the first note not yet scheduled, so an edited song carries on without repeating notes. */
  private seek(inclusive = false): StreamState[] {
    const at = this.scheduledTo;
    const result: StreamState[] = [this.seekStream(this.timeline.main, at, inclusive)];
    for (const s of this.timeline.periodic) result.push(this.seekStream(s, at, inclusive));
    return result;
  }

  private seekStream(stream: Stream, at: number, inclusive: boolean): StreamState {
    const state: StreamState = { stream, cursor: 0, pass: 0, done: false };
    if (at >= stream.length)
      if (!this.song.loop || stream.span <= 0) state.done = true;
      else state.pass = Math.floor((at - stream.length) / stream.span) + 1;
    const list = state.pass === 0 ? stream.events : stream.loopEvents;
    const offset = state.pass > 0 ? state.pass * stream.span : 0;
    while (state.cursor < list.length && at > 0) {
      const noteTime = list[state.cursor].time + offset;
      if (inclusive ? noteTime >= at : noteTime > at) break;
      state.cursor++;
    }
    return state;
  }

  private schedule(): void {
    const beat = 60 / this.song.bpm;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    this.scheduledTo = Math.max(this.scheduledTo, (horizon - this.startTime) / beat);
    for (const s of this.streams) this.pump(s, horizon, beat);
    const loops = this.song.loop && this.timeline.main.span > 0;
    const elapsed = (this.ctx.currentTime - this.startTime) / beat;
    if (!loops && this.streams.every((s) => s.done) && elapsed >= this.timeline.main.length && this.timer) {
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
    if (inst) playNote(this.ctx, this.routing, inst, when, midiToFrequency(e.pitch), e.duration * beat, e.velocity, true, this.trig);
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
      chains.push({ chain, spec: (x) => ({ nodes: x.master!.chain, gain: x.master!.gain ?? 1 }), out });
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
    const bus: Level = { level, wetBus, convolver, tail, buses: new Map(), fx: new Map(), gates: new Map(), chains };
    for (const b of song.buses) bus.buses.set(b.id, this.createBus(b, bus, env));
    for (const inst of song.instruments) if (usesPostFx(inst, inst.fx)) this.createInstrumentFx(inst, bus, env);
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
      const found = x.buses.find((y) => y.id === b.id)!;
      return { nodes: found.chain, gain: found.gain, send: found.wet };
    };
    level.chains.push({ chain, spec, out, send });
    return chain?.input ?? out;
  }

  /** Routes an instrument through its own effects chain, then on to the level bus or the bus it names. */
  private createInstrumentFx(inst: Instrument, level: Level, env: FxEnv): void {
    const fx = inst.fx!;
    const { ctx } = env;
    const chain = buildChain(env, postFxNodes(inst, fx.chain));
    const scale = isInstrumentAudible(this.song, inst.id) ? 1 : 0;
    const out = ctx.createGain();
    out.gain.value = (fx.gain ?? 1) * scale;
    if (chain) chain.output.connect(out);
    out.connect((fx.out && level.buses.get(fx.out)) || level.level);
    const send = this.send(level, out, (fx.send ?? 0) * scale);
    const spec = (x: Song) => {
      const foundInst = this.instruments.get(inst.id)!;
      const found = foundInst.fx!;
      const audible = isInstrumentAudible(x, inst.id) ? 1 : 0;
      return { nodes: postFxNodes(foundInst, found.chain), gain: (found.gain ?? 1) * audible, send: (found.send ?? 0) * audible };
    };
    level.chains.push({ chain, spec, out, send });
    level.fx.set(inst.id, chain?.input ?? out);
  }

  private gate(level: Level, instrument: string, key: string, target: AudioNode): AudioNode {
    const id = `${instrument}:${key}`;
    const existing = level.gates.get(id);
    if (existing) return existing.node;
    const node = this.ctx.createGain();
    node.gain.value = isInstrumentAudible(this.song, instrument) ? 1 : 0;
    node.connect(target);
    level.gates.set(id, { inst: instrument, node });
    return node;
  }

  /** Moves the parameters of the built effects to the song's new values. */
  private updateParams(bus: Level, song: Song): void {
    const now = this.ctx.currentTime;
    bus.tail.gain.setTargetAtTime(song.reverb.return, now, 0.02);
    for (const { inst, node } of bus.gates.values())
      node.gain.setTargetAtTime(isInstrumentAudible(song, inst) ? 1 : 0, now, 0.015);
    for (const ref of bus.chains) {
      const spec = ref.spec(song);
      if (ref.chain)
        for (let i = 0; i < ref.chain.built.length; i++)
          ref.chain.built[i].update(spec.nodes[ref.chain.indices[i]], song.bpm);
      ref.out.gain.setTargetAtTime(spec.gain, now, 0.02);
      if (ref.send && spec.send !== undefined) ref.send.gain.setTargetAtTime(spec.send, now, 0.02);
    }
  }

  private send(level: Level, node: AudioNode, amount: number, instrument?: string): GainNode {
    const wet = this.ctx.createGain();
    wet.gain.value = amount;
    node.connect(wet);
    wet.connect(instrument ? this.gate(level, instrument, "wet", level.wetBus) : level.wetBus);
    return wet;
  }

  private createImpulse(song: Song): AudioBuffer {
    const key = reverbShape(song.reverb);
    if (this.impulse?.key === key) return this.impulse.buffer;
    const buffer = createImpulse(this.ctx, song.reverb.seconds, song.reverb.power);
    this.impulse = { key, buffer };
    return buffer;
  }
}
