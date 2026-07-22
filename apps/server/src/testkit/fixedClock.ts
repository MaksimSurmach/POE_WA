export const FIXTURE_NOW = new Date('2026-07-20T12:00:00.000Z');

export class FixedClock {
  #value: Date;
  constructor(value = FIXTURE_NOW) {
    this.#value = new Date(value);
  }
  now = () => new Date(this.#value);
  advanceMilliseconds(milliseconds: number) {
    if (!Number.isFinite(milliseconds))
      throw new TypeError('milliseconds must be finite');
    this.#value = new Date(this.#value.getTime() + milliseconds);
    return this.now();
  }
}
