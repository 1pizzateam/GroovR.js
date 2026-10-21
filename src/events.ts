import type { Pattern, Song } from "./song.js";

export interface NoteEvent {
  // Beats from song start
  time: number;
  duration: number;
  pitch: number;
  velocity: number;
  track: number;
}

/** A time-sorted note list that plays once, then repeats `loopEvents` every `span` beats. */
export interface Stream {
  events: NoteEvent[];
  loopEvents: NoteEvent[];
  span: number;
  // Length of the first pass in beats
  length: number;
}

export interface Timeline {
  main: Stream;
  // One stream per track with its own period
  periodic: Stream[];
}

const byTime = (a: NoteEvent, b: NoteEvent) => a.time - b.time;

/** Flattens tracks, clips and patterns into streams of notes. */
export function buildTimeline(song: Song, includeMuted = false): Timeline {
  const patterns = new Map<string, Pattern>();
  for (const p of song.patterns) patterns.set(p.id, p);
  const hasSolo = !includeMuted && song.tracks.some((t) => t.solo);
  const mainEvents: NoteEvent[] = [];
  const periodic: Stream[] = [];
  let length = 0;
  for (let track = 0; track < song.tracks.length; track++) {
    const t = song.tracks[track];
    const audible = includeMuted || (!t.mute && (!hasSolo || Boolean(t.solo)));
    const target = t.period ? [] : mainEvents;
    let end = 0;
    for (const c of t.clips) {
      const p = patterns.get(c.pattern);
      if (!p) continue;
      end = Math.max(end, c.start + p.length);
      if (audible)
        for (const n of p.notes) target.push({ time: c.start + n.time, duration: n.duration, pitch: n.pitch, velocity: n.velocity, track });
    }
    if (!t.period) length = Math.max(length, end);
    else if (audible) {
      target.sort(byTime);
      periodic.push({ events: target, loopEvents: target, span: t.period, length: t.period });
    }
  }
  mainEvents.sort(byTime);
  const loopStart = Math.min(song.loopStart ?? 0, length);
  let firstLoopIdx = 0;
  while (firstLoopIdx < mainEvents.length && mainEvents[firstLoopIdx].time < loopStart) firstLoopIdx++;
  const loopEvents = firstLoopIdx === 0 ? mainEvents : mainEvents.slice(firstLoopIdx);
  return {
    main: { events: mainEvents, loopEvents, span: length - loopStart, length },
    periodic,
  };
}

export function midiToFrequency(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

export function frequencyToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}
