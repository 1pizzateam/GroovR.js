import type { Song } from "./song.js";

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
export function buildTimeline(song: Song): Timeline {
  const patterns = new Map(song.patterns.map((p) => [p.id, p]));
  const mainEvents: NoteEvent[] = [];
  const periodic: Stream[] = [];
  let length = 0;
  song.tracks.forEach((t, track) => {
    const events: NoteEvent[] = [];
    let end = 0;
    for (const c of t.clips) {
      const p = patterns.get(c.pattern);
      if (!p) continue;
      end = Math.max(end, c.start + p.length);
      for (const n of p.notes) events.push({ time: c.start + n.time, duration: n.duration, pitch: n.pitch, velocity: n.velocity, track });
    }
    events.sort(byTime);
    if (t.period) periodic.push({ events, loopEvents: events, span: t.period, length: t.period });
    else {
      length = Math.max(length, end);
      mainEvents.push(...events);
    }
  });
  mainEvents.sort(byTime);
  const loopStart = Math.min(song.loopStart ?? 0, length);
  return {
    main: { events: mainEvents, loopEvents: mainEvents.filter((e) => e.time >= loopStart), span: length - loopStart, length },
    periodic,
  };
}

export function midiToFrequency(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

export function frequencyToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}
