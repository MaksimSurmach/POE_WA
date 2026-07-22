import {
  DomainError,
  hashMarketQuery,
  type DomainErrorCode,
  type MarketSearchProvider,
  type MarketSearchResult,
} from '@poe-worksmith/domain';

export type ProviderStep =
  | { type: 'success'; result: MarketSearchResult }
  | { type: 'error'; errorCode: DomainErrorCode }
  | { type: 'malformed' };
export type DeterministicProviderScript = Readonly<
  Record<string, readonly ProviderStep[]>
>;

export class DeterministicMarketProvider implements MarketSearchProvider {
  readonly id = 'poe-trade';
  readonly #calls: string[] = [];
  readonly #positions = new Map<string, number>();
  constructor(
    readonly script: DeterministicProviderScript,
    readonly clock: () => Date = () => new Date(),
  ) {}
  async search(request: Parameters<MarketSearchProvider['search']>[0]) {
    const hash = await hashMarketQuery({ ...request, provider: this.id });
    const index = this.#positions.get(hash) ?? 0;
    const step = this.script[hash]?.[index];
    if (!step) throw new Error(`Fixture provider script exhausted for ${hash}`);
    this.#positions.set(hash, index + 1);
    this.#calls.push(hash);
    if (step.type === 'success')
      return { ...step.result, fetchedAt: this.clock() };
    if (step.type === 'malformed')
      throw new DomainError('PROVIDER_SCHEMA_CHANGED');
    throw new DomainError(step.errorCode);
  }
  callsByHash(hash: string) {
    return this.#calls.filter((value) => value === hash).length;
  }
  totalCalls() {
    return this.#calls.length;
  }
  assertCallsByHash(hash: string, expected: number) {
    if (this.callsByHash(hash) !== expected)
      throw new Error(`Expected ${expected} calls for ${hash}`);
  }
  assertTotalCalls(expected: number) {
    if (this.totalCalls() !== expected)
      throw new Error(`Expected ${expected} provider calls`);
  }
}
