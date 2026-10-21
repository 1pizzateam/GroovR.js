import { Utils } from "@1pizzateam/spock";
import type { Spec, Stage } from "../effects.js";

export function buildTremolo(stage: Stage): Spec<"tremolo"> {
  const { ctx } = stage;
  const g = ctx.createGain();
  const osc = stage.lfo();
  const depth = ctx.createGain();
  osc.connect(depth);
  depth.connect(g.gain);
  return {
    input: g,
    output: g,
    apply(x) {
      const d = Utils.clamp(x.depth ?? 0.5, 0, 1);
      stage.set(g.gain, 1 - d / 2);
      stage.set(depth.gain, d / 2);
      stage.set(osc.frequency, x.rate ?? 5);
    },
    dispose: () => osc.stop(),
  };
}
