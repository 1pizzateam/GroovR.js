import { Utils } from "@1pizzateam/spock";
import type { Of, Spec, Stage } from "../effects.js";

const curves = new Map<number, Float32Array<ArrayBuffer>>();

/** The soft-clipping curve tanh(hardness * x), shared by every distortion, voice shaper and amp. */
export function softClip(hardness: number): Float32Array<ArrayBuffer> {
  let curve = curves.get(hardness);
  if (!curve) {
    curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) curve[i] = Math.tanh(Utils.map(i, 0, 255, -1, 1) * hardness);
    curves.set(hardness, curve);
  }
  return curve;
}

/** Whether a distortion needs a low-pass or a dry path of its own, which decides what gets built. */
export const distortionShape = (n: Of<"distortion">) => `${(n.tone ?? 6000) > 0}:${(n.mix ?? 1) < 1}:${n.oversample ?? "4x"}`;

export function buildDistortion(stage: Stage, n: Of<"distortion">): Spec<"distortion"> {
  const { ctx } = stage;
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
  const w = (n.mix ?? 1) < 1 ? stage.dryWet() : null;
  if (w) {
    w.input.connect(pre);
    post.connect(w.wet);
  }
  return {
    input: w?.input ?? pre,
    output: w?.output ?? post,
    apply(x) {
      stage.set(pre.gain, Utils.clamp(x.drive ?? 8, 0.1, 100));
      shaper.curve = softClip(Utils.clamp(x.hardness ?? 2, 0.1, 20));
      if (tone) stage.set(tone.frequency, x.tone ?? 6000);
      stage.set(post.gain, x.level ?? 0.6);
      w?.mix(x.mix ?? 1);
    },
  };
}
