import type {
  Repositories,
  RetentionCleanupReport,
} from '@poe-worksmith/domain';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

export type RetentionRunReport = RetentionCleanupReport & {
  batches: number;
  drained: boolean;
};

export class RetentionCleaner {
  readonly #batchSize: number;
  readonly #clock: () => Date;
  readonly #jobsRetentionMs: number;
  readonly #maxBatches: number;
  readonly #observationsRetentionMs: number;
  readonly #rawSnapshotsRetentionMs: number;
  readonly #repositories: Repositories;

  constructor(options: {
    batchSize?: number;
    clock?: () => Date;
    jobsRetentionMs?: number;
    maxBatches?: number;
    observationsRetentionMs?: number;
    rawSnapshotsRetentionMs?: number;
    repositories: Repositories;
  }) {
    this.#batchSize = options.batchSize ?? 500;
    this.#clock = options.clock ?? (() => new Date());
    this.#jobsRetentionMs = options.jobsRetentionMs ?? 14 * dayMs;
    this.#maxBatches = options.maxBatches ?? 100;
    this.#observationsRetentionMs =
      options.observationsRetentionMs ?? 14 * dayMs;
    this.#rawSnapshotsRetentionMs =
      options.rawSnapshotsRetentionMs ?? 72 * hourMs;
    this.#repositories = options.repositories;
    for (const [name, value] of [
      ['batchSize', this.#batchSize],
      ['jobsRetentionMs', this.#jobsRetentionMs],
      ['maxBatches', this.#maxBatches],
      ['observationsRetentionMs', this.#observationsRetentionMs],
      ['rawSnapshotsRetentionMs', this.#rawSnapshotsRetentionMs],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
  }

  async run(): Promise<RetentionRunReport> {
    const now = this.#clock();
    const total = {
      batches: 0,
      jobs: 0,
      observations: 0,
      rawSnapshots: 0,
    };
    let drained = false;

    while (total.batches < this.#maxBatches) {
      const batch = await this.#repositories.retention.cleanup({
        batchSize: this.#batchSize,
        jobsBefore: new Date(now.getTime() - this.#jobsRetentionMs),
        observationsBefore: new Date(
          now.getTime() - this.#observationsRetentionMs,
        ),
        rawSnapshotsBefore: new Date(
          now.getTime() - this.#rawSnapshotsRetentionMs,
        ),
      });
      total.batches += 1;
      total.jobs += batch.jobs;
      total.observations += batch.observations;
      total.rawSnapshots += batch.rawSnapshots;
      if (
        batch.jobs < this.#batchSize &&
        batch.observations < this.#batchSize &&
        batch.rawSnapshots < this.#batchSize
      ) {
        drained = true;
        break;
      }
    }

    return { ...total, drained };
  }
}
