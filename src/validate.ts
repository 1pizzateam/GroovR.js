import { SONG_FORMAT, SONG_VERSION } from "./song.js";
import type { Song } from "./song.js";

const WAVES = new Set<unknown>(["sine", "square", "sawtooth", "triangle"]);
const FILTERS = new Set<unknown>(["lowpass", "highpass", "bandpass"]);
const RAMPS = new Set<unknown>(["linear", "exp", "hold"]);
const OVERSAMPLES = new Set<unknown>(["none", "2x", "4x"]);
const LFO_TARGETS = new Set<unknown>(["pitch", "cutoff", "amp"]);
// The optional numeric parameters of each effect
const EFFECT_PARAMS: Record<string, readonly string[]> = {
  gain: ["value"],
  filter: ["freq", "q"],
  delay: ["time", "feedback", "tone", "mix"],
  reverb: ["seconds", "power", "tone", "mix"],
  distortion: ["drive", "hardness", "tone", "level", "mix"],
  chorus: ["rate", "delay", "depth", "mix"],
  phaser: ["rate", "freq", "depth", "feedback", "mix"],
  tremolo: ["rate", "depth"],
  vibrato: ["rate", "depth"],
  compressor: ["threshold", "ratio", "attack", "release", "knee", "makeup"],
  eq: ["low", "mid", "high", "lowFreq", "midFreq", "highFreq", "q"],
  stereo: ["pan", "width"],
};
const EXPR_KEYS = new Set<string>(["b", "f", "d", "v", "r", "r2", "r3", "max"]);

type UnknownRecord = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is UnknownRecord => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function isExpr(v: unknown): boolean {
  if (isNum(v)) return true;
  if (!isRecord(v)) return false;
  for (const k in v) if (!EXPR_KEYS.has(k) || !isNum(v[k])) return false;
  return true;
}

function isPoints(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((p) => Array.isArray(p) && isExpr(p[0]) && isExpr(p[1]) && (p[2] === undefined || RAMPS.has(p[2])))
  );
}

function isAdsr(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    isExpr(v.attack) &&
    isExpr(v.decay) &&
    isExpr(v.sustain) &&
    isExpr(v.release) &&
    (v.amount === undefined || isExpr(v.amount))
  );
}

function isModLfos(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        isRecord(x) &&
        isNum(x.rate) &&
        isNum(x.depth) &&
        (x.type === undefined || WAVES.has(x.type)) &&
        (x.target === undefined || LFO_TARGETS.has(x.target)),
    )
  );
}

function isRackValues(v: unknown): boolean {
  if (!isRecord(v)) return false;
  for (const k in v) if (!isNum(v[k]) && typeof v[k] !== "string") return false;
  return true;
}

function checkEffects(chain: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(chain)) return void errors.push(`${where}: chain must be an array`);
  for (const raw of chain) {
    const n = raw as UnknownRecord | null | undefined;
    const kind = typeof n?.kind === "string" ? n.kind : "";
    const params = EFFECT_PARAMS[kind];
    if (!params || !n) errors.push(`${where}: unknown effect ${n?.kind}`);
    else if (!params.every((k) => n[k] === undefined || isNum(n[k]))) errors.push(`${where}: invalid ${kind} parameter`);
    else if (kind === "gain" && !isNum(n.value)) errors.push(`${where}: gain needs a value`);
    else if (kind === "filter" && (!FILTERS.has(n.type) || !isNum(n.freq))) errors.push(`${where}: invalid filter`);
    if (kind === "distortion" && n?.oversample !== undefined && !OVERSAMPLES.has(n.oversample)) errors.push(`${where}: invalid oversample`);
    if (n?.bypass !== undefined && typeof n.bypass !== "boolean") errors.push(`${where}: bypass must be true or false`);
  }
}

