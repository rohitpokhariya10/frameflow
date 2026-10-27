import { describe, expect, it } from 'vitest';
import { findBurst } from './burst.js';

/**
 * A festive creative's sunburst as on a real 606 px Ganesh creative: thin rays of two colours only 26 apart, radiating
 * from below the podium, inside an arch with mint panels on both sides (one ray colour and the mint, 56 apart, alternate
 * a few times around a wrong centre too), and a large hole where the products stand.
 */
function poster() {
  const w = 606, h = 606, cx = 302, cy = 520, rgb = new Uint8Array(w * h * 3), hole = new Uint8Array(w * h);
  const A = [226, 249, 159], B = [233, 251, 185], MINT = [186, 245, 215];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, t = (Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI);
    const c = x < 70 || x > 536 ? MINT : Math.floor(t * 109) % 2 ? B : A;
    rgb.set(c, i * 3);
    if (x >= 170 && x < 420 && y >= 240 && y < 470) hole[i] = 1;
  }
  return { w, h, rgb, hole, A, B };
}

describe('findBurst', { timeout: 60_000 }, () => {
  it('finds thin rays of two close colours (not a ray colour paired with a side panel), with their centre', () => {
    const p = poster(), b = findBurst(p.rgb, p.w, p.h, i => !p.hole[i]);
    expect(b).toBeDefined();
    expect([b!.a, b!.b].map(c => c.join(',')).sort()).toEqual([p.A, p.B].map(c => c.join(',')).sort());
    expect(Math.hypot(b!.cx - 302, b!.cy - 520)).toBeLessThan(12);
    expect(b!.stripes).toBeGreaterThanOrEqual(24);
  });
});
