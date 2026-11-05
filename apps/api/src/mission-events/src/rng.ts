/**
 * Deterministic seeded randomness for scenario fixtures.
 *
 * Same seed string → same event sequence, byte for byte, across processes and
 * platforms. No Math.random anywhere in this module: a fixture run must be a
 * reproducible experiment, not a dice roll. (fnv1a-32 seed → mulberry32
 * generator — small, well-understood, adequate for scenario jitter; this is
 * fixture variation, not cryptography.)
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    this.state = fnv1a32(seed);
  }

  /** Uniform uint32 — the only primitive; everything else derives from it. */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    if (max < min) throw new Error(`nextInt: max ${max} < min ${min}`);
    return min + (this.nextUint32() % (max - min + 1));
  }

  /** Deterministic hex string of `length` nibbles. */
  nextHex(length: number): string {
    let out = '';
    while (out.length < length) {
      out += this.nextUint32().toString(16).padStart(8, '0');
    }
    return out.slice(0, length);
  }
}

/**
 * Deterministic event id derived from scenario identity + stream position +
 * observation time. Two submissions that share (asset, sequence) but report
 * different observation instants are different events; an exact retransmission
 * (same sequence AND same observation instant) yields the same id — which is
 * exactly what duplicate suppression should catch.
 */
export function deterministicEventId(
  seed: string,
  assetId: string,
  sequence: number,
  observedMin: number,
): string {
  const random = new SeededRandom(`${seed}|${assetId}|${sequence}|${observedMin}`);
  return `mevt_${random.nextHex(12)}`;
}

/**
 * Fixture-only source keys, derived from the scenario seed. Deterministic so
 * traces (including signatures) reproduce exactly. These are NOT credentials:
 * they never leave the fixture process, guard only synthetic telemetry, and
 * any production deployment provisions real keys from a secret manager into
 * the same registry shape.
 */
export function fixtureSourceKey(seed: string, sourceId: string): string {
  const random = new SeededRandom(`fixture-key|${seed}|${sourceId}`);
  return `fixture-only:${random.nextHex(32)}`;
}
