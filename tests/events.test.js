import { buildTimeline, midiToFrequency, frequencyToMidi } from '../build/es6/events.js';

const note = (time) => ({ time, duration: 1, pitch: 60, velocity: 1 });

describe('buildTimeline', () => {
  const song = {
    loopStart: 4,
    patterns: [
      { id: 'p', length: 4, notes: [note(2), note(0)] },
      { id: 'drone', length: 2, notes: [note(1)] },
    ],
    tracks: [
      { id: 't', clips: [{ pattern: 'p', start: 0 }, { pattern: 'p', start: 4 }, { pattern: 'missing', start: 8 }] },
      { id: 'd', period: 5, clips: [{ pattern: 'drone', start: 0 }] },
    ],
  };

  it('flattens, offsets and sorts the main stream', () => {
    const { main } = buildTimeline(song);
    expect(main.events.map((e) => e.time)).toEqual([0, 2, 4, 6]);
    expect(main.length).toBe(8);
  });

  it('repeats from the loop start', () => {
    const { main } = buildTimeline(song);
    expect(main.loopEvents.map((e) => e.time)).toEqual([4, 6]);
    expect(main.span).toBe(4);
  });

  it('gives a track with a period its own stream', () => {
    const { periodic, main } = buildTimeline(song);
    expect(periodic).toHaveLength(1);
    expect(periodic[0].span).toBe(5);
    expect(main.events.every((e) => e.track === 0)).toBe(true);
  });

  it('loops from the start by default', () => {
    const { main } = buildTimeline({ ...song, loopStart: undefined });
    expect(main.span).toBe(8);
  });

  it('mutes and solos tracks while preserving song length', () => {
    const muted = buildTimeline({
      ...song,
      tracks: [
        { ...song.tracks[0], mute: true },
        { ...song.tracks[1], mute: true },
      ],
    });
    expect(muted.main.events).toEqual([]);
    expect(muted.main.length).toBe(8);
    expect(muted.periodic).toEqual([]);

    const soloed = buildTimeline({
      ...song,
      tracks: [
        { ...song.tracks[0] },
        { ...song.tracks[1], solo: true },
      ],
    });
    expect(soloed.main.events).toEqual([]);
    expect(soloed.main.length).toBe(8);
    expect(soloed.periodic).toHaveLength(1);
  });
});

describe('pitch conversion', () => {
  it('maps A4 to 440 and A5 to 880', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToFrequency(81)).toBeCloseTo(880);
  });

  it('round-trips microtonal frequencies', () => {
    expect(midiToFrequency(frequencyToMidi(36.71))).toBeCloseTo(36.71, 10);
  });
});
