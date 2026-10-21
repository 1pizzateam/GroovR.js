import { Utils } from "@1pizzateam/spock";
import type { Spec, Stage } from "../effects.js";

export function buildCompressor(stage: Stage): Spec<"compressor"> {
  const { ctx } = stage;
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  comp.connect(makeup);
  return {
    input: comp,
    output: makeup,
    apply(x) {
      stage.set(comp.threshold, x.threshold ?? -24);
      stage.set(comp.ratio, Utils.clamp(x.ratio ?? 4, 1, 20));
      stage.set(comp.attack, x.attack ?? 0.01);
      stage.set(comp.release, x.release ?? 0.2);
      stage.set(comp.knee, x.knee ?? 12);
      stage.set(makeup.gain, x.makeup ?? 1);
    },
  };
}
