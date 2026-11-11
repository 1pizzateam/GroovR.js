import { Rand, Utils } from "@1pizzateam/spock";
import { softClip } from "./effects.js";
import { createNoise } from "./synth.js";

const MIN_EXP = 0.0001;
// Compensates narrowband insertion loss of the 3 parallel bandpass resonators
const FORMANT_BOOST = 1.5;
const noiseCache = new WeakMap<AudioContext, AudioBuffer>();

export type VoiceGender = "male" | "female" | "neutral";

export interface VoiceGenderPreset {
	/** Default fundamental frequency (F0) in Hz */
	pitch: number;
	/** Vocal-tract formant multipliers [F1, F2, F3] */
	formantScale: readonly [number, number, number];
	/** Resonance Q multiplier (lower for higher-pitched voices so harmonics excite formants evenly) */
	qScale: number;
	/** Consonant noise frequency multiplier */
	noiseScale: number;
	/** Sub-octave chest oscillator level */
	subGain: number;
	/** Default vocal-cord waveshaper hardness */
	drive: number;
	/** Default pitch modulation rate in Hz */
	vibratoRate: number;
	/** Default pitch modulation depth in Hz */
	vibratoDepth: number;
}

export const VOICE_GENDERS: Readonly<Record<VoiceGender, VoiceGenderPreset>> = {
	male: {
		pitch: 110,
		formantScale: [1, 1, 1],
		qScale: 1,
		noiseScale: 1,
		subGain: 0.48,
		drive: 4,
		vibratoRate: 26,
		vibratoDepth: 2.2,
	},
	female: {
		pitch: 210,
		formantScale: [1.16, 1.18, 1.15],
		qScale: 0.8,
		noiseScale: 1.12,
		subGain: 0.16,
		drive: 2.8,
		vibratoRate: 6.5,
		vibratoDepth: 3.2,
	},
	neutral: {
		pitch: 155,
		formantScale: [1.08, 1.09, 1.07],
		qScale: 0.9,
		noiseScale: 1.06,
		subGain: 0.3,
		drive: 3.4,
		vibratoRate: 18,
		vibratoDepth: 2.5,
	},
};

export interface PhonemeSpec {
	/** Formant center frequencies [F1, F2, F3] in Hz */
	f: readonly [number, number, number];
	/** Formant resonance Q factors [Q1, Q2, Q3] */
	q: readonly [number, number, number];
	/** Formant relative gains [G1, G2, G3] */
	g: readonly [number, number, number];
	/** Default duration in seconds at speed = 1 */
	d: number;
	/** Voiced excitation level in [0, 1] */
	voiced: number;
	/** Optional unvoiced burst or frication noise */
	noise?: {
		type: "bandpass" | "highpass";
		freq: number;
		q: number;
		gain: number;
		delay?: number;
	};
}

export interface SpeechOptions {
	/** Voice gender preset controlling pitch, vocal-tract formant scaling, and timbre (default "male") */
	gender?: VoiceGender;
	/** Base vocal-cord fundamental frequency in Hz (defaults to gender preset pitch) */
	pitch?: number;
	/** Speech rate multiplier (default 1) */
	speed?: number;
	/** Output gain level (default 0.2) */
	gain?: number;
	/** Soft-clipping drive hardness on the vocal cords (defaults to gender preset, 0 to disable) */
	drive?: number;
	/** Robotic pitch flutter rate in Hz (defaults to gender preset, 0 to disable) */
	vibratoRate?: number;
	/** Robotic pitch flutter depth in Hz (defaults to gender preset) */
	vibratoDepth?: number;
	/** Optional pitch multipliers across the phoneme sequence */
	contour?: readonly number[];
	/** Optional pre-allocated white-noise buffer */
	noise?: AudioBuffer;
}

export interface SpeechResult {
	/** Total duration of the synthesized utterance in seconds */
	duration: number;
	/** Resolved sequence of phoneme codes */
	phonemes: string[];
}

