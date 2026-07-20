import type { PoeLeague } from '@poe-worksmith/domain';

export type RefreshLeagueContext = Readonly<{
  leagueGggId: string;
  leagueId: string;
  leagueName: string;
}>;

export function refreshLeagueContext(league: PoeLeague): RefreshLeagueContext {
  const context = {
    leagueGggId: league.gggId.trim(),
    leagueId: league.id.trim(),
    leagueName: league.name.trim(),
  };
  if (Object.values(context).some((value) => value.length === 0)) {
    throw new TypeError('Refresh league context is invalid');
  }
  return Object.freeze(context);
}
