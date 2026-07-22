import type { CraftMethodProbabilityEngine } from './types.js';

export class ProbabilityEngineRegistry {
  readonly #engines = new Map<string, CraftMethodProbabilityEngine>();

  constructor(engines: readonly CraftMethodProbabilityEngine[]) {
    for (const engine of engines) {
      if (this.#engines.has(engine.methodKind)) {
        throw new RangeError(
          `Duplicate probability engine for ${engine.methodKind}`,
        );
      }
      this.#engines.set(engine.methodKind, engine);
    }
  }

  get(methodKind: string) {
    return this.#engines.get(methodKind) ?? null;
  }
}
