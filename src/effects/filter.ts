import type { Spec, Stage } from "../effects.js";

export function buildFilter(stage: Stage): Spec<"filter"> {
  const f = stage.ctx.createBiquadFilter();
  return {
    input: f,
    output: f,
    apply(x) {
      f.type = x.type;
      if (x.q) stage.set(f.Q, x.q);
      stage.set(f.frequency, x.freq);
    },
  };
}
