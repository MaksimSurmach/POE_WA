package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/poe-worksmith/market-collector/internal/config"
	"github.com/poe-worksmith/market-collector/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid collector configuration", "error_code", "CONFIG")
		os.Exit(2)
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database pool initialization failed", "error_code", "DB_CONFIG")
		os.Exit(1)
	}
	defer pool.Close()
	instance, enabled := cfg.InstanceID, cfg.Enabled
	statusToken := os.Getenv("COLLECTOR_STATUS_TOKEN")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		var compatible bool
		err := pool.QueryRow(r.Context(), `select count(*)=8 from information_schema.columns where table_schema='public' and (table_name,column_name) in (('market_collection_requests','id'),('market_collection_requests','state'),('market_collection_requests','run_id'),('market_collection_workers','instance_id'),('market_collection_workers','state'),('market_collection_ownership','owner_epoch'),('market_collection_runs','runner_id'),('market_collection_runs','owner_epoch'))`).Scan(&compatible)
		if err != nil || !compatible {
			http.Error(w, "collector schema unavailable", http.StatusServiceUnavailable)
			return
		}
		if enabled {
			var valid bool
			err := pool.QueryRow(r.Context(), `select owner_instance_id=$1 and lease_expires_at>now() from market_collection_ownership where singleton`, instance).Scan(&valid)
			if err != nil || !valid {
				http.Error(w, "ownership unavailable", http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		if statusToken == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+statusToken)) != 1 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		var state string
		var heartbeat *time.Time
		err := pool.QueryRow(r.Context(), `select state, heartbeat_at from market_collection_workers where instance_id=$1`, instance).Scan(&state, &heartbeat)
		if err != nil {
			state = "disabled"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"instanceId": instance, "enabled": enabled, "state": state})
	})
	server := &http.Server{Addr: cfg.HTTPAddr, Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	var workers sync.WaitGroup
	if enabled {
		workers.Add(1)
		go func() {
			defer workers.Done()
			ownershipLoop(ctx, store.Store{Pool: pool, Instance: instance}, cfg.PollInterval)
		}()
	}
	serveErr := server.ListenAndServe()
	stop()
	workers.Wait()
	if serveErr != nil && serveErr != http.ErrServerClosed {
		slog.Error("http server failed", "error_code", "HTTP_SERVER")
		os.Exit(1)
	}
}

func ownershipLoop(ctx context.Context, database store.Store, poll time.Duration) {
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	var token store.Token
	for ctx.Err() == nil {
		current, err := database.Tick(ctx)
		if err == nil {
			token = current
			err = database.ProcessFakeRequest(ctx, token)
		}
		if err != nil {
			slog.Error("collector tick failed", "error_code", "DB_TICK")
		}
		if ctx.Err() != nil {
			break
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
	if token.Instance != "" {
		drain, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := database.Drain(drain, token); err != nil {
			slog.Error("worker drain failed", "error_code", "DB_DRAIN")
		}
	}
}
