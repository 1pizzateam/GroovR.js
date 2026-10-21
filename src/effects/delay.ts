import { Utils } from "@1pizzateam/spock";
import type { Spec, Stage } from "../effects.js";

const MAX_DELAY = 4;

export function buildDelay(stage: Stage): Spec<"delay"> {
  const { ctx } = stage;
  const w = stage.dryWet();
  const delay = ctx.createDelay(MAX_DELAY);
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  const feedback = ctx.createGain();
  w.input.connect(delay);
  delay.connect(tone);
  tone.connect(feedback);
  feedback.connect(delay);
  tone.connect(w.wet);
  return {
    input: w.input,
    output: w.output,
    apply(x, bpm) {
      stage.set(delay.delayTime, Utils.clamp(((x.time ?? 0.5) * 60) / bpm, 0.001, MAX_DELAY));
      stage.set(feedback.gain, Utils.clamp(x.feedback ?? 0.35, 0, 0.95));
      stage.set(tone.frequency, x.tone ?? 4000);
      w.mix(x.mix ?? 0.3);
    },
  };
}
