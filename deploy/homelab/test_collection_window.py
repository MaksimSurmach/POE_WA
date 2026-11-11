import importlib.util
import json
import os
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "window", Path(__file__).with_name("collection-window.py")
)
window = importlib.util.module_from_spec(spec)
spec.loader.exec_module(window)


class CollectionWindowTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "START_AT": "2026-11-14T00:00:00+01:00",
            "STOP_AT": "2026-12-01T00:00:00+01:00",
            "COLLECTOR_CONTAINER": "fixture-collector",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_exact_window_boundaries_in_utc(self):
        for at, active in [
            ("2026-11-13T22:59:59+00:00", False),
            ("2026-11-13T23:00:00+00:00", True),
            ("2026-11-30T22:59:59+00:00", True),
            ("2026-11-30T23:00:00+00:00", False),
        ]:
            self.assertEqual(window.in_window(datetime.fromisoformat(at)), active)

    def reconcile(self, at, running, guarded=True):
        info = {"State": {"Running": running}, "Config": {"Env":
            ["COLLECTOR_SKIP_STANDARD=true"] if guarded else []}}
        docker = patch.object(window, "docker", side_effect=lambda *args:
            json.dumps([info]) if args[0] == "inspect" else "")
        return docker, datetime.fromisoformat(at)

    def test_starts_only_inside_window(self):
        docker, at = self.reconcile("2026-11-14T00:00:00+01:00", False)
        with docker as run, patch.object(window, "pause") as pause:
            window.reconcile(at)
            pause.assert_called_once_with(False)
            run.assert_any_call("start", "fixture-collector")

    def test_stops_at_end_and_after_reboot(self):
        for at in ["2026-12-01T00:00:00+01:00", "2027-01-01T00:00:00+01:00"]:
            docker, now = self.reconcile(at, True)
            with docker as run, patch.object(window, "pause") as pause:
                window.reconcile(now)
                pause.assert_called_once_with(True)
                run.assert_any_call("stop", "--timeout", "60", "fixture-collector")

    def test_missing_guard_fails_closed(self):
        docker, at = self.reconcile("2026-11-14T00:00:00+01:00", True, False)
        with docker as run, patch.object(window, "pause") as pause:
            with self.assertRaisesRegex(RuntimeError, "Standard collection guard"):
                window.reconcile(at)
            pause.assert_called_once_with(True)
            run.assert_any_call("stop", "--timeout", "60", "fixture-collector")

    def test_api_failure_stops_even_if_resume_failed(self):
        docker, at = self.reconcile("2026-11-14T00:00:00+01:00", True)
        with docker as run, patch.object(window, "pause", side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                window.reconcile(at)
            run.assert_any_call("stop", "--timeout", "60", "fixture-collector")

    def test_does_not_rewrite_unchanged_pause(self):
        with patch.object(window, "api", return_value={
            "version": 23, "effective": {"collectionsPaused": True}
        }) as api:
            window.pause(True)
            api.assert_called_once_with("/api/admin/market/settings")


if __name__ == "__main__":
    unittest.main()
