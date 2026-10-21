import type { Spec, Stage } from "../effects.js";

export function buildGain(stage: Stage): Spec<"gain"> {
  const g = stage.ctx.createGain();
  return {
    input: g,
    output: g,
    apply: (x) => stage.set(g.gain, x.value),
  };
}
