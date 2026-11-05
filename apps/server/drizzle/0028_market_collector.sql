ALTER TABLE market_collection_runs
  ADD COLUMN runner_id text,
  ADD COLUMN owner_epoch bigint;

CREATE TABLE market_collection_requests (
  id uuid PRIMARY KEY,
  target_id uuid NOT NULL REFERENCES market_targets(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','completed','cancelled')),
  claim_owner text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  run_id uuid REFERENCES market_collection_runs(id) ON DELETE SET NULL,
  error_code text,
  CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,100}$')
);
CREATE INDEX market_collection_requests_queue_idx ON market_collection_requests(state, requested_at) WHERE state = 'queued';
CREATE INDEX market_collection_requests_target_idx ON market_collection_requests(target_id, requested_at DESC);

CREATE TABLE market_collection_workers (
  instance_id text PRIMARY KEY,
  version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('starting','healthy','draining','unhealthy')),
  active_runs integer NOT NULL DEFAULT 0 CHECK (active_runs >= 0),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$')
);
CREATE TABLE market_collection_ownership (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_instance_id text,
  owner_epoch bigint NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
  lease_expires_at timestamptz
);
INSERT INTO market_collection_ownership(singleton) VALUES (true);
CREATE TABLE market_collection_checkpoints (
  provider text NOT NULL,
  realm text NOT NULL,
  cursor text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, realm)
);

ALTER TABLE market_research_snapshots
  ADD COLUMN runner_id text,
  ADD COLUMN owner_epoch bigint;

CREATE FUNCTION market_collection_assert_write_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_owner text;
  current_epoch bigint;
  current_expiry timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'market_collection_runs' THEN
    IF TG_OP = 'INSERT' AND NEW.payload->>'sourceId' = 'manual-import' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status <> 'running'
        AND (to_jsonb(NEW) - 'payload') = (to_jsonb(OLD) - 'payload')
        AND NEW.payload = jsonb_set(jsonb_set(OLD.payload - 'searchEvidence', '{listings}', '[]'::jsonb), '{rawAvailable}', 'false'::jsonb) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'market_research_snapshots' THEN
    IF NEW.summary->>'provenance' = 'manual_import' THEN
      IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD)) THEN
        RETURN NEW;
      END IF;
    END IF;
    IF TG_OP = 'UPDATE'
        AND (to_jsonb(NEW) - 'listings' - 'summary') = (to_jsonb(OLD) - 'listings' - 'summary')
        AND NEW.listings = '[]'::jsonb
        AND NEW.summary = jsonb_set(OLD.summary, '{rawAvailable}', 'false'::jsonb) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT owner_instance_id, owner_epoch, lease_expires_at
    INTO current_owner, current_epoch, current_expiry
    FROM market_collection_ownership WHERE singleton FOR SHARE;
  IF NEW.runner_id IS NULL THEN
    IF current_owner IS NOT NULL AND current_expiry > now() THEN
      RAISE EXCEPTION 'Node collection write rejected while Go owner lease is active' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.owner_epoch IS NULL OR NEW.runner_id IS DISTINCT FROM current_owner
      OR NEW.owner_epoch IS DISTINCT FROM current_epoch OR current_expiry IS NULL OR current_expiry <= now() THEN
    RAISE EXCEPTION 'stale market collection owner epoch' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER market_collection_runs_owner_fence
  BEFORE INSERT OR UPDATE ON market_collection_runs
  FOR EACH ROW EXECUTE FUNCTION market_collection_assert_write_owner();
CREATE TRIGGER market_research_snapshots_owner_fence
  BEFORE INSERT OR UPDATE ON market_research_snapshots
  FOR EACH ROW EXECUTE FUNCTION market_collection_assert_write_owner();
