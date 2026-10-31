"""Headless driver safety tests. These do not verify a native window or input."""

import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/quality/native-input-linux.py"
SPEC = importlib.util.spec_from_file_location("native_input_linux", SCRIPT)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        if hasattr(signal, "SIGALRM"):
            self.previous_alarm_handler = signal.signal(
                signal.SIGALRM, self.deadline_exceeded
            )
            signal.alarm(10)

    def tearDown(self):
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
            signal.signal(signal.SIGALRM, self.previous_alarm_handler)

    @staticmethod
    def deadline_exceeded(_signal, _frame):
        raise TimeoutError("A native harness safety test exceeded its 10-second limit")

    def test_only_new_records_with_matching_nonce_are_eligible(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            old = json.dumps({"nonce": "run", "type": "input", "value": "old"}) + "\n"
            new = json.dumps({"nonce": "run", "type": "input", "value": "new"}) + "\n"
            path.write_text(old + new)
            events = DRIVER.read_events(path, "run", len(old.encode()))
            self.assertEqual([event["value"] for event in events], ["new"])
            self.assertTrue(
                DRIVER.matches(events[0], {"type": "input", "value": "new"})
            )
            self.assertFalse(DRIVER.matches(events[0], {}))
            self.assertFalse(DRIVER.matches(events[0], {"value": "old"}))
            with self.assertRaisesRegex(RuntimeError, "session nonce"):
                DRIVER.read_events(path, "other-run", 0)

    def test_partial_event_is_not_accepted_until_newline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text('{"nonce":"run","type":"rendered"}')
            self.assertEqual(DRIVER.read_events(path, "run", 0), [])
            with path.open("a") as output:
                output.write("\n")
            self.assertEqual(len(DRIVER.read_events(path, "run", 0)), 1)

    def test_paint_requires_native_stage_full_tree_and_matching_revisions(self):
        expected = {
            "type": "rendered",
            "window_id": 1,
            "tree_revision": 2,
            "nodes": [
                {
                    "node_id": 1,
                    "element": {"kind": "box", "style": {}},
                    "children": [2],
                },
                {
                    "node_id": 2,
                    "element": {
                        "kind": "input",
                        "value": "native edit",
                        "placeholder": "",
                        "style": {},
                    },
                    "children": [],
                    "input_revision": 11,
                },
            ],
        }
        painted = {"stage": "native-paint", "nonce": "run", **expected}
        self.assertTrue(DRIVER.matches_paint(painted, expected))
        for change in [
            {"type": "ack"},
            {"stage": "bun-application"},
            {"window_id": 2},
            {"tree_revision": 1},
            {"nodes": expected["nodes"][:1]},
            {"status": "omitted", "reason": "evidence_record_limit"},
        ]:
            with self.subTest(change=change):
                self.assertFalse(DRIVER.matches_paint({**painted, **change}, expected))
        stale = copy.deepcopy(painted)
        stale["nodes"][1]["input_revision"] = 10
        self.assertFalse(DRIVER.matches_paint(stale, expected))
        stale["nodes"][1]["input_revision"] = 11
        stale["nodes"][1]["element"]["value"] = "stale application echo"
        self.assertFalse(DRIVER.matches_paint(stale, expected))

    def test_keyboard_activation_requires_a_distinct_event_sequence(self):
        click = {"type": "click", "target": "increment", "sequence": 1}
        keyboard = {"type": "click", "target": "increment", "sequence": 2}
        self.assertTrue(DRIVER.matches(click, click))
        self.assertFalse(DRIVER.matches(click, keyboard))
        self.assertTrue(DRIVER.matches(keyboard, keyboard))

    def test_evidence_size_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            with path.open("wb") as output:
                output.truncate(DRIVER.MAX_LOG_BYTES + 1)
            with self.assertRaisesRegex(RuntimeError, "4 MiB"):
                DRIVER.read_events(path, "run", 0)

    def test_output_is_drained_but_disk_capture_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stdout.log"
            stream = io.BytesIO(b"x" * (DRIVER.MAX_LOG_BYTES + 128))
            stats = {"written_bytes": 0, "discarded_bytes": 0}
            DRIVER.capture(stream, path, stats)
            self.assertEqual(path.stat().st_size, DRIVER.MAX_LOG_BYTES)
            self.assertEqual(stats["discarded_bytes"], 128)
            self.assertEqual(stream.read(), b"")

    def test_missing_display_never_launches_app_or_claims_aot(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "evidence"
            marker = Path(directory) / "must-not-exist"
            environment = dict(os.environ)
            environment.pop("DISPLAY", None)
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--output",
                    str(output),
                    "--mode",
                    "aot",
                    "--key",
                    "space",
                    "--",
                    sys.executable,
                    "-c",
                    "from pathlib import Path; import sys; Path(sys.argv[1]).touch()",
                    str(marker),
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(marker.exists())
            report = json.loads((output / "result.json").read_text())
            self.assertEqual(report["status"], "unsupported")
            self.assertFalse(report["execution_mode"]["aot_verified_by_driver"])
            self.assertEqual(report["checks"]["window"], "not-run")
            self.assertEqual(report["checks"]["app_input_event"], "unsupported")

    @unittest.skipUnless(
        sys.platform == "linux" and DRIVER.proc_identity_matches(),
        "Linux process IDs and /proc must share a PID namespace",
    )
    def test_real_process_tree_is_observed_and_stopped_without_killing_the_test(self):
        DRIVER.enable_subreaper()
        app = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import subprocess,sys,time\n"
                'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"])\n'
                "print(child.pid,flush=True)\n"
                "time.sleep(30)",
            ],
            stdout=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            ready, _, _ = select.select([app.stdout], [], [], 3)
            self.assertTrue(ready, "Child PID was not reported")
            child = int(app.stdout.readline())
            rows = DRIVER.owned_processes(app.pid, DRIVER.process_table())
            pids = {row["pid"] for row in rows}
            self.assertIn(app.pid, pids)
            self.assertIn(child, pids)
            self.assertNotIn(os.getpid(), pids)
            self.assertGreater(sum(row["rss_bytes"] for row in rows), 0)
            observed = {row["pid"]: row["start_ticks"] for row in rows}
            result = DRIVER.cleanup(app, observed)
            self.assertTrue(result["forced_termination"])
            self.assertEqual(result["remaining_observed_pids"], [])
            self.assertEqual(result["unreaped_observed_pids"], [])
            self.assertIsNotNone(app.returncode)
        finally:
            if app.poll() is None:
                os.killpg(app.pid, signal.SIGKILL)
                app.wait(timeout=3)
            app.stdout.close()


if __name__ == "__main__":
    unittest.main()