export const PHONEMES: Readonly<Record<string, PhonemeSpec>> = {
	IY: { f: [270, 2290, 3010], q: [5, 7, 8], g: [1, 0.85, 0.45], d: 0.14, voiced: 1 },
	IH: { f: [390, 1990, 2550], q: [5, 6.5, 8], g: [1, 0.85, 0.45], d: 0.11, voiced: 1 },
	EY: { f: [460, 2100, 2680], q: [5, 6.5, 8], g: [1, 0.85, 0.45], d: 0.15, voiced: 1 },
	EH: { f: [530, 1840, 2480], q: [5, 6.5, 8], g: [1, 0.92, 0.52], d: 0.16, voiced: 1 },
	AE: { f: [660, 1720, 2410], q: [5, 6.5, 8], g: [1, 0.9, 0.5], d: 0.15, voiced: 1 },
	AA: { f: [730, 1090, 2440], q: [5, 6, 8], g: [1, 0.85, 0.42], d: 0.15, voiced: 1 },
	AH: { f: [620, 1220, 2500], q: [5, 6, 8], g: [1, 0.88, 0.48], d: 0.15, voiced: 1 },
	AO: { f: [570, 840, 2410], q: [5, 6, 8], g: [1, 0.82, 0.38], d: 0.15, voiced: 1 },
	OW: { f: [450, 880, 2400], q: [5, 6, 8], g: [1, 0.82, 0.38], d: 0.15, voiced: 1 },
	UH: { f: [440, 1020, 2240], q: [5, 6, 8], g: [1, 0.82, 0.38], d: 0.11, voiced: 1 },
	UW: { f: [300, 870, 2240], q: [5, 6, 8], g: [1, 0.78, 0.38], d: 0.15, voiced: 1 },
	ER: { f: [490, 1350, 1690], q: [5, 6.5, 7.5], g: [1, 0.88, 0.55], d: 0.15, voiced: 1 },
	W: { f: [300, 610, 2200], q: [4.5, 5.5, 7.5], g: [0.95, 0.78, 0.32], d: 0.085, voiced: 1 },
	L: { f: [380, 1050, 2550], q: [4.5, 6, 8], g: [0.92, 0.78, 0.42], d: 0.1, voiced: 0.95 },
	R: { f: [420, 1300, 1650], q: [4.5, 6, 7.5], g: [0.92, 0.82, 0.48], d: 0.09, voiced: 0.95 },
	Y: { f: [280, 2180, 2950], q: [4.5, 6.5, 8], g: [0.92, 0.85, 0.45], d: 0.08, voiced: 1 },
	M: { f: [280, 900, 2200], q: [4.5, 5.5, 7], g: [0.88, 0.5, 0.28], d: 0.13, voiced: 0.92 },
	N: { f: [280, 1450, 2500], q: [4.5, 5.5, 7], g: [0.88, 0.52, 0.32], d: 0.1, voiced: 0.92 },
	NG: { f: [280, 1950, 2600], q: [4.5, 5.5, 7], g: [0.88, 0.48, 0.28], d: 0.11, voiced: 0.92 },
	V: { f: [320, 1050, 2300], q: [4.5, 5.5, 7], g: [0.6, 0.48, 0.28], d: 0.085, voiced: 0.65, noise: { type: "bandpass", freq: 1800, q: 2, gain: 0.14 } },
	Z: { f: [320, 1600, 2600], q: [4.5, 5.5, 7], g: [0.55, 0.48, 0.28], d: 0.09, voiced: 0.6, noise: { type: "highpass", freq: 4200, q: 1.5, gain: 0.22 } },
	B: { f: [300, 900, 2200], q: [4.5, 5.5, 7], g: [0.65, 0.52, 0.28], d: 0.075, voiced: 0.45, noise: { type: "bandpass", freq: 950, q: 2, gain: 0.18, delay: 0.4 } },
	D: { f: [320, 1550, 2550], q: [4.5, 5.5, 7], g: [0.65, 0.52, 0.28], d: 0.075, voiced: 0.45, noise: { type: "bandpass", freq: 2800, q: 2.2, gain: 0.2, delay: 0.4 } },
	G: { f: [320, 1650, 2400], q: [4.5, 5.5, 7], g: [0.65, 0.52, 0.28], d: 0.075, voiced: 0.45, noise: { type: "bandpass", freq: 1550, q: 2.4, gain: 0.2, delay: 0.4 } },
	P: { f: [320, 950, 2250], q: [4.5, 5.5, 7], g: [0.2, 0.2, 0.15], d: 0.08, voiced: 0, noise: { type: "bandpass", freq: 1100, q: 2, gain: 0.28, delay: 0.45 } },
	T: { f: [350, 1700, 2650], q: [4.5, 5.5, 7], g: [0.2, 0.2, 0.15], d: 0.08, voiced: 0, noise: { type: "highpass", freq: 3400, q: 1.8, gain: 0.32, delay: 0.45 } },
	K: { f: [350, 1600, 2450], q: [4.5, 5.5, 7], g: [0.2, 0.2, 0.15], d: 0.085, voiced: 0, noise: { type: "bandpass", freq: 1650, q: 2.4, gain: 0.36, delay: 0.45 } },
	F: { f: [380, 1150, 2350], q: [4.5, 5.5, 7], g: [0.2, 0.2, 0.15], d: 0.09, voiced: 0, noise: { type: "bandpass", freq: 1900, q: 1.5, gain: 0.24 } },
	TH: { f: [400, 1650, 2600], q: [4.5, 5.5, 7], g: [0.2, 0.2, 0.15], d: 0.08, voiced: 0, noise: { type: "highpass", freq: 3800, q: 1.4, gain: 0.24 } },
	S: { f: [380, 1750, 2700], q: [4.5, 5.5, 7], g: [0.2, 0.2, 0.15], d: 0.1, voiced: 0, noise: { type: "highpass", freq: 4600, q: 1.6, gain: 0.3 } },
	SH: { f: [380, 1850, 2500], q: [4.5, 5.5, 7], g: [0.2, 0.2, 0.15], d: 0.1, voiced: 0, noise: { type: "bandpass", freq: 2600, q: 2.2, gain: 0.3 } },
	HH: { f: [500, 1500, 2500], q: [4.5, 5.5, 7], g: [0.3, 0.3, 0.2], d: 0.075, voiced: 0, noise: { type: "bandpass", freq: 1400, q: 1.4, gain: 0.24 } },
	_: { f: [400, 1200, 2400], q: [4.5, 5.5, 7], g: [0.65, 0.55, 0.3], d: 0.045, voiced: 0 },
};

