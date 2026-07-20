import { DomainError, type LeagueRepository } from '@poe-worksmith/domain';
import { z } from 'zod';

const tradeSchema = z.array(z.object({ id: z.string().min(1) }).loose());
const ninjaSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1) }).loose(),
);

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface PoeTradeLeagueClient {
  fetchLeagueIds(): Promise<readonly string[]>;
}
export interface PoeNinjaLeagueClient {
  fetchEconomyLeagues(): Promise<readonly { id: string; name: string }[]>;
}

export class HttpPoeTradeLeagueClient implements PoeTradeLeagueClient {
  #fetch: Fetch;
  #timeout: number;
  #userAgent: string;
  constructor(options: {
    fetch?: Fetch;
    requestTimeoutMs: number;
    userAgent: string;
  }) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.requestTimeoutMs;
    this.#userAgent = options.userAgent;
  }
  async fetchLeagueIds() {
    return (
      await request(
        this.#fetch,
        'https://api.pathofexile.com/trade/data/leagues',
        this.#timeout,
        this.#userAgent,
        'POE_TRADE_LEAGUES_UNAVAILABLE',
        'POE_TRADE_LEAGUES_INVALID',
        tradeSchema,
      )
    ).map((league) => league.id);
  }
}
export class HttpPoeNinjaLeagueClient implements PoeNinjaLeagueClient {
  #fetch: Fetch;
  #timeout: number;
  #userAgent: string;
  constructor(options: {
    fetch?: Fetch;
    requestTimeoutMs: number;
    userAgent: string;
  }) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.requestTimeoutMs;
    this.#userAgent = options.userAgent;
  }
  fetchEconomyLeagues() {
    return request(
      this.#fetch,
      'https://poe.ninja/poe1/api/economy/leagues',
      this.#timeout,
      this.#userAgent,
      'POE_NINJA_LEAGUES_UNAVAILABLE',
      'POE_NINJA_LEAGUES_INVALID',
      ninjaSchema,
    );
  }
}
async function request<T>(
  fetch: Fetch,
  url: string,
  timeout: number,
  userAgent: string,
  unavailable:
    'POE_TRADE_LEAGUES_UNAVAILABLE' | 'POE_NINJA_LEAGUES_UNAVAILABLE',
  invalid: 'POE_TRADE_LEAGUES_INVALID' | 'POE_NINJA_LEAGUES_INVALID',
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (cause) {
    throw new DomainError(unavailable, { cause });
  }
  if (!response.ok) throw new DomainError(unavailable);
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new DomainError(invalid, { cause });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new DomainError(invalid, { cause: parsed.error });
  return parsed.data;
}

export type LeagueResolutionReport = {
  currentLeagueId: string | null;
  poeNinjaLeagueCount: number;
  previousLeagueId: string | null;
  selectedLeagueId: string | null;
  switched: boolean;
  tradeLeagueCount: number;
  resolvedAt: Date;
};
export class LeagueResolver {
  constructor(
    private readonly options: {
      leagues: LeagueRepository;
      poeNinja: PoeNinjaLeagueClient;
      trade: PoeTradeLeagueClient;
    },
  ) {}
  async resolve(now = new Date()): Promise<LeagueResolutionReport> {
    const [tradeIds, ninja] = await Promise.all([
      this.options.trade.fetchLeagueIds(),
      this.options.poeNinja.fetchEconomyLeagues(),
    ]);
    const trade = new Set(tradeIds);
    const previous = await this.options.leagues.findCurrent();
    const agreed = [
      { id: 'Standard', name: 'Standard' },
      ...ninja.filter(
        (league) => league.id !== 'Standard' && trade.has(league.id),
      ),
    ];
    const saved = await Promise.all(
      agreed.map((league) =>
        this.options.leagues.upsert({
          game: 'poe1',
          realm: 'pc',
          gggId: league.id,
          name: league.name,
          startAt: null,
          endAt: null,
          isCurrent: false,
          syncedAt: now,
          metadata: {
            tradeObserved: true,
            poeNinjaObserved: true,
            resolverVersion: 1,
          },
        }),
      ),
    );
    const selected = ninja.find(
      (league) => league.id !== 'Standard' && trade.has(league.id),
    );
    const next = selected
      ? saved.find((league) => league.gggId === selected.id)!
      : previous;
    const current =
      selected && next
        ? await this.options.leagues.setCurrent(next.id, now)
        : previous;
    return {
      currentLeagueId: current?.gggId ?? null,
      poeNinjaLeagueCount: ninja.length,
      previousLeagueId: previous?.gggId ?? null,
      selectedLeagueId: selected?.id ?? null,
      switched: Boolean(selected && previous?.id !== current?.id),
      tradeLeagueCount: trade.size,
      resolvedAt: now,
    };
  }
}
