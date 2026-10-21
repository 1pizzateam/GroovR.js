import { Utils } from "@1pizzateam/spock";
import { buildChorus } from "./effects/chorus.js";
import { buildCompressor } from "./effects/compressor.js";
import { buildDelay } from "./effects/delay.js";
import { buildDistortion, distortionShape, softClip } from "./effects/distortion.js";
import { buildEq } from "./effects/eq.js";
import { buildFilter } from "./effects/filter.js";
import { buildGain } from "./effects/gain.js";
import { buildPhaser } from "./effects/phaser.js";
import { buildReverb, createImpulse, reverbShape } from "./effects/reverb.js";
import { buildStereo } from "./effects/stereo.js";
import { buildTremolo } from "./effects/tremolo.js";
import { buildVibrato } from "./effects/vibrato.js";
import type { EffectNode } from "./song.js";

export {
  buildChorus,
  buildCompressor,
  buildDelay,
  buildDistortion,
  buildEq,
  buildFilter,
  buildGain,
  buildPhaser,
  buildReverb,
  buildStereo,
  buildTremolo,
  buildVibrato,
  createImpulse,
  distortionShape,
  reverbShape,
  softClip,
};

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

export type Of<K extends EffectNode["kind"]> = Extract<EffectNode, { kind: K }>;

export interface DryWet {
  input: GainNode;
  output: GainNode;
  wet: GainNode;
  mix(amount: number): void;
}

export interface Stage {
  ctx: AudioContext;
  set(param: AudioParam, value: number): void;
  dryWet(): DryWet;
  lfo(): OscillatorNode;
  done(): void;
}

export interface Spec<K extends EffectNode["kind"]> {
  input: AudioNode;
  output: AudioNode;
  apply(node: Of<K>, bpm: number): void;
  dispose?(): void;
}

const SMOOTH = 0.02;
const noop = () => {};

/** A stage helper that sets parameters outright while building, then glides to them so knobs do not click. */
function createStage(ctx: AudioContext): Stage {
  let initial = true;
  const set = (param: AudioParam, value: number) => {
    if (initial) param.value = value;
    else param.setTargetAtTime(value, ctx.currentTime, SMOOTH);
  };
  return {
    ctx,
    set,
    done: () => (initial = false),
    dryWet() {
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
        mix(amount: number) {
          const m = Utils.clamp(amount, 0, 1);
          set(dry.gain, 1 - m);
          set(wet.gain, m);
        },
      };
    },
    lfo() {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.start();
      return osc;
    },
  };
}

function createSpec(stage: Stage, node: EffectNode) {
  switch (node.kind) {
    case "gain":
      return buildGain(stage);
    case "filter":
      return buildFilter(stage);
    case "delay":
      return buildDelay(stage);
    case "reverb":
      return buildReverb(stage, node);
    case "distortion":
      return buildDistortion(stage, node);
    case "chorus":
      return buildChorus(stage);
    case "phaser":
      return buildPhaser(stage);
    case "tremolo":
      return buildTremolo(stage);
    case "vibrato":
      return buildVibrato(stage);
    case "compressor":
      return buildCompressor(stage);
    case "eq":
      return buildEq(stage);
    case "stereo":
      return buildStereo(stage);
  }
}

export function buildEffect(env: FxEnv, node: EffectNode): Built {
  const stage = createStage(env.ctx);
  const spec = createSpec(stage, node);
  spec.apply(node as never, env.bpm);
  stage.done();
  return {
    input: spec.input,
    output: spec.output,
    update: (x, bpm) => spec.apply(x as never, bpm),
    dispose: spec.dispose ?? noop,
  };
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
  const indices: number[] = [];
  const built: Built[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].bypass) continue;
    const b = buildEffect(env, nodes[i]);
    if (built.length > 0) built[built.length - 1].output.connect(b.input);
    indices.push(i);
    built.push(b);
  }
  if (built.length === 0) return null;
  return {
    input: built[0].input,
    output: built[built.length - 1].output,
    built,
    indices,
    dispose() {
      for (const b of built) b.dispose();
    },
  };
}
