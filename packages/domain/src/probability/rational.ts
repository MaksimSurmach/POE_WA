export type ExactRationalJson = {
  numerator: string;
  denominator: string;
};

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export class ExactRational {
  readonly #denominator: bigint;
  readonly #numerator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    this.#numerator = numerator;
    this.#denominator = denominator;
  }

  static zero() {
    return ExactRational.of(0n);
  }

  static one() {
    return ExactRational.of(1n);
  }

  static of(numerator: bigint, denominator = 1n) {
    if (denominator === 0n)
      throw new RangeError('Denominator must not be zero');
    if (numerator === 0n) return new ExactRational(0n, 1n);
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = gcd(numerator, denominator);
    return new ExactRational(
      (numerator / divisor) * sign,
      (denominator / divisor) * sign,
    );
  }

  add(other: ExactRational) {
    return ExactRational.of(
      this.#numerator * other.#denominator +
        other.#numerator * this.#denominator,
      this.#denominator * other.#denominator,
    );
  }

  multiply(other: ExactRational) {
    return ExactRational.of(
      this.#numerator * other.#numerator,
      this.#denominator * other.#denominator,
    );
  }

  divide(other: ExactRational) {
    return this.multiply(other.invert());
  }

  compare(other: ExactRational): -1 | 0 | 1 {
    const value =
      this.#numerator * other.#denominator -
      other.#numerator * this.#denominator;
    return value < 0n ? -1 : value > 0n ? 1 : 0;
  }

  invert() {
    if (this.#numerator === 0n) throw new RangeError('Cannot invert zero');
    return ExactRational.of(this.#denominator, this.#numerator);
  }

  toDecimal(scale: number) {
    if (!Number.isInteger(scale) || scale < 0) {
      throw new RangeError('Scale must be a non-negative integer');
    }
    const negative = this.#numerator < 0n;
    const factor = 10n ** BigInt(scale);
    const magnitude = negative ? -this.#numerator : this.#numerator;
    let rounded = (magnitude * factor) / this.#denominator;
    if (((magnitude * factor) % this.#denominator) * 2n >= this.#denominator) {
      rounded += 1n;
    }
    const value = rounded.toString().padStart(scale + 1, '0');
    const decimal =
      scale === 0 ? value : `${value.slice(0, -scale)}.${value.slice(-scale)}`;
    return negative && rounded !== 0n ? `-${decimal}` : decimal;
  }

  toJSON(): ExactRationalJson {
    return {
      numerator: this.#numerator.toString(),
      denominator: this.#denominator.toString(),
    };
  }
}
