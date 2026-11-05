package store

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDatabaseQueueAndLease(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration")
	}
	u, err := url.Parse(dsn)
	if err != nil || u.Hostname() != "127.0.0.1" || u.Path != "/poe_worksmith_test" {
		t.Fatal("expected the isolated local poe_worksmith_test database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal("cannot open test database")
	}
	defer pool.Close()

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	first := Store{Pool: pool, Instance: newUUID(), Version: "test"}
	second := Store{Pool: pool, Instance: newUUID(), Version: "test"}
	target, request, legacyRun := newUUID(), newUUID(), newUUID()
	digest := strings.Repeat("a", 32) + strings.ReplaceAll(target, "-", "")
	defer func() {
		if _, err := pool.Exec(ctx, `
			delete from market_collection_requests where target_id = $1;
		`, target); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(ctx, `delete from market_collection_runs where target_id = $1`, target); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(ctx, `delete from market_targets where id = $1`, target); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(ctx, `delete from market_collection_workers where instance_id in ($1, $2)`, first.Instance, second.Instance); err != nil {
			t.Error(err)
		}
	}()
	exec(`insert into market_targets(id,digest,profile,created_at) values($1,$2,'{"league":"Standard","patch":"3.27"}',now())`, target, digest)
	exec(`insert into market_collection_requests(id,target_id,requested_by) values($1,$2,'recipe-refresh')`, request, target)

	exec(`insert into market_collection_runs(id,target_id,target_digest,league,patch,status,trigger,started_at,heartbeat_at,payload)
		values($1,$2,$3,'Standard','3.27','running','manual',now(),now(),'{"status":"running"}')`, legacyRun, target, digest)
	if _, err := first.Tick(ctx, Token{}); !errors.Is(err, ErrLegacyRunActive) {
		t.Fatalf("fresh Node run must block Go takeover: %v", err)
	}
	exec(`update market_collection_runs set heartbeat_at=now()-interval '31 minutes' where id=$1`, legacyRun)
	owner, err := first.Tick(ctx, Token{})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Drain(ctx, owner)
	var recovered bool
	err = pool.QueryRow(ctx, `select status='failed' and payload->>'errorCode'='MARKET_COLLECTION_INTERRUPTED'
		from market_collection_runs where id=$1`, legacyRun).Scan(&recovered)
	if err != nil || !recovered {
		t.Fatalf("stale Node run was not recovered: %v", err)
	}
	if err := first.MarkUnhealthy(ctx, owner); err != nil {
		t.Fatal(err)
	}
	var unhealthy bool
	err = pool.QueryRow(ctx, `select state='unhealthy' and last_error_code='DB_TICK'
		from market_collection_workers where instance_id=$1`, first.Instance).Scan(&unhealthy)
	if err != nil || !unhealthy {
		t.Fatalf("worker health was not persisted: %v", err)
	}
	for _, contender := range []Store{first, second} {
		if _, err := contender.Tick(ctx, Token{}); !errors.Is(err, ErrNotOwner) {
			t.Fatalf("duplicate collector acquired lease: %v", err)
		}
	}
	if renewed, err := first.Tick(ctx, owner); err != nil || renewed != owner {
		t.Fatalf("owner could not renew: %v", err)
	}
	for range 2 {
		if err := first.ProcessFakeRequest(ctx, owner); err != nil {
			t.Fatal(err)
		}
	}
	var completed bool
	err = pool.QueryRow(ctx, `
		select r.state = 'completed' and c.runner_id = $2 and c.owner_epoch = $3
			and c.payload->>'dataKind' = 'demo' and c.payload->>'coverage' = 'partial'
			and c.payload->>'snapshotId' is null
			and (select count(*) from market_collection_runs where target_id = r.target_id and runner_id is not null) = 1
		from market_collection_requests r join market_collection_runs c on c.id = r.run_id where r.id = $1`,
		request, owner.Instance, owner.Epoch).Scan(&completed)
	if err != nil || !completed {
		t.Fatalf("expected exactly one completed demo run: %v", err)
	}
	if err := first.Drain(ctx, owner); err != nil {
		t.Fatal(err)
	}
	next, err := second.Tick(ctx, Token{})
	if err != nil || next.Epoch <= owner.Epoch {
		t.Fatalf("expected takeover with new epoch: %v", err)
	}
	defer second.Drain(ctx, next)
	if err := first.ProcessFakeRequest(ctx, owner); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("stale collector wrote after takeover: %v", err)
	}
	_, err = pool.Exec(ctx, `update market_collection_runs set heartbeat_at = now() where target_id = $1 and runner_id = $2`, target, owner.Instance)
	var sqlErr *pgconn.PgError
	if !errors.As(err, &sqlErr) || sqlErr.Code != "55000" {
		t.Fatalf("expected the ownership trigger to reject the stale write: %v", err)
	}
}
