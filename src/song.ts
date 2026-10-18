export const SONG_FORMAT = "groovr-song";
export const SONG_VERSION = 2;

export type Waveform = "sine" | "square" | "sawtooth" | "triangle";
export type FilterType = "lowpass" | "highpass" | "bandpass";
export type Ramp = "linear" | "exp" | "hold";
export type Oversample = "none" | "2x" | "4x";

/**
 * A number, or a linear combination evaluated each time a note is triggered:
 * b + f*frequency(Hz) + d*duration(s) + v*velocity + r*R1 + r2*R2 + r3*R3, optionally capped by max.
 * R1..R3 are uniform random numbers in [0, 1) drawn once per layer trigger.
 */
export type Expr = number | { b?: number; f?: number; d?: number; v?: number; r?: number; r2?: number; r3?: number; max?: number };

/** [time in seconds from the note start, value, ramp]. The first point (or a 'hold') sets the value instantly. */
export type Point = [Expr, Expr] | [Expr, Expr, Ramp];

export interface Osc {
  type?: Waveform;
  // Frequency in Hz
  freq?: Expr;
  // Frequency envelope in Hz, replacing freq
  pitch?: Point[];
  // Cents
  detune?: Expr;
  // Skip the layer's filter and soft clip
  direct?: boolean;
}

export interface Filter {
  type?: FilterType;
  q?: number;
  freq?: number;
  envelope?: Point[];
}

export interface Lfo {
  freq: number;
  base: number;
  depth: number;
}

export interface Vibrato {
  rate: number;
  depth: number;
}

export interface VoiceLayer {
  kind: "voice";
  duration: Expr;
  pad?: number;
  // Reverb send amount
  wet?: Expr;
  // Name of a song bus, the dry level bus when omitted
  out?: string;
  // Soft clipping of the voices, as the hardness of the curve (tanh of hardness times the signal). true means 4
  shaper?: boolean | number;
  lfo?: Lfo;
  vibrato?: Vibrato;
  // Overrides the note velocity inside this layer's expressions
  velocity?: Expr;
  envelope: Point[];
  filter?: Filter;
  voices: Osc[];
}

export interface NoiseLayer {
  kind: "noise";
  type: FilterType;
  q?: number;
  freq?: number;
  filterEnvelope?: Point[];
  // Defaults to [[0, level], [length, 0.001, "exp"]]
  envelope?: Point[];
  length: Expr;
  level?: Expr;
  wet?: Expr;
  // Start offset in the noise buffer, in seconds
  offset?: Expr;
  pad?: number;
  velocity?: Expr;
}

export type Layer = VoiceLayer | NoiseLayer;

/** Editor state of an instrument's control rack. The engine ignores it. */
export interface RackState {
  // Template the knobs come from; "custom" templates carry their own base patch
  template: string;
  // Knob and selector button values by control id
  values: Record<string, number | string>;
  // Patch the knobs are applied to, for custom templates
  base?: Layer[];
}

export interface Instrument {
  id: string;
  layers: Layer[];
  // Effects every layer of the instrument goes through
  fx?: Fx;
  rack?: RackState;
}

/** Any effect can be skipped without removing it. */
interface Bypassable {
  bypass?: boolean;
}

export type EffectNode = Bypassable &
  (
    | { kind: "gain"; value: number }
    | { kind: "filter"; type: FilterType; q?: number; freq: number }
    //Echo. time is in beats, so it follows the tempo
    | { kind: "delay"; time?: number; feedback?: number; tone?: number; mix?: number }
    // Convolution reverb with its own impulse response and high-frequency damping
    | { kind: "reverb"; seconds?: number; power?: number; tone?: number; mix?: number }
    // Soft clipping: the signal is multiplied by drive, then bent by tanh(hardness * x). tone is a low-pass in Hz, 0 for none
    | { kind: "distortion"; drive?: number; hardness?: number; tone?: number; level?: number; mix?: number; oversample?: Oversample }
    // Stereo chorus. delay and depth are in milliseconds
    | { kind: "chorus"; rate?: number; delay?: number; depth?: number; mix?: number }
    | { kind: "phaser"; rate?: number; freq?: number; depth?: number; feedback?: number; mix?: number }
    | { kind: "tremolo"; rate?: number; depth?: number }
    | { kind: "vibrato"; rate?: number; depth?: number }
    | { kind: "compressor"; threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number }
    // Three bands: low shelf, mid bell and high shelf, gains in dB
    | { kind: "eq"; low?: number; mid?: number; high?: number; lowFreq?: number; midFreq?: number; highFreq?: number; q?: number }
    // pan from -1 to 1, width from 0 (mono) to 2
    | { kind: "stereo"; pan?: number; width?: number }
  );

/** @deprecated The bus chain accepts every effect. */
export type BusNode = EffectNode;

/** A processing chain feeding the dry level bus, with its own reverb send. */
export interface Bus {
  id: string;
  chain: EffectNode[];
  gain: number;
  wet: number;
}

/** An effects chain, used on one instrument or on the whole mix. */
export interface Fx {
  chain: EffectNode[];
  // Output gain, 1 when omitted
  gain?: number;
  // Reverb send from the end of the chain
  send?: number;
  // Bus the chain feeds instead of the level bus, such as the guitar amp
  out?: string;
}

export interface Reverb {
  // Impulse response length in seconds
  seconds: number;
  // Decay curve exponent
  power: number;
  // Level of the reverb on the mix, 1 for the sends as they are
  return: number;
}

export interface Note {
  // Position in beats from the pattern start
  time: number;
  // Length in beats
  duration: number;
  // MIDI note number, fractional for microtones (69 = A4 = 440 Hz)
  pitch: number;
  velocity: number;
}

export interface Pattern {
  id: string;
  // Length in beats
  length: number;
  notes: Note[];
}

export interface Clip {
  pattern: string;
  // Start in beats from the song start
  start: number;
}

export interface Track {
  id: string;
  instrument: string;
  // When set, the track repeats on its own every `period` beats, independent of the song loop
  period?: number;
  mute?: boolean;
  solo?: boolean;
  clips: Clip[];
}

export interface Song {
  format: typeof SONG_FORMAT;
  version: number;
  name: string;
  bpm: number;
  loop: boolean;
  // Beat the loop returns to, 0 when omitted
  loopStart?: number;
  // Gain of the song's dry bus
  level: number;
  reverb: Reverb;
  // Effects on the whole mix, reverb tail included
  master?: Fx;
  buses: Bus[];
  instruments: Instrument[];
  patterns: Pattern[];
  tracks: Track[];
}
