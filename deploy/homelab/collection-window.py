#!/usr/bin/env python3
"""Keep the collector stopped outside the configured collection window."""

import json
import os
import subprocess
from contextlib import suppress
from datetime import datetime, timezone
from urllib.request import Request, urlopen


def docker(*args):
    return subprocess.check_output(["docker", *args], timeout=90, text=True)


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(
        os.environ["WORKSMITH_URL"] + path,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)["data"]


def pause(paused):
    settings = api("/api/admin/market/settings")
    if settings["effective"]["collectionsPaused"] != paused:
        api(
            "/api/admin/market/" + ("pause" if paused else "resume"),
            {"version": settings["version"]},
        )
        print("Collections paused" if paused else "Collections resumed")


def in_window(now):
    start = datetime.fromisoformat(os.environ["START_AT"])
    stop = datetime.fromisoformat(os.environ["STOP_AT"])
    if start.tzinfo is None or stop.tzinfo is None or start >= stop:
        raise ValueError("Collection window requires ordered, timezone-aware dates")
    return start <= now < stop


def reconcile(now):
    container = os.environ["COLLECTOR_CONTAINER"]
    info = json.loads(docker("inspect", container))[0]
    running = info["State"]["Running"]
    try:
        active = in_window(now)
        if active and "COLLECTOR_SKIP_STANDARD=true" not in info["Config"]["Env"]:
            raise RuntimeError("Refusing to resume without the Standard collection guard")
        pause(not active)
        if active and not running:
            docker("start", container)
            print("Collector started within collection window")
        elif not active and running:
            docker("stop", "--timeout", "60", container)
            print("Collector stopped outside collection window")
    except Exception:
        # API or configuration failure must never leave an unsupervised collector.
        with suppress(Exception):
            pause(True)
        docker("stop", "--timeout", "60", container)
        raise


if __name__ == "__main__":
    reconcile(datetime.now(timezone.utc))