function checkFx(fx: unknown, where: string, buses: Set<string>, errors: string[]): void {
  if (!isRecord(fx)) return void errors.push(`${where}: fx must be an object`);
  checkEffects(fx.chain, where, errors);
  if (fx.gain !== undefined && !isNum(fx.gain)) errors.push(`${where}: invalid gain`);
  if (fx.send !== undefined && !isNum(fx.send)) errors.push(`${where}: invalid send`);
  if (fx.out !== undefined && (typeof fx.out !== "string" || !buses.has(fx.out))) errors.push(`${where}: unknown bus ${fx.out}`);
}

function checkLayer(l: unknown, where: string, errors: string[]): void {
  if (!isRecord(l)) return void errors.push(`${where}: kind must be "voice" or "noise"`);
  if (l.kind === "voice") {
    if (!isExpr(l.duration)) errors.push(`${where}: invalid duration`);
    if (l.shaper !== undefined && typeof l.shaper !== "boolean" && !isNum(l.shaper)) errors.push(`${where}: shaper must be true or a hardness`);
    const vib = l.vibrato as UnknownRecord | undefined;
    if (vib !== undefined && (!isNum(vib?.rate) || !isNum(vib?.depth))) errors.push(`${where}: invalid vibrato`);
    if (l.lfos !== undefined && !isModLfos(l.lfos)) errors.push(`${where}: invalid lfos`);
    if (l.adsr !== undefined ? !isAdsr(l.adsr) : !isPoints(l.envelope)) errors.push(`${where}: invalid envelope`);
    const filter = l.filter as UnknownRecord | undefined;
    if (filter?.type !== undefined && !FILTERS.has(filter.type)) errors.push(`${where}: invalid filter type`);
    if (filter?.envelope !== undefined && !isPoints(filter.envelope)) errors.push(`${where}: invalid filter envelope`);
    if (filter?.adsr !== undefined && !isAdsr(filter.adsr)) errors.push(`${where}: invalid filter adsr`);
    if (!Array.isArray(l.voices) || l.voices.length === 0) errors.push(`${where}: voices required`);
    else
      for (const raw of l.voices) {
        const o = raw as UnknownRecord;
        if (o.type !== undefined && !WAVES.has(o.type)) errors.push(`${where}: invalid wave`);
        if (o.pitch !== undefined ? !isPoints(o.pitch) : !isExpr(o.freq)) errors.push(`${where}: voice needs freq or pitch`);
        if (o.detune !== undefined && !isExpr(o.detune)) errors.push(`${where}: invalid detune`);
        if (o.gain !== undefined && !isExpr(o.gain)) errors.push(`${where}: invalid voice gain`);
      }
  } else if (l.kind === "noise") {
    if (!FILTERS.has(l.type)) errors.push(`${where}: invalid filter type`);
    if (!isExpr(l.length)) errors.push(`${where}: invalid length`);
    if (l.envelope !== undefined && !isPoints(l.envelope)) errors.push(`${where}: invalid envelope`);
    if (l.filterEnvelope !== undefined && !isPoints(l.filterEnvelope)) errors.push(`${where}: invalid filter envelope`);
  } else errors.push(`${where}: kind must be "voice" or "noise"`);
}

