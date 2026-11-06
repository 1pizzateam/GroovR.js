import { spatial2D } from '../build/es6/groovr.js';
import { Vec2 } from '@1pizzateam/spock';

describe('spatial2D', () => {
  const origin = new Vec2(0, 0);

  it('AC-1 exports spatial2D returning pan, gain and distance', () => {
    expect(typeof spatial2D).toBe('function');
    const r = spatial2D(origin, 0, new Vec2(3, 4));
    expect(typeof r.pan).toBe('number');
    expect(typeof r.gain).toBe('number');
    expect(typeof r.distance).toBe('number');
  });

  it('AC-2 computes distance and signed pan for reference emitters', () => {
    const a = spatial2D(origin, 0, new Vec2(3, 4));
    const b = spatial2D(origin, 0, new Vec2(3, -4));
    const c = spatial2D(origin, 0, new Vec2(5, 0));
    expect(a.distance).toBeCloseTo(5);
    expect(b.distance).toBeCloseTo(5);
    expect(a.pan).toBeCloseTo(0.8);
    expect(b.pan).toBeCloseTo(-0.8);
    expect(c.pan).toBeCloseTo(0);
  });

  it('AC-3 eases pan near the listener and handles coincident positions', () => {
    const same = spatial2D(origin, 0, new Vec2(0, 0));
    expect(same.pan).toBe(0);
    expect(same.gain).toBe(1);
    expect(same.distance).toBe(0);
    const near = spatial2D(origin, 0, new Vec2(0, 0.5), { easeDistance: 1 });
    expect(near.pan).toBeCloseTo(0.5);
  });

  it('AC-4 applies bounded inverse-square gain with default options', () => {
    const at = (d) => spatial2D(origin, 0, new Vec2(d, 0)).gain;
    expect(at(0.5)).toBe(1);
    expect(at(1)).toBe(1);
    expect(at(2)).toBeCloseTo((0.25 - 1 / 400) / (1 - 1 / 400));
    expect(at(2)).toBeCloseTo(0.2481, 3);
    let prev = 1;
    for (let d = 1.5; d < 20; d += 0.5) {
      const g = at(d);
      expect(g).toBeLessThan(prev);
      expect(g).toBeGreaterThanOrEqual(0);
      prev = g;
    }
    expect(at(20)).toBe(0);
    expect(at(30)).toBe(0);
  });

  it('AC-5 honours custom reference, range, panMax and easeDistance', () => {
    const opts = { panMax: 0.5, reference: 2, range: 10, easeDistance: 4 };
    expect(spatial2D(origin, 0, new Vec2(0, 8), opts).pan).toBeCloseTo(0.5);
    expect(spatial2D(origin, 0, new Vec2(0, -8), opts).pan).toBeCloseTo(-0.5);
    expect(spatial2D(origin, 0, new Vec2(0, 2), opts).pan).toBeCloseTo(0.25);
    expect(spatial2D(origin, 0, new Vec2(2, 0), opts).gain).toBe(1);
    expect(spatial2D(origin, 0, new Vec2(10, 0), opts).gain).toBe(0);
  });

  it('AC-6 pan is relative to listener heading', () => {
    const h = Math.PI / 2;
    expect(spatial2D(origin, h, new Vec2(0, 5)).pan).toBeCloseTo(0);
    expect(spatial2D(origin, h, new Vec2(0, -5)).pan).toBeCloseTo(0);
    expect(spatial2D(origin, h, new Vec2(-5, 0)).pan).toBeCloseTo(1);
    expect(spatial2D(origin, h, new Vec2(5, 0)).pan).toBeCloseTo(-1);
    expect(spatial2D(origin, Math.PI, new Vec2(-5, 0)).pan).toBeCloseTo(0);
    expect(spatial2D(origin, Math.PI, new Vec2(0, 5)).pan).toBeCloseTo(-1);
  });

  it('AC-7 reuses the out target and never mutates inputs', () => {
    const listener = new Vec2(1, 2);
    const emitter = new Vec2(4, 6);
    const out = { pan: 0, gain: 0, distance: 0 };
    const r = spatial2D(listener, 0, emitter, undefined, out);
    expect(r).toBe(out);
    expect(out.distance).toBeCloseTo(5);
    expect(listener.x).toBe(1);
    expect(listener.y).toBe(2);
    expect(emitter.x).toBe(4);
    expect(emitter.y).toBe(6);
    expect(spatial2D(listener, 0, emitter, undefined, out)).toBe(out);
    expect(spatial2D(listener, 0, emitter)).not.toBe(spatial2D(listener, 0, emitter));
  });
});
