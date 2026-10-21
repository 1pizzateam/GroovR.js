import { Utils } from "@1pizzateam/spock";
import type { Spec, Stage } from "../effects.js";

export function buildPhaser(stage: Stage): Spec<"phaser"> {
  const { ctx } = stage;
  const w = stage.dryWet();
  const osc = stage.lfo();
  const sweep = ctx.createGain();
  osc.connect(sweep);
  const stages: BiquadFilterNode[] = [];
  for (let i = 0; i < 4; i++) {
    const f = ctx.createBiquadFilter();
    f.type = "allpass";
    f.Q.value = 0.7;
    sweep.connect(f.frequency);
    if (i > 0) stages[i - 1].connect(f);
    stages.push(f);
  }
  w.input.connect(stages[0]);
  stages[3].connect(w.wet);
  // A delay in the feedback path keeps the loop legal
  const loop = ctx.createDelay(0.01);
  loop.delayTime.value = 0.003;
  const feedback = ctx.createGain();
  stages[3].connect(loop);
  loop.connect(feedback);
  feedback.connect(stages[0]);
  return {
    input: w.input,
    output: w.output,
    apply(x) {
      const freq = Utils.clamp(x.freq ?? 800, 100, 8000);
      for (const f of stages) stage.set(f.frequency, freq);
      stage.set(sweep.gain, freq * Utils.clamp(x.depth ?? 0.7, 0, 1) * 0.9);
      stage.set(osc.frequency, x.rate ?? 0.4);
      stage.set(feedback.gain, Utils.clamp(x.feedback ?? 0.3, 0, 0.9));
      w.mix(x.mix ?? 0.5);
    },
    dispose: () => osc.stop(),
  };
}