/** Returns a list of problems; an empty list means the song is valid. */
export function validateSong(data: unknown): string[] {
  const errors: string[] = [];
  const s = data as Partial<Song> | null;
  if (!s || typeof s !== "object") return ["song must be an object"];
  if (s.format !== SONG_FORMAT) errors.push(`format must be "${SONG_FORMAT}"`);
  if (s.version !== SONG_VERSION) errors.push(`unsupported version ${s.version}`);
  if (!isNum(s.bpm) || s.bpm <= 0) errors.push("bpm must be a positive number");
  if (!isNum(s.level)) errors.push("level must be a number");
  if (!s.reverb || !isNum(s.reverb.seconds) || !isNum(s.reverb.power) || !isNum(s.reverb.return)) errors.push("invalid reverb");
  if (s.loopStart !== undefined && (!isNum(s.loopStart) || s.loopStart < 0)) errors.push("invalid loopStart");
  if (!Array.isArray(s.buses) || !Array.isArray(s.instruments) || !Array.isArray(s.patterns) || !Array.isArray(s.tracks)) {
    errors.push("buses, instruments, patterns and tracks must be arrays");
    return errors;
  }

  const buses = new Set<string>();
  for (const b of s.buses) {
    buses.add(b.id);
    if (!isNum(b.gain) || !isNum(b.wet)) errors.push(`bus ${b.id}: invalid`);
    checkEffects(b.chain, `bus ${b.id}`, errors);
  }

  if (s.master !== undefined) checkFx(s.master, "master", buses, errors);

  const instruments = new Set<string>();
  for (const i of s.instruments) {
    instruments.add(i.id);
    if (i.fx !== undefined) checkFx(i.fx, `instrument ${i.id} fx`, buses, errors);
    if (i.rack !== undefined && (typeof i.rack.template !== "string" || !isRackValues(i.rack.values)))
      errors.push(`instrument ${i.id}: invalid rack`);
    if (!Array.isArray(i.layers) || i.layers.length === 0) errors.push(`instrument ${i.id}: layers required`);
    else
      for (let n = 0; n < i.layers.length; n++) {
        const l = i.layers[n];
        checkLayer(l, `instrument ${i.id} layer ${n}`, errors);
        if (l?.kind === "voice" && l.out !== undefined && !buses.has(l.out)) errors.push(`instrument ${i.id}: unknown bus ${l.out}`);
      }
  }

  const patterns = new Set<string>();
  for (const p of s.patterns) {
    patterns.add(p.id);
    if (!isNum(p.length) || p.length <= 0) errors.push(`pattern ${p.id}: invalid length`);
    if (Array.isArray(p.notes))
      for (const n of p.notes)
        if (!isNum(n.time) || !isNum(n.duration) || !isNum(n.pitch) || !isNum(n.velocity) || n.time < 0 || n.duration <= 0)
          errors.push(`pattern ${p.id}: invalid note`);
  }

  for (const t of s.tracks) {
    if (!instruments.has(t.instrument)) errors.push(`track ${t.id}: unknown instrument ${t.instrument}`);
    if (t.period !== undefined && (!isNum(t.period) || t.period <= 0)) errors.push(`track ${t.id}: invalid period`);
    if (t.mute !== undefined && typeof t.mute !== "boolean") errors.push(`track ${t.id}: mute must be true or false`);
    if (t.solo !== undefined && typeof t.solo !== "boolean") errors.push(`track ${t.id}: solo must be true or false`);
    if (Array.isArray(t.clips))
      for (const c of t.clips)
        if (!patterns.has(c.pattern) || !isNum(c.start) || c.start < 0) errors.push(`track ${t.id}: invalid clip`);
  }
  return errors;
}

function migrateChain(chain: unknown): void {
  if (!Array.isArray(chain)) return;
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i] as UnknownRecord | null | undefined;
    if (node?.kind === "shaper")
      chain[i] = { kind: "distortion", drive: 1, hardness: 4, oversample: "2x", tone: 0, level: 1, mix: 1, ...(node.bypass ? { bypass: true } : {}) };
  }
}

/**
 * Brings a song written before the soft clip became one parametric effect up to date: the fixed `shaper` node
 * becomes a distortion with the same curve, and the bare shaper flag a hardness. Returns the same object.
 */
export function migrateSong<T>(data: T): T {
  if (!isRecord(data)) return data;
  if (Array.isArray(data.buses))
    for (const b of data.buses) if (isRecord(b)) migrateChain(b.chain);
  if (isRecord(data.master)) migrateChain(data.master.chain);
  if (Array.isArray(data.instruments))
    for (const inst of data.instruments) {
      if (!isRecord(inst)) continue;
      if (isRecord(inst.fx)) migrateChain(inst.fx.chain);
      if (Array.isArray(inst.layers))
        for (const l of inst.layers) if (isRecord(l) && l.shaper === true) l.shaper = 4;
    }
  return data;
}

export function parseSong(json: string): Song {
  const data = migrateSong(JSON.parse(json));
  const errors = validateSong(data);
  if (errors.length) throw new Error(`Invalid song: ${errors.join("; ")}`);
  return data as Song;
}
