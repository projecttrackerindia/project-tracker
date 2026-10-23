/**
 * Shamir's secret sharing over GF(2^8) (the AES field, x^8 + x^4 + x^3 + x + 1), byte by byte: the identity seed is split into N shares so
 * that any M of them give it back and fewer than M tell nothing about it (each byte is the constant of a random polynomial of degree M-1).
 *
 * A share is [x, y1 … yn]: its point (1…255) and one value per byte of the secret. The polynomial coefficients come from the browser's
 * cryptographic random source and are wiped after use. Combining with a wrong or too-small set of shares gives a different secret, which the
 * caller detects (the seed must give exactly the public keys on record).
 */
import { random, wipe } from './crypto';

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x ^= x << 1;                 // multiply by the generator 3
    if (x & 0x100) x ^= 0x11b;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a: number, b: number) => {
  if (b === 0) throw new RangeError('Division by zero in GF(256).');
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
};

export const MAX_SHARES = 7;

/** Splits a secret into `n` shares, any `m` of which give it back (2 ≤ m ≤ n ≤ 7). */
export function split(secret: Uint8Array, n: number, m: number): Uint8Array[] {
  if (!Number.isInteger(n) || !Number.isInteger(m) || m < 2 || n < m || n > MAX_SHARES) throw new RangeError('Choose 2 to 7 people and a threshold from 2 up to that number.');
  if (secret.length === 0) throw new RangeError('Nothing to split.');
  const shares = Array.from({ length: n }, (_, i) => { const s = new Uint8Array(secret.length + 1); s[0] = i + 1; return s; });
  const coeffs = new Uint8Array(m);
  for (let b = 0; b < secret.length; b++) {
    coeffs[0] = secret[b];
    coeffs.set(random(m - 1), 1);
    for (const s of shares) {
      // Horner: c0 + x(c1 + x(c2 + …))
      let y = 0;
      for (let k = m - 1; k >= 0; k--) y = mul(y, s[0]) ^ coeffs[k];
      s[b + 1] = y;
    }
  }
  wipe(coeffs);
  return shares;
}

/** Gives the secret back from at least the threshold number of distinct shares (Lagrange interpolation at x = 0). */
export function combine(shares: Uint8Array[]): Uint8Array {
  if (shares.length < 2) throw new RangeError('At least two shares are needed.');
  const len = shares[0].length;
  const xs = shares.map((s) => s[0]);
  if (shares.some((s) => s.length !== len || len < 2)) throw new RangeError('The shares do not belong together.');
  if (xs.some((x) => x === 0) || new Set(xs).size !== xs.length) throw new RangeError('Each share must be a different one.');
  const out = new Uint8Array(len - 1);
  // The Lagrange basis at 0 depends only on the points: l_i(0) = Π_{j≠i} x_j / (x_j − x_i), and subtraction is XOR here.
  const basis = xs.map((xi, i) => xs.reduce((acc, xj, j) => (j === i ? acc : mul(acc, div(xj, xj ^ xi))), 1));
  for (let b = 1; b < len; b++) {
    let v = 0;
    for (let i = 0; i < shares.length; i++) v ^= mul(shares[i][b], basis[i]);
    out[b - 1] = v;
  }
  return out;
}
