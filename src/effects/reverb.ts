import { Rand, Utils } from "@1pizzateam/spock";
import type { Of, Spec, Stage } from "../effects.js";

/** Impulse response parameters of a reverb effect, which decide when a new convolver buffer is needed. */
export const reverbShape = (n: { seconds?: number; power?: number }) => `${n.seconds ?? 1.8}:${n.power ?? 2.5}`;

/** Builds a stereo exponentially-decaying noise impulse response buffer. */
export function createImpulse(ctx: AudioContext, seconds: number, power: number): AudioBuffer {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = Rand.float(-1, 1) * (1 - i / length) ** power;
  }
  return impulse;
}

export function buildReverb(stage: Stage, n: Of<"reverb">): Spec<"reverb"> {
  const { ctx } = stage;
  const w = stage.dryWet();
  const convolver = ctx.createConvolver();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  convolver.buffer = createImpulse(ctx, Utils.clamp(n.seconds ?? 1.8, 0.1, 6), Utils.clamp(n.power ?? 2.5, 0.5, 6));
  w.input.connect(convolver);
  convolver.connect(tone);
  tone.connect(w.wet);
  return {
    input: w.input,
    output: w.output,
    apply(x) {
      stage.set(tone.frequency, Utils.clamp(x.tone ?? 4000, 200, 16000));
      w.mix(x.mix ?? 0.3);
    },
  };
}
