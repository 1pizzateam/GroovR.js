import { Time, Utils } from "@1pizzateam/spock";
import type { Spec, Stage } from "../effects.js";

export function buildChorus(stage: Stage): Spec<"chorus"> {
  const { ctx } = stage;
  const w = stage.dryWet();
  const osc = stage.lfo();
  const left = ctx.createDelay(0.1);
  const right = ctx.createDelay(0.1);
  const depthL = ctx.createGain();
  const depthR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  osc.connect(depthL);
  osc.connect(depthR);
  depthL.connect(left.delayTime);
  depthR.connect(right.delayTime);
  w.input.connect(left);
  w.input.connect(right);
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  merger.connect(w.wet);
  return {
    input: w.input,
    output: w.output,
    apply(x) {
      const baseMs = Utils.clamp(x.delay ?? 15, 1, 80);
      const base = Time.millisecToSec(baseMs);
      const depth = Time.millisecToSec(Utils.clamp(x.depth ?? 4, 0, baseMs));
      stage.set(left.delayTime, base);
      stage.set(right.delayTime, base);
      stage.set(depthL.gain, depth);
      stage.set(depthR.gain, -depth);
      stage.set(osc.frequency, x.rate ?? 0.8);
      w.mix(x.mix ?? 0.5);
    },
    dispose: () => osc.stop(),
  };
}
