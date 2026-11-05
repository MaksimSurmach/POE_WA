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