const LEXICON: Readonly<Record<string, readonly string[]>> = {
	welcome: ["W", "EH", "L", "K", "AH", "M"],
	who: ["HH", "UW"],
	are: ["AA", "R"],
	you: ["Y", "UW"],
	i: ["AA", "IH"],
	think: ["TH", "IH", "NG", "K"],
	going: ["G", "OW", "IH", "NG"],
	to: ["T", "UW"],
	die: ["D", "AA", "IH"],
	hello: ["HH", "EH", "L", "OW"],
	robot: ["R", "OW", "B", "AA", "T"],
	system: ["S", "IH", "S", "T", "AH", "M"],
	failure: ["F", "EY", "L", "Y", "ER"],
	in: ["IH", "N"],
	sector: ["S", "EH", "K", "T", "ER"],
	three: ["TH", "R", "IY"],
	critical: ["K", "R", "IH", "T", "IH", "K", "AH", "L"],
	catastrophic: ["K", "AE", "T", "AH", "S", "T", "R", "AA", "F", "IH", "K"],
	containment: ["K", "AH", "N", "T", "EY", "N", "M", "AH", "N", "T"],
	breach: ["B", "R", "IY", "T", "SH"],
	online: ["AA", "N", "L", "AA", "IH", "N"],
	offline: ["AO", "F", "L", "AA", "IH", "N"],
	intruder: ["IH", "N", "T", "R", "UW", "D", "ER"],
	alert: ["AH", "L", "ER", "T"],
	warning: ["W", "AO", "R", "N", "IH", "NG"],
	danger: ["D", "EY", "N", "G", "ER"],
	access: ["AE", "K", "S", "EH", "S"],
	denied: ["D", "IY", "N", "AA", "IH", "D"],
	granted: ["G", "R", "AE", "N", "T", "IH", "D"],
	elevator: ["EH", "L", "AH", "V", "EY", "T", "ER"],
	open: ["OW", "P", "AH", "N"],
	locked: ["L", "AA", "K", "T"],
	clear: ["K", "L", "IY", "R"],
	ready: ["R", "EH", "D", "IY"],
};

