import { Utils } from "@1pizzateam/spock";
import type { Spec, Stage } from "../effects.js";

export function buildStereo(stage: Stage): Spec<"stereo"> {
  const { ctx } = stage;
  const panner = ctx.createStereoPanner();
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  // Width crossfades the channels: 1 leaves them alone, 0 makes mono, above 1 pushes them apart
  const s0 = ctx.createGain();
  const s1 = ctx.createGain();
  const a0 = ctx.createGain();
  const a1 = ctx.createGain();
  panner.connect(splitter);
  splitter.connect(s0, 0);
  splitter.connect(a0, 0);
  splitter.connect(a1, 1);
  splitter.connect(s1, 1);
  s0.connect(merger, 0, 0);
  a0.connect(merger, 0, 1);
  a1.connect(merger, 0, 0);
  s1.connect(merger, 0, 1);
  return {
    input: panner,
    output: merger,
    apply(x) {
      const w = Utils.clamp(x.width ?? 1, 0, 2);
      const straight = (1 + w) / 2;
      const across = (1 - w) / 2;
      stage.set(panner.pan, Utils.clampToExtent(x.pan ?? 0, 1));
      stage.set(s0.gain, straight);
      stage.set(s1.gain, straight);
      stage.set(a0.gain, across);
      stage.set(a1.gain, across);
    },
  };
}
