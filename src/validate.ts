import { SONG_FORMAT, SONG_VERSION } from "./song.js";
import type { Song } from "./song.js";

const WAVES = ["sine", "square", "sawtooth", "triangle"];
const FILTERS = ["lowpass", "highpass", "bandpass"];
const RAMPS = ["linear", "exp", "hold"];
// The optional numeric parameters of each effect
const EFFECT_PARAMS: Record<string, string[]> = {
  gain: ["value"],
  filter: ["freq", "q"],
  delay: ["time", "feedback", "tone", "mix"],
  distortion: ["drive", "hardness", "tone", "level", "mix"],
  chorus: ["rate", "delay", "depth", "mix"],
  phaser: ["rate", "freq", "depth", "feedback", "mix"],
  tremolo: ["rate", "depth"],
  compressor: ["threshold", "ratio", "attack", "release", "knee", "makeup"],
  eq: ["low", "mid", "high", "lowFreq", "midFreq", "highFreq", "q"],
  stereo: ["pan", "width"],
};
const EXPR_KEYS = ["b", "f", "d", "v", "r", "r2", "r3", "max"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isExpr(v: unknown): boolean {
  if (isNum(v)) return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.entries(v).every(([k, x]) => EXPR_KEYS.includes(k) && isNum(x));
}

function isPoints(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((p) => Array.isArray(p) && isExpr(p[0]) && isExpr(p[1]) && (p[2] === undefined || RAMPS.includes(p[2])))
  );
}

function checkEffects(chain: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(chain)) {
    errors.push(`${where}: chain must be an array`);
    return;
  }
  for (const n of chain) {
    const params = EFFECT_PARAMS[n?.kind];
    if (!params) errors.push(`${where}: unknown effect ${n?.kind}`);
    else if (!params.every((k) => n[k] === undefined || isNum(n[k]))) errors.push(`${where}: invalid ${n.kind} parameter`);
    else if (n.kind === "gain" && !isNum(n.value)) errors.push(`${where}: gain needs a value`);
    else if (n.kind === "filter" && (!FILTERS.includes(n.type) || !isNum(n.freq))) errors.push(`${where}: invalid filter`);
    if (n?.kind === "distortion" && n.oversample !== undefined && !["none", "2x", "4x"].includes(n.oversample)) errors.push(`${where}: invalid oversample`);
    if (n?.bypass !== undefined && typeof n.bypass !== "boolean") errors.push(`${where}: bypass must be true or false`);
  }
}

function checkFx(fx: any, where: string, buses: Set<string>, errors: string[]): void {
  if (!fx || typeof fx !== "object") return void errors.push(`${where}: fx must be an object`);
  checkEffects(fx.chain, where, errors);
  if (fx.gain !== undefined && !isNum(fx.gain)) errors.push(`${where}: invalid gain`);
  if (fx.send !== undefined && !isNum(fx.send)) errors.push(`${where}: invalid send`);
  if (fx.out !== undefined && !buses.has(fx.out)) errors.push(`${where}: unknown bus ${fx.out}`);
}

function checkLayer(l: any, where: string, errors: string[]): void {
  if (l?.kind === "voice") {
    if (!isExpr(l.duration)) errors.push(`${where}: invalid duration`);
    if (l.shaper !== undefined && typeof l.shaper !== "boolean" && !isNum(l.shaper)) errors.push(`${where}: shaper must be true or a hardness`);
    if (!isPoints(l.envelope)) errors.push(`${where}: invalid envelope`);
    if (l.filter?.type !== undefined && !FILTERS.includes(l.filter.type)) errors.push(`${where}: invalid filter type`);
    if (l.filter?.envelope !== undefined && !isPoints(l.filter.envelope)) errors.push(`${where}: invalid filter envelope`);
    if (!Array.isArray(l.voices) || l.voices.length === 0) errors.push(`${where}: voices required`);
    else
      for (const o of l.voices) {
        if (o.type !== undefined && !WAVES.includes(o.type)) errors.push(`${where}: invalid wave`);
        if (o.pitch !== undefined ? !isPoints(o.pitch) : !isExpr(o.freq)) errors.push(`${where}: voice needs freq or pitch`);
        if (o.detune !== undefined && !isExpr(o.detune)) errors.push(`${where}: invalid detune`);
      }
  } else if (l?.kind === "noise") {
    if (!FILTERS.includes(l.type)) errors.push(`${where}: invalid filter type`);
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
    if (i.rack !== undefined && (typeof i.rack.template !== "string" || !i.rack.values || !Object.values(i.rack.values).every(isNum)))
      errors.push(`instrument ${i.id}: invalid rack`);
    if (!Array.isArray(i.layers) || i.layers.length === 0) errors.push(`instrument ${i.id}: layers required`);
    else
      i.layers.forEach((l, n) => {
        checkLayer(l, `instrument ${i.id} layer ${n}`, errors);
        if (l?.kind === "voice" && l.out !== undefined && !buses.has(l.out)) errors.push(`instrument ${i.id}: unknown bus ${l.out}`);
      });
  }

  const patterns = new Set<string>();
  for (const p of s.patterns) {
    patterns.add(p.id);
    if (!isNum(p.length) || p.length <= 0) errors.push(`pattern ${p.id}: invalid length`);
    for (const n of p.notes ?? [])
      if (![n.time, n.duration, n.pitch, n.velocity].every(isNum) || n.time < 0 || n.duration <= 0)
        errors.push(`pattern ${p.id}: invalid note`);
  }

  for (const t of s.tracks) {
    if (!instruments.has(t.instrument)) errors.push(`track ${t.id}: unknown instrument ${t.instrument}`);
    if (t.period !== undefined && (!isNum(t.period) || t.period <= 0)) errors.push(`track ${t.id}: invalid period`);
    for (const c of t.clips ?? [])
      if (!patterns.has(c.pattern) || !isNum(c.start) || c.start < 0) errors.push(`track ${t.id}: invalid clip`);
  }
  return errors;
}

/**
 * Brings a song written before the soft clip became one parametric effect up to date: the fixed `shaper` node
 * becomes a distortion with the same curve, and the bare shaper flag a hardness. Returns the same object.
 */
export function migrateSong<T>(data: T): T {
  const song = data as any;
  const chains = [...(song?.buses ?? []).map((b: any) => b.chain), song?.master?.chain, ...(song?.instruments ?? []).map((i: any) => i.fx?.chain)];
  for (const chain of chains)
    if (Array.isArray(chain))
      chain.forEach((n: any, i: number) => {
        if (n?.kind === "shaper") chain[i] = { kind: "distortion", drive: 1, hardness: 4, oversample: "2x", tone: 0, level: 1, mix: 1, ...(n.bypass ? { bypass: true } : {}) };
      });
  for (const inst of song?.instruments ?? []) for (const l of inst?.layers ?? []) if (l?.shaper === true) l.shaper = 4;
  return data;
}

export function parseSong(json: string): Song {
  const data = migrateSong(JSON.parse(json));
  const errors = validateSong(data);
  if (errors.length) throw new Error(`Invalid song: ${errors.join("; ")}`);
  return data as Song;
}
