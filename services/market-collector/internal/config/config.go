package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL, InstanceID, HTTPAddr, Source string
	Enabled                                   bool
	PollInterval, RequestTimeout              time.Duration
	Concurrency                               int
}

func Load() (Config, error) {
	c := Config{DatabaseURL: os.Getenv("DATABASE_URL"), InstanceID: os.Getenv("COLLECTOR_INSTANCE_ID"), HTTPAddr: os.Getenv("COLLECTOR_HTTP_ADDR"), Source: os.Getenv("COLLECTOR_SOURCE"), PollInterval: 5 * time.Second, RequestTimeout: 30 * time.Second, Concurrency: 1}
	if c.Source == "" {
		c.Source = "fake"
	}
	if c.Source != "fake" {
		return c, fmt.Errorf("COLLECTOR_SOURCE must be fake; live providers are not enabled in this build")
	}
	if raw := os.Getenv("COLLECTOR_ENABLED"); raw != "" {
		if raw != "true" && raw != "false" {
			return c, fmt.Errorf("COLLECTOR_ENABLED must be true or false")
		}
		c.Enabled = raw == "true"
	}
	if c.DatabaseURL == "" || c.InstanceID == "" {
		return c, fmt.Errorf("DATABASE_URL and COLLECTOR_INSTANCE_ID are required")
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return c, fmt.Errorf("DATABASE_URL must be a PostgreSQL URL")
	}
	host := strings.ToLower(u.Hostname())
	neon := strings.HasSuffix(host, ".neon.tech") || host == "neon.tech"
	if neon && os.Getenv("DATABASE_SSL_MODE") != "require" {
		return c, fmt.Errorf("hosted Neon requires DATABASE_SSL_MODE=require")
	}
	if os.Getenv("DATABASE_SSL_MODE") == "require" {
		q := u.Query()
		q.Set("sslmode", "require")
		u.RawQuery = q.Encode()
		c.DatabaseURL = u.String()
	}
	if raw := os.Getenv("COLLECTOR_POLL_INTERVAL"); raw != "" {
		c.PollInterval, err = time.ParseDuration(raw)
		if err != nil || c.PollInterval < time.Second || c.PollInterval > time.Minute {
			return c, fmt.Errorf("COLLECTOR_POLL_INTERVAL must be 1s..1m")
		}
	}
	if raw := os.Getenv("COLLECTOR_REQUEST_TIMEOUT"); raw != "" {
		c.RequestTimeout, err = time.ParseDuration(raw)
		if err != nil || c.RequestTimeout < time.Second || c.RequestTimeout > 5*time.Minute {
			return c, fmt.Errorf("COLLECTOR_REQUEST_TIMEOUT must be 1s..5m")
		}
	}
	if raw := os.Getenv("COLLECTOR_CONCURRENCY"); raw != "" {
		c.Concurrency, err = strconv.Atoi(raw)
		if err != nil || c.Concurrency < 1 || c.Concurrency > 8 {
			return c, fmt.Errorf("COLLECTOR_CONCURRENCY must be 1..8")
		}
	}
	if c.HTTPAddr == "" {
		c.HTTPAddr = ":8081"
	}
	return c, nil
}
