import { Trigo, Utils, Vec2 } from "@1pizzateam/spock";

export interface SpatialAudio2DOptions {
	reference?: number;
	range?: number;
	panMax?: number;
	easeDistance?: number;
}

export interface SpatialAudio2DResult {
	pan: number;
	gain: number;
	distance: number;
}

const EPSILON = 1e-9;
const scratch = new Vec2();
const forward = new Vec2(1, 0);

/**
 * Listener-relative 2D spatial audio. Forward is (cos a, sin a); positive pan is toward the listener's +y side at angle 0.
 * Pass `out` for an allocation-free call; otherwise a fresh result is returned.
 */
export function spatial2D(
	listenerPos: Vec2,
	listenerAngle: number,
	emitterPos: Vec2,
	options?: SpatialAudio2DOptions,
	out?: SpatialAudio2DResult,
): SpatialAudio2DResult {
	const result = out ?? { pan: 0, gain: 1, distance: 0 };
	const reference = Math.max(options?.reference ?? 1, EPSILON);
	const range = options?.range ?? 20;
	const panMax = options?.panMax ?? 1;
	const easeDistance = options?.easeDistance ?? 1;

	scratch.subVectors(emitterPos, listenerPos);
	const distance = scratch.getMagnitude();

	let pan = 0;
	if (distance >= EPSILON) {
		forward.setScalar(Trigo.cosinePrecise(listenerAngle), Trigo.sinePrecise(listenerAngle));
		pan = forward.crossProduct(scratch) / distance;
		if (easeDistance > 0) pan *= Utils.clamp(distance / easeDistance, 0, 1);
	}

	let gain: number;
	if (distance <= reference) gain = 1;
	else if (distance >= range || range <= reference) gain = 0;
	else {
		const r2 = reference * reference;
		const floor = r2 / (range * range);
		gain = Utils.clamp(Utils.normalize(r2 / scratch.getMagnitude(true), floor, 1), 0, 1);
	}

	result.pan = Utils.clampToExtent(pan * panMax, panMax);
	result.gain = gain;
	result.distance = distance;
	return result;
}