const DIGRAPHS: Readonly<Record<string, readonly string[]>> = {
	sh: ["SH"],
	ch: ["T", "SH"],
	th: ["TH"],
	ph: ["F"],
	ng: ["NG"],
	qu: ["K", "W"],
	ck: ["K"],
	ee: ["IY"],
	ea: ["IY"],
	oo: ["UW"],
	ou: ["AA", "UW"],
	ow: ["OW"],
	ai: ["EY"],
	ay: ["EY"],
	oa: ["OW"],
	er: ["ER"],
	ir: ["ER"],
	ur: ["ER"],
	ar: ["AA", "R"],
	or: ["AO", "R"],
};

const LETTERS: Readonly<Record<string, readonly string[]>> = {
	a: ["AE"],
	b: ["B"],
	c: ["K"],
	d: ["D"],
	e: ["EH"],
	f: ["F"],
	g: ["G"],
	h: ["HH"],
	i: ["IH"],
	j: ["D", "SH"],
	k: ["K"],
	l: ["L"],
	m: ["M"],
	n: ["N"],
	o: ["AA"],
	p: ["P"],
	q: ["K"],
	r: ["R"],
	s: ["S"],
	t: ["T"],
	u: ["AH"],
	v: ["V"],
	w: ["W"],
	x: ["K", "S"],
	y: ["IY"],
	z: ["Z"],
	0: ["Z", "IY", "R", "OW"],
	1: ["W", "AH", "N"],
	2: ["T", "UW"],
	3: ["TH", "R", "IY"],
	4: ["F", "AO", "R"],
	5: ["F", "AA", "IH", "V"],
	6: ["S", "IH", "K", "S"],
	7: ["S", "EH", "V", "AH", "N"],
	8: ["EY", "T"],
	9: ["N", "AA", "IH", "N"],
	_: ["_"],
};

function appendWordPhonemes(word: string, out: string[]): void {
	const upper = word.toUpperCase();
	if (upper in PHONEMES) {
		out.push(upper);
		return;
	}
	const lower = word.toLowerCase();
	const known = LEXICON[lower];
	if (known) {
		for (let i = 0; i < known.length; i++) out.push(known[i]);
		return;
	}

	const startLen = out.length;
	for (let i = 0; i < lower.length; ) {
		// Silent final 'e' when the word already contains a vowel
		if (i === lower.length - 1 && lower[i] === "e" && out.length > startLen) {
			i++;
			continue;
		}
		const digraph = DIGRAPHS[lower.slice(i, i + 2)];
		if (digraph) {
			for (let k = 0; k < digraph.length; k++) out.push(digraph[k]);
			i += 2;
			continue;
		}
		const mapped = LETTERS[lower[i]];
		for (let k = 0; k < mapped.length; k++) out.push(mapped[k]);
		// Collapse doubled consonant letters (e.g. "ll", "ss", "tt")
		if (i + 1 < lower.length && lower[i + 1] === lower[i] && !"aeiou".includes(lower[i])) i += 2;
		else i++;
	}
}

/** Converts English text or phoneme tokens into a sequence of GroovR formant phoneme codes. */
export function textToPhonemes(text: string | readonly string[]): string[] {
	const result: string[] = [];
	if (Array.isArray(text)) {
		for (let i = 0; i < text.length; i++) {
			const code = text[i].toUpperCase();
			if (code in PHONEMES) result.push(code);
		}
		return result;
	}
	const tokens = String(text)
		.trim()
		.split(/[^A-Za-z0-9_]+/);
	for (let w = 0; w < tokens.length; w++) {
		const token = tokens[w];
		if (!token) continue;
		if (result.length > 0 && token !== "_" && result[result.length - 1] !== "_") result.push("_");
		appendWordPhonemes(token, result);
	}
	return result;
}

function getNoiseBuffer(ctx: AudioContext, custom?: AudioBuffer): AudioBuffer {
	if (custom) return custom;
	let buf = noiseCache.get(ctx);
	if (!buf) {
		buf = createNoise(ctx);
		noiseCache.set(ctx, buf);
	}
	return buf;
}

function resolveVoiced(phonemes: readonly string[], idx: number): number {
	const code = phonemes[idx];
	if (code !== "_") return PHONEMES[code].voiced;
	const prevV = PHONEMES[phonemes[Math.max(0, idx - 1)]].voiced;
	const nextV = PHONEMES[phonemes[Math.min(phonemes.length - 1, idx + 1)]].voiced;
	return prevV > 0 && nextV > 0 ? 0.72 : 0;
}

