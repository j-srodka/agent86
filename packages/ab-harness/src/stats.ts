import assert from "node:assert/strict";

/**
 * Wilson score interval for a binomial proportion (event count `k` out of `n` trials).
 * Estimates p = k/n with approximate `z`-sigma confidence bounds.
 * Returns null bounds when n < 10 (benchmark policy: not enough tasks for stable CI).
 */
export function wilsonCI(k: number, n: number, z: number): { lower: number | null; upper: number | null } {
  if (n < 10 || k < 0 || k > n) {
    return { lower: null, upper: null };
  }
  const p = k / n;
  const den = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / den;
  return { lower: center - half, upper: center + half };
}

{
  const z = 1.96;
  const a = wilsonCI(5, 10, z);
  assert.ok(a.lower !== null && a.upper !== null);
  assert.ok(Math.abs(a.lower! - 0.23658959361548731) < 1e-9);
  assert.ok(Math.abs(a.upper! - 0.7634104063845126) < 1e-9);

  const b = wilsonCI(50, 100, z);
  assert.ok(b.lower !== null && b.upper !== null);
  assert.ok(Math.abs(b.lower! - 0.40382982859014716) < 1e-9);
  assert.ok(Math.abs(b.upper! - 0.5961701714098528) < 1e-9);

  const c = wilsonCI(0, 9, z);
  assert.equal(c.lower, null);
  assert.equal(c.upper, null);
}
