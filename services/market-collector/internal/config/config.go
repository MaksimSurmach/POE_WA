package config

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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

type appOptions struct {
	DatabaseURL string `json:"database_url"`
	Enabled     bool   `json:"enabled"`
}

func Load() (Config, error) {
	token := os.Getenv("SUPERVISOR_TOKEN")
	if token == "" {
		return load(nil)
	}
	req, err := http.NewRequest(http.MethodGet, "http://supervisor/addons/self/info", nil)
	if err != nil {
		return Config{}, errors.New("cannot construct Home Assistant options request")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := http.Client{
		Transport: &http.Transport{DisableKeepAlives: true},
		Timeout:   5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return Config{}, errors.New("Home Assistant Supervisor unavailable")
	}
	defer resp.Body.Close()
	var result struct {
		Data struct {
			Options *appOptions `json:"options"`
		} `json:"data"`
	}
	if resp.StatusCode != http.StatusOK ||
		json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&result) != nil ||
		result.Data.Options == nil {
		return Config{}, errors.New("cannot read Home Assistant app options")
	}
	return load(result.Data.Options)
}

func load(options *appOptions) (Config, error) {
	c := Config{DatabaseURL: os.Getenv("DATABASE_URL"), InstanceID: os.Getenv("COLLECTOR_INSTANCE_ID"), HTTPAddr: os.Getenv("COLLECTOR_HTTP_ADDR"), Source: os.Getenv("COLLECTOR_SOURCE"), PollInterval: 5 * time.Second, RequestTimeout: 30 * time.Second, Concurrency: 1}
	if options != nil {
		c.DatabaseURL = cmp.Or(c.DatabaseURL, options.DatabaseURL)
		c.InstanceID = cmp.Or(c.InstanceID, "home-assistant")
		c.Enabled = options.Enabled
	}
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
	var err error
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
		if err != nil || c.Concurrency != 1 {
			return c, fmt.Errorf("COLLECTOR_CONCURRENCY must be 1")
		}
	}
	if c.HTTPAddr == "" {
		c.HTTPAddr = ":8081"
	}

	if options != nil && !c.Enabled && c.DatabaseURL == "" {
		return c, nil
	}
	if c.DatabaseURL == "" || c.InstanceID == "" {
		return c, errors.New("DATABASE_URL and COLLECTOR_INSTANCE_ID are required")
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || strings.Contains(u.Host, ",") {
		return c, fmt.Errorf("DATABASE_URL must be a PostgreSQL URL")
	}
	if c.Enabled && !strings.HasSuffix(u.Path, "_test") {
		return c, errors.New("fake collection requires an isolated database ending in _test")
	}
	host := strings.ToLower(u.Hostname())
	neon := strings.HasSuffix(host, ".neon.tech") || host == "neon.tech"
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || q.Has("host") || q.Has("hostaddr") || q.Has("dbname") || q.Has("database") || q.Has("service") || q.Has("servicefile") {
		return c, errors.New("invalid PostgreSQL connection parameters")
	}
	if neon || os.Getenv("DATABASE_SSL_MODE") == "require" || (options != nil && !q.Has("sslmode")) {
		q.Set("sslmode", "verify-full")
		u.RawQuery = q.Encode()
		c.DatabaseURL = u.String()
	}
	return c, nil
}