/**
 * Synthesizes a robotic voice speaking `text` into `out` starting at `when` seconds.
 * Uses a continuous 3-bandpass parallel formant vocal tract + low-frequency chest body,
 * with configurable `gender` ("male" | "female" | "neutral") scaling pitch and vocal-tract length.
 */
export function speak(
	ctx: AudioContext,
	out: AudioNode,
	when: number,
	text: string | readonly string[],
	options: SpeechOptions = {},
): SpeechResult {
	const phonemes = textToPhonemes(text);
	if (phonemes.length === 0) return { duration: 0, phonemes };

	const preset = VOICE_GENDERS[options.gender ?? "male"];
	const basePitch = Math.max(40, options.pitch ?? preset.pitch);
	const speed = Math.max(0.25, options.speed ?? 1);
	const masterGain = Math.max(MIN_EXP, options.gain ?? 0.2);
	const drive = options.drive ?? preset.drive;
	const vibratoRate = options.vibratoRate ?? preset.vibratoRate;
	const vibratoDepth = options.vibratoDepth ?? preset.vibratoDepth;
	const contour = options.contour;

	let totalDuration = 0;
	for (let i = 0; i < phonemes.length; i++) totalDuration += PHONEMES[phonemes[i]].d / speed;
	const stopAt = when + totalDuration + 0.04;

	// Vocal cords: sawtooth fundamental + gender-weighted chest sub-octave square
	const osc = ctx.createOscillator();
	osc.type = "sawtooth";
	const sub = ctx.createOscillator();
	sub.type = "square";
	const subGain = ctx.createGain();
	subGain.gain.value = preset.subGain;
	sub.connect(subGain);

	if (vibratoRate > 0 && vibratoDepth > 0) {
		const vib = ctx.createOscillator();
		vib.type = "sine";
		vib.frequency.value = vibratoRate;
		const vibDepth = ctx.createGain();
		vibDepth.gain.value = vibratoDepth;
		vib.connect(vibDepth);
		vibDepth.connect(osc.frequency);
		vib.start(when);
		vib.stop(stopAt);
	}

	const voicing = ctx.createGain();
	voicing.gain.setValueAtTime(MIN_EXP, when);
	osc.connect(voicing);
	subGain.connect(voicing);

	let tractInput: AudioNode = voicing;
	if (drive > 0) {
		const shaper = ctx.createWaveShaper();
		shaper.curve = softClip(Utils.clamp(drive, 0.5, 20));
		voicing.connect(shaper);
		tractInput = shaper;
	}

	// 3 parallel bandpass formant resonators (F1, F2, F3)
	const filters: BiquadFilterNode[] = [];
	const levels: GainNode[] = [];
	for (let k = 0; k < 3; k++) {
		const filter = ctx.createBiquadFilter();
		filter.type = "bandpass";
		const level = ctx.createGain();
		tractInput.connect(filter);
		filter.connect(level);
		level.connect(out);
		filters.push(filter);
		levels.push(level);
	}

	// Schedule continuous coarticulated formant trajectories, pitch steps, and consonant bursts
	const isQuestion = !Array.isArray(text) && text.includes("?");
	let cursor = when;
	const count = phonemes.length;
	let prevVoiced = 0;
	let voiced = resolveVoiced(phonemes, 0);

	for (let i = 0; i < count; i++) {
		const nextVoiced = i + 1 < count ? resolveVoiced(phonemes, i + 1) : 0;
		const code = phonemes[i];
		const spec = PHONEMES[code];
		const prevSpec = PHONEMES[phonemes[Math.max(0, i - 1)]];
		const nextSpec = PHONEMES[phonemes[Math.min(count - 1, i + 1)]];
		const dur = spec.d / speed;
		const legato = voiced > 0 && i > 0 && prevVoiced > 0;
		const glide = legato ? dur * 0.72 : Math.min(0.032 / speed, dur * 0.38);
		const pitchGlide = legato ? dur * 0.65 : Math.min(0.018, dur * 0.25);
		const end = cursor + dur;

		// Default robotic cadence: falling on statements, rising on questions ("?")
		const defaultPitch = isQuestion
			? (i < count * 0.7 ? 0.96 : 1.18)
			: (i < count * 0.5 ? 1.06 : 0.88);
		const pitchMult = contour && contour.length > 0
			? contour[Math.min(i, contour.length - 1)]
			: defaultPitch;
		const f0 = Math.max(30, basePitch * pitchMult);
		if (i === 0) {
			osc.frequency.setValueAtTime(f0, cursor);
			sub.frequency.setValueAtTime(f0 * 0.5, cursor);
		} else {
			osc.frequency.exponentialRampToValueAtTime(f0, cursor + pitchGlide);
			sub.frequency.exponentialRampToValueAtTime(f0 * 0.5, cursor + pitchGlide);
		}
		osc.frequency.setValueAtTime(f0, end);
		sub.frequency.setValueAtTime(f0 * 0.5, end);

		const blendSpec = code === "_" ? prevSpec : spec;
		for (let k = 0; k < 3; k++) {
			const filter = filters[k];
			const level = levels[k];
			const rawF = voiced === 0 || code === "_"
				? Utils.mix(blendSpec.f[k], nextSpec.f[k], 0.5)
				: spec.f[k];
			const targetF = Math.max(60, rawF * preset.formantScale[k]);
			const targetQ = Math.max(0.5, spec.q[k] * preset.qScale);
			const targetG = Math.max(MIN_EXP, spec.g[k] * masterGain * FORMANT_BOOST);
			if (i === 0) {
				filter.frequency.setValueAtTime(targetF, cursor);
				filter.Q.setValueAtTime(targetQ, cursor);
				level.gain.setValueAtTime(targetG, cursor);
			} else {
				filter.frequency.exponentialRampToValueAtTime(targetF, cursor + glide);
				filter.Q.exponentialRampToValueAtTime(targetQ, cursor + glide);
				level.gain.exponentialRampToValueAtTime(targetG, cursor + glide);
			}
			filter.frequency.setValueAtTime(targetF, end);
			filter.Q.setValueAtTime(targetQ, end);
			level.gain.setValueAtTime(targetG, end);
		}

		if (voiced > 0) {
			const vPeak = Math.max(MIN_EXP, voiced);
			const attack = Math.min(0.012, dur * 0.25);
			const release = i === count - 1 || nextVoiced === 0;
			voicing.gain.exponentialRampToValueAtTime(vPeak, cursor + attack);
			if (release) {
				voicing.gain.setValueAtTime(vPeak, Math.max(cursor + attack, end - 0.018));
				voicing.gain.exponentialRampToValueAtTime(MIN_EXP, end);
			} else voicing.gain.setValueAtTime(vPeak, end);
		} else {
			voicing.gain.setValueAtTime(MIN_EXP, cursor);
			voicing.gain.setValueAtTime(MIN_EXP, end);
		}

		if (spec.noise) {
			const nSpec = spec.noise;
			const nDelay = (nSpec.delay ?? 0) * dur;
			const nStart = cursor + nDelay;
			const nDur = Math.max(0.015, dur - nDelay);
			const src = ctx.createBufferSource();
			src.buffer = getNoiseBuffer(ctx, options.noise);
			const nf = ctx.createBiquadFilter();
			nf.type = nSpec.type;
			nf.frequency.setValueAtTime(nSpec.freq * preset.noiseScale, nStart);
			nf.Q.setValueAtTime(nSpec.q, nStart);
			const ng = ctx.createGain();
			const nPeak = Math.max(MIN_EXP, nSpec.gain * masterGain * FORMANT_BOOST);
			ng.gain.setValueAtTime(MIN_EXP, nStart);
			ng.gain.exponentialRampToValueAtTime(nPeak, nStart + Math.min(0.006, nDur * 0.3));
			ng.gain.exponentialRampToValueAtTime(MIN_EXP, nStart + nDur);
			src.connect(nf);
			nf.connect(ng);
			ng.connect(out);
			src.start(nStart, Rand.float(0, 0.8));
			src.stop(nStart + nDur + 0.02);
		}

		prevVoiced = voiced;
		voiced = nextVoiced;
		cursor = end;
	}

	voicing.gain.exponentialRampToValueAtTime(MIN_EXP, stopAt);
	osc.start(when);
	osc.stop(stopAt);
	sub.start(when);
	sub.stop(stopAt);

	return { duration: totalDuration, phonemes };
}
