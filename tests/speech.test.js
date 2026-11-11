import { PHONEMES, VOICE_GENDERS, speak, textToPhonemes } from '../build/es6/groovr.js';

class Param {
  constructor() { this.calls = []; this.value = 0; }
  setValueAtTime(v, t) { this.calls.push(['set', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); }
}

function makeContext() {
  const ctx = { oscillators: [], filters: [], gains: [], shapers: [], sources: [], buffers: 0, sampleRate: 100 };
  const node = (extra = {}) => ({ edges: [], connect(n) { this.edges.push(n); return n; }, start(t, off) { this.started = t; this.offset = off; }, stop(t) { this.stopped = t; }, ...extra });
  ctx.destination = node();
  ctx.createGain = () => { const g = node({ gain: new Param() }); ctx.gains.push(g); return g; };
  ctx.createOscillator = () => { const o = node({ frequency: new Param(), type: 'sine' }); ctx.oscillators.push(o); return o; };
  ctx.createBiquadFilter = () => { const f = node({ frequency: new Param(), Q: new Param(), type: 'lowpass' }); ctx.filters.push(f); return f; };
  ctx.createWaveShaper = () => { const s = node({ curve: null }); ctx.shapers.push(s); return s; };
  ctx.createBufferSource = () => { const s = node({ buffer: null }); ctx.sources.push(s); return s; };
  ctx.createBuffer = (_c, length) => { ctx.buffers++; return { getChannelData: () => new Float32Array(length) }; };
  return ctx;
}

describe('speech', () => {
  it('converts lexicon words, phoneme arrays, digraphs, doubled consonants, and silent trailing e to phoneme codes', () => {
    expect(textToPhonemes('Welcome')).toEqual(['W', 'EH', 'L', 'K', 'AH', 'M']);
    expect(textToPhonemes('welcome, intruder alert!')).toEqual([
      'W', 'EH', 'L', 'K', 'AH', 'M', '_',
      'IH', 'N', 'T', 'R', 'UW', 'D', 'ER', '_',
      'AH', 'L', 'ER', 'T',
    ]);
    expect(textToPhonemes(['w', 'eh', 'invalid', 'm'])).toEqual(['W', 'EH', 'M']);
    expect(textToPhonemes('W _ M')).toEqual(['W', '_', 'M']);
    const g2p = textToPhonemes('e shote chatring quick bell fox jazz');
    expect(g2p).toEqual(expect.arrayContaining(['EH', 'SH', 'T', 'NG', 'K', 'W', 'L', 'F', 'S', 'Z']));
    expect(g2p.every((code) => code in PHONEMES)).toBe(true);
  });

  it('returns zero duration and builds no nodes for empty text', () => {
    const ctx = makeContext();
    const res = speak(ctx, ctx.destination, 1, '   ');
    expect(res).toEqual({ duration: 0, phonemes: [] });
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('synthesizes "welcome" with 3 parallel bandpass formant resonators, pitch step-down, and K stop burst', () => {
    const ctx = makeContext();
    const res = speak(ctx, ctx.destination, 2, 'welcome');
    expect(res.phonemes).toEqual(['W', 'EH', 'L', 'K', 'AH', 'M']);
    expect(res.duration).toBeCloseTo(0.71, 2);

    // 3 oscillators: sawtooth fundamental, square sub-octave, and sine vibrato LFO
    expect(ctx.oscillators.map((o) => o.type)).toEqual(['sawtooth', 'square', 'sine']);
    expect(ctx.shapers).toHaveLength(1);
    expect(ctx.shapers[0].curve).toBeInstanceOf(Float32Array);

    // 3 parallel formant bandpass filters + 1 bandpass filter for the unvoiced 'K' burst
    const formantFilters = ctx.filters.slice(0, 3);
    expect(formantFilters.every((f) => f.type === 'bandpass')).toBe(true);
    // F1 starts at W (300 Hz) and ramps to EH (530 Hz)
    expect(formantFilters[0].frequency.calls[0]).toEqual(['set', 300, 2]);
    expect(formantFilters[0].frequency.calls.some(([op, v]) => op === 'exp' && v === 530)).toBe(true);
    // Unvoiced 'K' creates 1 noise source and caches the noise buffer per AudioContext
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.buffers).toBe(1);

    // Second call on the same context reuses the cached noise buffer
    speak(ctx, ctx.destination, 4, 'welcome');
    expect(ctx.buffers).toBe(1);
  });

  it('scales vocal-tract formants, fundamental pitch, and sub-octave chest weight by gender preset', () => {
    const ctxMale = makeContext();
    const ctxFemale = makeContext();
    const ctxNeutral = makeContext();
    speak(ctxMale, ctxMale.destination, 0, 'welcome', { gender: 'male' });
    speak(ctxFemale, ctxFemale.destination, 0, 'welcome', { gender: 'female' });
    speak(ctxNeutral, ctxNeutral.destination, 0, 'welcome', { gender: 'neutral' });

    const maleF0 = ctxMale.oscillators[0].frequency.calls[0][1];
    const femaleF0 = ctxFemale.oscillators[0].frequency.calls[0][1];
    const neutralF0 = ctxNeutral.oscillators[0].frequency.calls[0][1];
    expect(femaleF0).toBeGreaterThan(neutralF0);
    expect(neutralF0).toBeGreaterThan(maleF0);

    // Female vocal tract shifts F1 and F2 higher than male vocal tract
    const maleF2 = ctxMale.filters[1].frequency.calls[0][1];
    const femaleF2 = ctxFemale.filters[1].frequency.calls[0][1];
    expect(femaleF2).toBeCloseTo(maleF2 * VOICE_GENDERS.female.formantScale[1], 4);
  });

  it('synthesizes "who are you ?" with legato voiced word liaison and a rising interrogative pitch contour', () => {
    const ctx = makeContext();
    const res = speak(ctx, ctx.destination, 0, 'who are you ?', { gender: 'female' });
    expect(res.phonemes).toEqual(['HH', 'UW', '_', 'AA', 'R', '_', 'Y', 'UW']);
    const f0Calls = ctx.oscillators[0].frequency.calls;
    const startF0 = f0Calls[0][1];
    const endF0 = f0Calls.at(-1)[1];
    expect(endF0).toBeGreaterThan(startF0);

    // Voicing gain stays active (0.72) across the "_" liaisons between voiced words
    const voicingCalls = ctx.gains[2].gain.calls;
    expect(voicingCalls.some(([op, v]) => op === 'exp' && v === 0.72)).toBe(true);

    // Also synthesizes "system failure in sector 3" and unvoiced boundaries ("alert welcome")
    const alertRes = speak(ctx, ctx.destination, 2, 'system failure in sector 3', { gender: 'female' });
    expect(alertRes.phonemes).toEqual([
      'S', 'IH', 'S', 'T', 'AH', 'M', '_',
      'F', 'EY', 'L', 'Y', 'ER', '_',
      'IH', 'N', '_',
      'S', 'EH', 'K', 'T', 'ER', '_',
      'TH', 'R', 'IY',
    ]);
    expect(textToPhonemes('I think you are going to die')).toEqual([
      'AA', 'IH', '_',
      'TH', 'IH', 'NG', 'K', '_',
      'Y', 'UW', '_',
      'AA', 'R', '_',
      'G', 'OW', 'IH', 'NG', '_',
      'T', 'UW', '_',
      'D', 'AA', 'IH',
    ]);
    speak(ctx, ctx.destination, 5, 'alert welcome');
  });

  it('supports custom pitch contour, custom noise buffer, and disabling drive and vibrato', () => {
    const ctx = makeContext();
    const customNoise = { getChannelData: () => new Float32Array(10) };
    const res = speak(ctx, ctx.destination, 0, ['S', 'AA'], {
      pitch: 100,
      speed: 2,
      gain: 0.4,
      drive: 0,
      vibratoRate: 0,
      vibratoDepth: 0,
      contour: [1.2],
      noise: customNoise,
    });
    expect(res.duration).toBeCloseTo((PHONEMES.S.d + PHONEMES.AA.d) / 2, 5);
    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.shapers).toHaveLength(0);
    expect(ctx.sources[0].buffer).toBe(customNoise);
    expect(ctx.oscillators[0].frequency.calls[0][1]).toBeCloseTo(120);
  });
});
