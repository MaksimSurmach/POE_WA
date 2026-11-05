package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotOwner        = errors.New("collector ownership is held by another instance")
	ErrLegacyRunActive = errors.New("legacy Node collection runs must drain before Go ownership")
)

type Store struct {
	Pool     *pgxpool.Pool
	Instance string
}
type Token struct {
	Instance string
	Epoch    int64
}

// Tick renews/takes over the singleton lease and records liveness in one transaction.
func (s Store) Tick(ctx context.Context) (Token, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Token{}, err
	}
	defer tx.Rollback(context.Background())
	var owner *string
	var epoch int64
	var active bool
	if err = tx.QueryRow(ctx, `select owner_instance_id,owner_epoch,coalesce(lease_expires_at>now(),false) from market_collection_ownership where singleton for update`).Scan(&owner, &epoch, &active); err != nil {
		return Token{}, err
	}
	if owner != nil && *owner != s.Instance && active {
		return Token{}, ErrNotOwner
	}
	if owner == nil || *owner != s.Instance || !active {
		var legacyRunActive bool
		if err = tx.QueryRow(ctx, `select exists(select 1 from market_collection_runs where status='running' and runner_id is null)`).Scan(&legacyRunActive); err != nil {
			return Token{}, err
		}
		if legacyRunActive {
			return Token{}, ErrLegacyRunActive
		}
		epoch++
	}
	if _, err = tx.Exec(ctx, `update market_collection_ownership set owner_instance_id=$1,owner_epoch=$2,lease_expires_at=now()+interval '90 seconds' where singleton`, s.Instance, epoch); err != nil {
		return Token{}, err
	}
	if _, err = tx.Exec(ctx, `insert into market_collection_workers(instance_id,version,state,active_runs) values($1,'dev','healthy',0) on conflict(instance_id) do update set heartbeat_at=now(),state='healthy',last_error_code=null`, s.Instance); err != nil {
		return Token{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Token{}, err
	}
	return Token{Instance: s.Instance, Epoch: epoch}, nil
}

// ProcessFakeRequest makes a demo-only empty run; it publishes no research snapshot.
func (s Store) ProcessFakeRequest(ctx context.Context, token Token) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = assertOwner(ctx, tx, token); err != nil {
		return err
	}
	var controlsRaw []byte
	var paused, scheduled, automatic bool
	if err = tx.QueryRow(ctx, `select settings from market_admin_settings where id=1 for share`).Scan(&controlsRaw); err == nil {
		var controls struct {
			CollectionsPaused          bool `json:"collectionsPaused"`
			ScheduledCollectionEnabled bool `json:"scheduledCollectionEnabled"`
			AutomaticRefreshEnabled    bool `json:"automaticRefreshEnabled"`
		}
		if err = json.Unmarshal(controlsRaw, &controls); err != nil {
			return err
		}
		paused, scheduled, automatic = controls.CollectionsPaused, controls.ScheduledCollectionEnabled, controls.AutomaticRefreshEnabled
	} else if err != pgx.ErrNoRows {
		return err
	}
	var requestID, targetID string
	var requestedBy *string
	var profileRaw []byte
	var digest string
	trigger := "manual"
	err = tx.QueryRow(ctx, `select r.id,r.target_id,r.requested_by,t.profile,t.digest
		from market_collection_requests r join market_targets t on t.id=r.target_id
		where r.state='queued'
		  and (not $1 or r.requested_by='recipe-refresh')
		  and not exists (select 1 from market_collection_settings s where s.target_id=r.target_id and s.paused)
		order by r.requested_at,r.id limit 1 for update of r skip locked`, paused).Scan(&requestID, &targetID, &requestedBy, &profileRaw, &digest)
	if err == pgx.ErrNoRows {
		if paused || !scheduled || !automatic {
			return nil
		}
		err = tx.QueryRow(ctx, `select t.id,t.profile,t.digest from market_collection_settings s join market_targets t on t.id=s.target_id where s.enabled and not s.paused and s.next_run_at<=now() order by s.next_run_at,s.target_id limit 1 for update of s skip locked`).Scan(&targetID, &profileRaw, &digest)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		trigger = "scheduled"
		if _, err = tx.Exec(ctx, `with next as (select now() as updated_at, now()+interval_minutes*interval '1 minute' as next_run_at from market_collection_settings where target_id=$1)
			update market_collection_settings s set next_run_at=n.next_run_at,updated_at=n.updated_at,
			payload=jsonb_set(jsonb_set(s.payload,'{nextRunAt}',to_jsonb(to_char(n.next_run_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),true),'{updatedAt}',to_jsonb(to_char(n.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),true)
			from next n where s.target_id=$1`, targetID); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if paused && (requestedBy == nil || *requestedBy != "recipe-refresh") {
		return nil
	}
	var target struct {
		League string `json:"league"`
		Patch  string `json:"patch"`
	}
	if err = json.Unmarshal(profileRaw, &target); err != nil {
		return err
	}
	if target.League == "" || target.Patch == "" {
		return errors.New("stored target contract invalid")
	}
	now := time.Now().UTC()
	id := newUUID()
	sum := sha256.Sum256(profileRaw)
	queryDigest := hex.EncodeToString(sum[:])
	// There is no provider traffic in this slice. This deliberately empty demo run is never a snapshot or price input.
	payload := map[string]any{"rawAvailable": true, "id": id, "targetId": targetID, "targetDigest": digest, "league": target.League, "patch": target.Patch, "sourceId": "demo", "queryDigest": queryDigest, "dataKind": "demo", "trigger": trigger, "status": "empty", "coverage": "partial", "reportedTotal": nil, "returnedCount": 0, "fetchedCount": 0, "cached": false, "currency": nil, "listings": []any{}, "startedAt": now, "capturedAt": nil, "completedAt": now, "batchCount": 0, "listingCount": 0, "errorCode": nil, "retryAt": nil, "snapshotId": nil, "cancelRequested": false}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `insert into market_collection_runs(id,target_id,target_digest,league,patch,status,trigger,started_at,heartbeat_at,completed_at,payload,runner_id,owner_epoch) values($1,$2,$3,$4,$5,'empty',$6,$7,$7,$7,$8::jsonb,$9,$10)`, id, targetID, digest, target.League, target.Patch, trigger, now, string(encoded), token.Instance, token.Epoch); err != nil {
		return err
	}
	if trigger == "manual" {
		if _, err = tx.Exec(ctx, `update market_collection_requests set state='completed',run_id=$2,claim_owner=$3,claimed_at=now() where id=$1 and state='queued'`, requestID, id, token.Instance); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s Store) Drain(ctx context.Context, token Token) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = assertOwner(ctx, tx, token); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `update market_collection_workers set state='draining',heartbeat_at=now() where instance_id=$1`, token.Instance); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `update market_collection_ownership set lease_expires_at=now() where singleton and owner_instance_id=$1 and owner_epoch=$2`, token.Instance, token.Epoch); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func assertOwner(ctx context.Context, tx pgx.Tx, token Token) error {
	var instance string
	var epoch int64
	var active bool
	err := tx.QueryRow(ctx, `select owner_instance_id,owner_epoch,coalesce(lease_expires_at>now(),false) from market_collection_ownership where singleton for update`).Scan(&instance, &epoch, &active)
	if err != nil {
		return err
	}
	if instance != token.Instance || epoch != token.Epoch || !active {
		return ErrNotOwner
	}
	return nil
}
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
