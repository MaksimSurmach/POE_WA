CREATE TABLE "collector_trade_pool" (
	"league_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"period_minutes" integer NOT NULL,
	"cycle_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"members" uuid[] NOT NULL,
	CONSTRAINT "collector_trade_pool_league_id_priority_pk" PRIMARY KEY("league_id","priority"),
	CONSTRAINT "trade_pool_valid" CHECK ("collector_trade_pool"."priority" between 1 and 7 and "collector_trade_pool"."period_minutes" > 0)
);
--> statement-breakpoint
ALTER TABLE "collector_schedule" ADD COLUMN "scraping_priority" integer;--> statement-breakpoint
ALTER TABLE "collector_schedule" ADD COLUMN "settled_cycle_id" uuid, ADD COLUMN "settled_with_error" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "collector_trade_pool" ADD CONSTRAINT "collector_trade_pool_league_id_poe_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."poe_leagues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
UPDATE collector_schedule SET scraping_priority =
  CASE WHEN jsonb_typeof(payload->'outputRecipeIds') = 'array'
    AND payload->'outputRecipeIds' <> '[]'::jsonb THEN 1 ELSE 2 END
WHERE kind = 'trade-target' AND league_id IS NOT NULL AND payload ? 'recipeIds'
  AND payload->>'discovery' IS DISTINCT FROM 'true';
--> statement-breakpoint
CREATE FUNCTION reconcile_trade_pools(at_time timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  cfg jsonb;
  periods jsonb;
  paused boolean;
  g record;
  p collector_trade_pool%rowtype;
  anchor timestamptz;
  cutoff timestamptz;
  period_min integer;
  rollover boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('poe-worksmith:collector-schedule-sync'));
  SELECT settings INTO cfg FROM market_admin_settings WHERE id=1;
  periods := coalesce(cfg->'tradePoolMinutes','{"1":180,"2":720}'::jsonb);
  paused := coalesce((cfg->>'collectionsPaused')::boolean,false);
  DELETE FROM collector_trade_pool p0 WHERE NOT EXISTS
    (SELECT 1 FROM collector_schedule s WHERE s.enabled AND s.league_id=p0.league_id AND s.scraping_priority=p0.priority);
  FOR g IN SELECT league_id, scraping_priority AS priority, array_agg(id ORDER BY id) AS members
    FROM collector_schedule WHERE enabled AND scraping_priority IS NOT NULL
    GROUP BY league_id,scraping_priority ORDER BY league_id,scraping_priority
  LOOP
    period_min := (periods->>g.priority::text)::integer;
    IF period_min IS NULL OR period_min < 1 THEN
      RAISE EXCEPTION 'Missing period for active Trade pool %',g.priority;
    END IF;
    SELECT * INTO p FROM collector_trade_pool WHERE league_id=g.league_id AND priority=g.priority FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO collector_trade_pool(league_id,priority,period_minutes,started_at,members)
        VALUES (g.league_id,g.priority,period_min,at_time,'{}') RETURNING * INTO p;
    END IF;
    anchor := coalesce(p.paused_at,at_time);
    IF NOT paused AND p.paused_at IS NOT NULL THEN
      p.started_at := p.started_at + (at_time - p.paused_at);
      anchor := at_time;
    END IF;
    cutoff := p.started_at + make_interval(mins => period_min);
    rollover := NOT paused AND cutoff <= anchor AND NOT EXISTS (
      SELECT 1 FROM collector_schedule WHERE id=ANY(g.members) AND settled_cycle_id IS DISTINCT FROM p.cycle_id);
    IF NOT rollover AND p.members = g.members AND p.period_minutes=period_min
      AND paused = (p.paused_at IS NOT NULL) THEN CONTINUE; END IF;
    IF rollover THEN
      p.cycle_id := gen_random_uuid();
      p.started_at := anchor;
      cutoff := anchor + make_interval(mins => period_min);
    END IF;
    UPDATE collector_trade_pool SET started_at=p.started_at, cycle_id=p.cycle_id,
      members=g.members, period_minutes=period_min,
      paused_at=CASE WHEN paused THEN anchor END
      WHERE league_id=g.league_id AND priority=g.priority;
    UPDATE collector_schedule SET interval_minutes=period_min
      WHERE id=ANY(g.members) AND interval_minutes<>period_min;
    -- Credit an existing capture when a shared search moves into this pool.
    UPDATE collector_schedule s SET settled_cycle_id=p.cycle_id, settled_with_error=false
      WHERE s.id=ANY(g.members) AND NOT s.id=ANY(p.members) AND EXISTS (SELECT 1 FROM captures c
        WHERE c.schedule_id=s.id AND c.captured_at>=p.started_at AND c.captured_at<=at_time);
    WITH pending AS (
      SELECT id, row_number() OVER (ORDER BY next_due_at,key) AS slot,count(*) OVER () AS remaining
      FROM collector_schedule WHERE id=ANY(g.members) AND settled_cycle_id IS DISTINCT FROM p.cycle_id
        AND (leased_until IS NULL OR leased_until<=at_time)
    )
    UPDATE collector_schedule s SET next_due_at=anchor +
      greatest((cutoff-anchor)/pending.remaining::float8,
        make_interval(mins => period_min)/cardinality(g.members)::float8)
      * (pending.slot - random()*0.05)
    FROM pending WHERE s.id=pending.id;
  END LOOP;
END $$;
--> statement-breakpoint
SELECT reconcile_trade_pools(now());
