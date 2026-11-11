import type { Pool, PoolClient } from 'pg';

type Query = Pick<Pool | PoolClient, 'query'>;

// Missing league evidence also fails closed for market jobs.
export const nonStandardSchedulePredicate = `(kind not in ('trade-target', 'economy')
  or league_id in (select id from poe_leagues where ggg_id <> 'Standard'))`;

export const tradeCapturePolicyPredicate = `r.policy in ('poe-trade', 'trade-search-request-limit', 'trade-fetch-request-limit')
  or exists (select 1 from rate_limit_endpoint_policies p
             where p.policy = r.policy and p.endpoint in ('trade', 'trade-search', 'trade-fetch'))`;

type Queue = {
  id: string | null;
  nextDueAt: Date | null;
  due: number;
  enabled: number;
  oldestDueAt: Date | null;
  tradeCapturesPerHour: number;
  paused: boolean;
  blocked: string | null;
  recovery: boolean;
  cooldownUntil: Date | null;
  cooldownStatus: number | null;
  pacingUntil: Date | null;
  retryUntil: Date | null;
  retryReason: string | null;
  leaderPid: number | null;
  standby: boolean;
};

// One eligibility query serves dispatch and the public status strip.
export async function readCollectorQueue(
  connection: Query,
  now: Date,
  request?: {
    pending: string[];
    recoverTradeAuthentication?: true | undefined;
  },
  skipStandard = false,
) {
  const { rows } = await connection.query<Queue>(
    `with controls as (
       select (select blocked_reason from collector_state where id = 1) as blocked,
              coalesce((select settings->>'collectionsPaused' = 'true'
                        from market_admin_settings where id = 1), false) as paused,
              coalesce($2::jsonb, (select summary from run_requests
                        where state = 'running' order by requested_at limit 1), '{}'::jsonb) as request
     ), policies as (
       select r.* from rate_limit_states r where ${tradeCapturePolicyPredicate}
         or (exists (select 1 from controls where blocked is not null
                    and request->>'recoverTradeAuthentication' = 'true')
             and (r.policy = 'trade-login-request-limit'
               or exists (select 1 from rate_limit_endpoint_policies p
                          where p.policy = r.policy and p.endpoint = 'trade-login')))
     ), cooldown as (
       select blocked_until, last_status from policies
       where blocked_until > $1 order by blocked_until desc limit 1
     ), pacing as (
       select max(r.next_request_at) as until from policies r
       join rate_limit_endpoint_policies p on p.policy = r.policy
       where r.next_request_at > $1 and (
         p.endpoint = 'trade-search' or (p.endpoint = 'trade-login' and
           exists (select 1 from controls where blocked is not null
                   and request->>'recoverTradeAuthentication' = 'true'))
       )
     ), scheduled as (
       select s.id, s.kind, s.interval_minutes, s.retry_at, s.last_error, s.leased_until,
              s.payload->>'discovery' = 'true' as discovery,
              greatest(s.next_due_at, s.retry_at) as raw_due,
              greatest(s.next_due_at, s.retry_at, s.leased_until,
                case when s.kind = 'trade-target' then (select blocked_until from cooldown) end,
                case when s.kind = 'trade-target' then (select until from pacing) end) as due,
              coalesce((controls.request->'pending') ? s.id::text, false) as pending,
              (not $3::boolean or ${nonStandardSchedulePredicate}) and
              (not controls.paused or s.kind not in ('trade-target','economy')) and
              (s.kind <> 'trade-target' or controls.blocked is null
                or (controls.request->>'recoverTradeAuthentication' = 'true'
                    and (controls.request->'pending') ? s.id::text)) as eligible
       from collector_schedule s cross join controls where s.enabled
     ), next as (
       select * from scheduled where eligible
       order by (due <= $1) desc,
                (pending and due <= $1) desc,
                case when due > $1 then 0 when discovery then 3
                     when kind in ('league','economy') then 1 else 2 end,
                due, id limit 1
     ), locks as (
       select pid, granted from pg_locks
       where locktype = 'advisory' and mode = 'ExclusiveLock' and objsubid = 1
         and database = (select oid from pg_database where datname = current_database())
         and ((classid::bigint << 32) | objid::bigint) = hashtext('poe-worksmith:collector')::bigint
     )
     select next.id, next.due as "nextDueAt",
            (select count(*)::int from scheduled) as enabled,
            (select count(*)::int from scheduled where raw_due <= $1 and
               (leased_until is null or leased_until <= $1)) as due,
            (select min(raw_due) from scheduled where raw_due <= $1 and
               (leased_until is null or leased_until <= $1)) as "oldestDueAt",
            coalesce((select sum(60.0 / interval_minutes)::float8 from scheduled
                      where kind = 'trade-target'), 0) as "tradeCapturesPerHour",
            controls.paused, controls.blocked,
            coalesce(controls.request->>'recoverTradeAuthentication' = 'true', false) as recovery,
            (select blocked_until from cooldown) as "cooldownUntil",
            (select last_status from cooldown) as "cooldownStatus",
            (select until from pacing) as "pacingUntil",
            case when next.retry_at > $1 and next.retry_at = next.due then next.retry_at end as "retryUntil",
            next.last_error as "retryReason",
            (select pid from locks where granted limit 1) as "leaderPid",
            exists (select 1 from locks where not granted) as standby
     from controls left join next on true`,
    [now, request ?? null, skipStandard],
  );
  return rows[0]!;
}
