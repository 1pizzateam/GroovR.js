import { Trigo, Utils } from "@1pizzateam/spock";
import type { Spec, Stage } from "../effects.js";

export function buildVibrato(stage: Stage): Spec<"vibrato"> {
  const { ctx } = stage;
  const delay = ctx.createDelay(0.1);
  const osc = stage.lfo();
  const depth = ctx.createGain();
  osc.connect(depth);
  depth.connect(delay.delayTime);
  return {
    input: delay,
    output: delay,
    apply(x) {
      const rate = Utils.clamp(x.rate ?? 6, 0.1, 60);
      const hz = Utils.clamp(x.depth ?? 12, 0, 120);
      stage.set(delay.delayTime, 0.01);
      stage.set(osc.frequency, rate);
      stage.set(depth.gain, Utils.clamp(hz / (440 * Trigo.twopi * rate), 0, 0.009));
    },
    dispose: () => osc.stop(),
  };
}
