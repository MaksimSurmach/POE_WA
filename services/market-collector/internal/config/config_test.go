package config

import "testing"

func TestLoadRequiresPostgresAndBounds(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/db")
	t.Setenv("COLLECTOR_INSTANCE_ID", "test")
	t.Setenv("COLLECTOR_CONCURRENCY", "9")
	if _, err := Load(); err == nil {
		t.Fatal("expected concurrency bound validation")
	}
	t.Setenv("COLLECTOR_CONCURRENCY", "1")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Concurrency != 1 {
		t.Fatalf("unexpected concurrency %d", c.Concurrency)
	}
}

func TestLoadRejectsLiveSourceAndInvalidEnabled(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/db")
	t.Setenv("COLLECTOR_INSTANCE_ID", "test")
	t.Setenv("COLLECTOR_SOURCE", "public-stash")
	if _, err := Load(); err == nil {
		t.Fatal("expected live source to remain disabled")
	}
	t.Setenv("COLLECTOR_SOURCE", "fake")
	t.Setenv("COLLECTOR_ENABLED", "yes")
	if _, err := Load(); err == nil {
		t.Fatal("expected strict enabled validation")
	}
}

func TestHomeAssistantOptions(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("COLLECTOR_INSTANCE_ID", "")
	t.Setenv("COLLECTOR_ENABLED", "")
	t.Setenv("COLLECTOR_SOURCE", "")
	cfg, err := load(&appOptions{DatabaseURL: "postgresql://test@db.neon.tech/worksmith_test", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Enabled || cfg.InstanceID != "home-assistant" || cfg.DatabaseURL != "postgresql://test@db.neon.tech/worksmith_test?sslmode=verify-full" {
		t.Fatal("expected Home Assistant options and verified Neon TLS")
	}
}

func TestRejectsDatabaseHostOverride(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/db?host=example.neon.tech&sslmode=disable")
	t.Setenv("COLLECTOR_INSTANCE_ID", "test")
	if _, err := load(nil); err == nil {
		t.Fatal("PostgreSQL query parameters must not override the validated host")
	}
}

func TestHomeAssistantCanStartInStandbyWithoutDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("COLLECTOR_ENABLED", "")
	cfg, err := load(&appOptions{})
	if err != nil || cfg.Enabled || cfg.DatabaseURL != "" {
		t.Fatal("expected an inactive Home Assistant app without a database")
	}
}

func TestFakeCollectorRejectsSharedDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("COLLECTOR_ENABLED", "")
	for _, dsn := range []string{
		"postgresql://localhost/worksmith",
		"postgresql://localhost/worksmith_test?dbname=worksmith",
	} {
		if _, err := load(&appOptions{DatabaseURL: dsn, Enabled: true}); err == nil {
			t.Fatal("enabled fake source must require a test database")
		}
	}
}
