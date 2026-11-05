package main

import (
	"cmp"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/poe-worksmith/market-collector/internal/config"
	"github.com/poe-worksmith/market-collector/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid collector configuration", "error_code", "CONFIG", "reason", err.Error())
		os.Exit(2)
	}
	var pool *pgxpool.Pool
	if cfg.DatabaseURL != "" {
		poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
		if err != nil {
			slog.Error("database pool initialization failed", "error_code", "DB_CONFIG")
			os.Exit(1)
		}
		poolConfig.MaxConns = 3
		poolConfig.ConnConfig.ConnectTimeout = 5 * time.Second
		pool, err = pgxpool.NewWithConfig(ctx, poolConfig)
		if err != nil {
			slog.Error("database pool initialization failed", "error_code", "DB_CONFIG")
			os.Exit(1)
		}
		defer pool.Close()
	}
	instance, enabled := cfg.InstanceID, cfg.Enabled
	version := cmp.Or(os.Getenv("COLLECTOR_VERSION"), "dev")
	slog.Info("collector started", "instance_id", instance, "version", version, "source", cfg.Source, "enabled", enabled)
	var owned atomic.Bool
	statusToken := os.Getenv("COLLECTOR_STATUS_TOKEN")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		if pool == nil {
			http.Error(w, "database unconfigured", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		var compatible bool
		err := pool.QueryRow(ctx, `select count(*)=8 from information_schema.columns where table_schema='public' and (table_name,column_name) in (('market_collection_requests','id'),('market_collection_requests','state'),('market_collection_requests','run_id'),('market_collection_workers','instance_id'),('market_collection_workers','state'),('market_collection_ownership','owner_epoch'),('market_collection_runs','runner_id'),('market_collection_runs','owner_epoch'))`).Scan(&compatible)
		if err != nil || !compatible {
			http.Error(w, "collector schema unavailable", http.StatusServiceUnavailable)
			return
		}
		if enabled {
			var valid bool
			err := pool.QueryRow(ctx, `select owner_instance_id=$1 and lease_expires_at>now() from market_collection_ownership where singleton`, instance).Scan(&valid)
			if err != nil || !valid || !owned.Load() {
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
		state = "disabled"
		if enabled {
			state = "waiting"
			if owned.Load() {
				state = "healthy"
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"instanceId": instance, "enabled": enabled, "state": state})
	})
	server := &http.Server{Addr: cfg.HTTPAddr, Handler: mux, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
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
			ownershipLoop(ctx, store.Store{Pool: pool, Instance: instance, Version: version}, cfg, &owned)
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

func ownershipLoop(ctx context.Context, database store.Store, cfg config.Config, owned *atomic.Bool) {
	ticker := time.NewTicker(cfg.PollInterval)
	defer ticker.Stop()
	var token store.Token
	var lastCode string
	for ctx.Err() == nil {
		tick, cancel := context.WithTimeout(ctx, min(cfg.RequestTimeout, 30*time.Second))
		current, err := database.Tick(tick, token)
		if err == nil {
			if token != current {
				slog.Info("collector lease acquired", "epoch", current.Epoch)
			}
			token = current
			err = database.ProcessFakeRequest(tick, token)
			if err != nil && ctx.Err() == nil {
				health, done := context.WithTimeout(ctx, 3*time.Second)
				_ = database.MarkUnhealthy(health, token)
				done()
			}
		}
		cancel()
		owned.Store(err == nil)
		var code string
		switch {
		case errors.Is(err, store.ErrNotOwner):
			code = "LEASE_HELD"
		case errors.Is(err, store.ErrLegacyRunActive):
			code = "NODE_RUN_ACTIVE"
		case err != nil:
			code = "DB_TICK"
		}
		if code != lastCode && ctx.Err() == nil {
			if code == "" {
				slog.Info("collector polling resumed")
			} else {
				slog.Warn("collector polling interrupted", "error_code", code)
			}
			lastCode = code
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
