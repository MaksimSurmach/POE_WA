import { DomainError } from '@poe-worksmith/domain';

export class ProviderContractError extends DomainError<'PROVIDER_SCHEMA_CHANGED'> {
  readonly endpoint: string;
  readonly issuePaths: readonly string[];
  readonly provider: string;

  constructor(options: {
    endpoint: string;
    issuePaths: readonly string[];
    provider: string;
  }) {
    super('PROVIDER_SCHEMA_CHANGED');
    this.endpoint = options.endpoint;
    this.issuePaths = options.issuePaths;
    this.provider = options.provider;
  }
}
