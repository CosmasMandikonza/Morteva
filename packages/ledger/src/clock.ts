/**
 * Time is injected everywhere freshness matters (snapshot expiry, approval
 * expiry, claim staleness) so tests exercise real time-dependent behavior
 * deterministically without sleeping.
 */
export interface Clock {
  now(): Date;
  iso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  iso(): string {
    return new Date().toISOString();
  }
}

/** Deterministic clock for tests: starts at `start`, advances only when told. */
export class TunableClock implements Clock {
  private current: number;

  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  iso(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): this {
    this.current += ms;
    return this;
  }
}
