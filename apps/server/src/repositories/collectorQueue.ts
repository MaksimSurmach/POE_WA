import type { CollectorStatus } from '@poe-worksmith/contracts';
import type { Pool, PoolClient } from 'pg';

type Query = Pick<Pool | PoolClient, 'query'>;

// Missing league evidence also fails closed for market jobs.
export const nonStandardSchedulePredicate = `(kind not in ('trade-target', 'economy')
  or league_id in (select id from poe_leagues where ggg_id <> 'Standard'))`;

export function marketCollectionEnabledSql(manual = 'false') {
  return `not coalesce((select settings->>'collectionsPaused' = 'true' or
    case when ${manual} then settings->>'manualRefreshEnabled' = 'false'
    else settings->>'automaticRefreshEnabled' = 'false'
      or settings->>'scheduledCollectionEnabled' = 'false' end
    from market_admin_settings where id = 1), false)`;
}

export const tradeCapturePolicyPredicate = `r.policy in ('poe-trade', 'trade-search-request-limit', 'trade-fetch-request-limit')
  or exists (select 1 from rate_limit_endpoint_policies p
             where p.policy = r.policy and p.endpoint in ('trade', 'trade-search', 'trade-fetch'))`;

type Queue = {
  id: string | null;
  nextDueAt: Date | null;
  poolCycleId: string | null;
  nextCycleAt: Date | null;
  tradePools: NonNullable<CollectorStatus['tradePools']> | null;
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
  includePools = false,
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
     ), pools as (
       select p.league_id as pool_league, p.priority, p.cycle_id, p.paused_at,
              cardinality(p.members)::float8 / p.period_minutes as starts_per_minute,
              p.started_at + make_interval(mins => p.period_minutes) as cycle_end,
              min(s.next_due_at) filter (where s.enabled and s.settled_cycle_id is distinct from p.cycle_id) as next_slot,
              max(s.last_started_at) as last_start
       from collector_trade_pool p join collector_schedule s
         on s.league_id=p.league_id and s.scraping_priority=p.priority
       group by p.league_id,p.priority
     ), recent_captures as (
       select measurements from collector_telemetry_runs where kind='trade-target'
         and outcome in ('complete','partial') and measurements ? 'requestMinutes'
       order by started_at desc limit 32
     ), policy_cost as (
       select ep.policy,
         sum(r.success+r."rateLimited"+r.auth+r."serverError"+r."networkError"+r.other)::float8
         / (select count(*) from recent_captures) * max(l.minimum_delay_ms) as ms_per_target
       from recent_captures c cross join lateral jsonb_array_elements(c.measurements->'requestMinutes') b
       cross join lateral jsonb_to_recordset(b->'requests') as r(endpoint text,success int,"rateLimited" int,
         auth int,"serverError" int,"networkError" int,other int)
       join rate_limit_endpoint_policies ep on ep.endpoint=r.endpoint
       join rate_limit_states l on l.policy=ep.policy
       where ep.endpoint in ('trade-search','trade-fetch') group by ep.policy
     ), global_slot as (
       select (select max(last_started_at) from collector_schedule where scraping_priority is not null)
         + greatest(interval '57 seconds' / nullif(sum(starts_per_minute),0),
           interval '1 millisecond' * (select max(ms_per_target) from policy_cost)) as due from pools
     ), scheduled as (
       select s.id, s.kind, s.interval_minutes, s.retry_at, s.last_error, s.leased_until,
              p.cycle_id, s.scraping_priority, s.league_id as pool_league_id, s.settled_cycle_id, s.settled_with_error,
              s.payload->>'discovery' = 'true' as discovery,
              greatest(s.next_due_at, s.retry_at) as raw_due,
              greatest(case when (controls.request->'pending') ? s.id::text and p.cycle_id is not null
                  then coalesce(p.next_slot,$1) else s.next_due_at end, s.retry_at, s.leased_until,
                case when p.cycle_id is not null then global_slot.due end,
                p.last_start + interval '57 seconds' / nullif(p.starts_per_minute,0),
                case when s.kind = 'trade-target' then (select blocked_until from cooldown) end,
                case when s.kind = 'trade-target' then (select until from pacing) end) as due,
              coalesce((controls.request->'pending') ? s.id::text, false) as pending,
              (s.scraping_priority is null or (p.cycle_id is not null and p.paused_at is null
                and (s.settled_cycle_id is distinct from p.cycle_id or (controls.request->'pending') ? s.id::text))) and
              (not $3::boolean or ${nonStandardSchedulePredicate}) and
              (s.kind not in ('trade-target','economy') or
                ${marketCollectionEnabledSql("coalesce((controls.request->'pending') ? s.id::text, false)")}) and
              (s.kind <> 'trade-target' or controls.blocked is null
                or (controls.request->>'recoverTradeAuthentication' = 'true'
                    and (controls.request->'pending') ? s.id::text)) as eligible
       from collector_schedule s cross join controls cross join global_slot
       left join pools p on p.pool_league=s.league_id and p.priority=s.scraping_priority where s.enabled
     ), next as (
       select * from scheduled where eligible
       order by (due <= $1) desc,
                (pending and due <= $1) desc,
                case when due > $1 then 0 when discovery then 3
                     when kind in ('league','economy') then 1 else 2 end,
                due, raw_due, scraping_priority, id limit 1
     ), locks as (
       select pid, granted from pg_locks
       where locktype = 'advisory' and mode = 'ExclusiveLock' and objsubid = 1
         and database = (select oid from pg_database where datname = current_database())
         and ((classid::bigint << 32) | objid::bigint) = hashtext('poe-worksmith:collector')::bigint
     )
     select next.id, next.cycle_id as "poolCycleId", next.due as "nextDueAt",
            (select min(cycle_end) from pools where next_slot is null and paused_at is null and cycle_end > $1) as "nextCycleAt",
            case when $4 then coalesce((select jsonb_agg(to_jsonb(stats) order by stats.league, stats.priority)
              from (
                select l.name as league, p.priority, p.period_minutes as "periodMinutes",
                  count(*) as targets,
                  count(*) filter (where s.settled_cycle_id=p.cycle_id and not s.settled_with_error) as checked,
                  count(*) filter (where s.settled_cycle_id=p.cycle_id and s.settled_with_error) as errors,
                  min(s.due) filter (where s.eligible) as "nextSlotAt",
                  case when bool_and(s.settled_cycle_id is not distinct from p.cycle_id) then 0
                    else greatest(0,floor(extract(epoch from (coalesce(p.paused_at,$1)-p.started_at-make_interval(mins => p.period_minutes))))) end as "overdueSeconds",
                  coalesce((array_agg(case when s.due <= $1 then 'ready'
                    when s.due=(select blocked_until from cooldown) then 'cooldown'
                    when s.due=(select until from pacing) then 'pacing'
                    when s.due=s.leased_until then 'lease' when s.due=s.retry_at then 'retry'
                    else 'slot' end order by s.due,s.id) filter (where s.eligible))[1],
                    case when p.paused_at is not null or controls.paused then 'paused'
                      when bool_and(s.settled_cycle_id is not distinct from p.cycle_id) then 'complete'
                      when controls.blocked is not null then 'blocked' else 'disabled' end) as reason
                from scheduled s join collector_trade_pool p on p.cycle_id=s.cycle_id
                  and p.league_id=s.pool_league_id and p.priority=s.scraping_priority
                join poe_leagues l on l.id=p.league_id
                where not $3 or l.ggg_id<>'Standard'
                group by p.league_id, p.priority, l.name
              ) stats), '[]'::jsonb) end as "tradePools",
            (select count(*)::int from scheduled) as enabled,
            (select count(*)::int from scheduled where (cycle_id is null or eligible) and raw_due <= $1 and
               (leased_until is null or leased_until <= $1)) as due,
            (select min(raw_due) from scheduled where (cycle_id is null or eligible) and raw_due <= $1 and
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
    [now, request ?? null, skipStandard, includePools],
  );
  return rows[0]!;
}
