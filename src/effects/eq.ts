import type { Spec, Stage } from "../effects.js";

export function buildEq(stage: Stage): Spec<"eq"> {
  const { ctx } = stage;
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  low.connect(mid);
  mid.connect(high);
  return {
    input: low,
    output: high,
    apply(x) {
      stage.set(low.frequency, x.lowFreq ?? 200);
      stage.set(low.gain, x.low ?? 0);
      stage.set(mid.frequency, x.midFreq ?? 1000);
      stage.set(mid.gain, x.mid ?? 0);
      stage.set(mid.Q, x.q ?? 0.8);
      stage.set(high.frequency, x.highFreq ?? 4000);
      stage.set(high.gain, x.high ?? 0);
    },
  };
}
