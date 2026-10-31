"""Baseline provenance and subprocess safety; no fixture is claimed as AOT/native."""

import importlib.util
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "benchmarks/native-baseline.py"
SPEC = importlib.util.spec_from_file_location("native_baseline", SCRIPT)
BASELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASELINE)


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.repository = root / "repository"
        self.package = root / "package"
        self.repository.mkdir()
        self.package.mkdir()
        for directory in ["core", "protocol", "runtime"]:
            path = self.repository / f"packages/{directory}/src/index.ts"
            path.parent.mkdir(parents=True)
            path.write_text("source fixture\n")
        for relative in BASELINE.expected_sources(self.repository):
            path = self.repository / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("source fixture\n")
        pins = {"bun": {"cliRevision": "fixture"}}
        (self.repository / "toolchain.json").write_text(json.dumps(pins))
        self.manifest = {
            "schemaVersion": 1,
            "entrypoint": "examples/native-window/main.ts",
            "verification": {"aotCompiledProgram": "passed", "jitOmission": "passed"},
            "target": {
                "os": "linux",
                "architecture": {"x86_64": "x64", "aarch64": "arm64"}.get(
                    platform.machine()
                ),
            },
            "toolchain": pins,
            "source": {
                "files": [
                    {"path": path, **BASELINE.fingerprint(self.repository / path)}
                    for path in sorted(BASELINE.expected_sources(self.repository))
                ]
            },
        }
        for key, name in [
            ("application", "native-window"),
            ("host", "bun-native-host"),
        ]:
            path = self.package / name
            path.write_text("inert provenance fixture; never executed\n")
            os.chmod(path, 0o700)
            self.manifest[key] = {"file": name, **BASELINE.fingerprint(path)}
        self.manifest["host"]["profile"] = "release"
        self.manifest["host"]["placement"] = "bundled"
        self.manifest["application"]["inspection"] = {"hasCompiledProgram": True}
        self.save_manifest()

    def save_manifest(self):
        (self.package / "manifest.json").write_text(json.dumps(self.manifest))

    def test_changed_binary_is_rejected_before_any_trial(self):
        (self.package / "native-window").write_text("changed after inspection\n")
        with self.assertRaisesRegex(ValueError, "differs from its inspected build"):
            BASELINE.verify_package(self.package, self.repository)

    def test_changed_development_source_cannot_be_compared_to_old_aot(self):
        (self.repository / "examples/native-window/main.ts").write_text(
            "different workload\n"
        )
        with self.assertRaisesRegex(ValueError, "Source differs from the AOT build"):
            BASELINE.verify_package(self.package, self.repository)

    def test_changed_package_resolution_cannot_be_compared_to_old_aot(self):
        (self.repository / "packages/runtime/package.json").write_text(
            '{"exports":"./different.ts"}\n'
        )
        with self.assertRaisesRegex(ValueError, "Source differs from the AOT build"):
            BASELINE.verify_package(self.package, self.repository)

    def test_core_source_changes_cannot_be_compared_to_old_aot(self):
        (self.repository / "packages/core/src/index.ts").write_text(
            "changed public application behavior\n"
        )
        with self.assertRaisesRegex(ValueError, "Source differs from the AOT build"):
            BASELINE.verify_package(self.package, self.repository)

    def test_manifest_must_include_shared_fixture_content(self):
        self.manifest["source"]["files"] = [
            record
            for record in self.manifest["source"]["files"]
            if record["path"] != "examples/native-window/content.ts"
        ]
        self.save_manifest()
        with self.assertRaisesRegex(
            ValueError, "every current application/host source"
        ):
            BASELINE.verify_package(self.package, self.repository)

    def test_another_compiled_fixture_cannot_be_a_window_baseline(self):
        self.manifest["entrypoint"] = "tests/native/input-race.ts"
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "native-window fixture"):
            BASELINE.verify_package(self.package, self.repository)

    def test_external_host_cannot_be_mistaken_for_the_bundled_baseline(self):
        self.manifest["host"]["placement"] = "external"
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "matching bundled native host"):
            BASELINE.verify_package(self.package, self.repository)

    def test_debug_host_cannot_be_presented_as_production_baseline(self):
        self.manifest["host"]["profile"] = "dev"
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "release-profile host"):
            BASELINE.verify_package(self.package, self.repository)

    def test_unverified_jit_omission_cannot_qualify_as_aot(self):
        self.manifest["verification"]["jitOmission"] = "not-tested"
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "JIT-omission inspection"):
            BASELINE.verify_package(self.package, self.repository)

    def test_manifest_cannot_select_source_paths_outside_repository(self):
        self.manifest["source"]["files"][0]["path"] = "../private.txt"
        self.save_manifest()
        with self.assertRaisesRegex(
            ValueError, "every current application/host source"
        ):
            BASELINE.verify_package(self.package, self.repository)

    def test_missing_display_reports_unsupported_without_executing_artifacts(self):
        output = Path(self.temporary.name) / "unsupported"
        environment = dict(os.environ)
        environment.pop("DISPLAY", None)
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--output",
                str(output),
                "--package",
                str(self.package),
                "--bun",
                str(self.package / "does-not-exist"),
            ],
            env=environment,
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        report = json.loads((output / "summary.json").read_text())
        self.assertEqual(report["status"], "unsupported")
        self.assertEqual(report["trials"], [])

    @unittest.skipUnless(
        sys.platform == "linux" and BASELINE.NATIVE_INPUT.proc_identity_matches(),
        "Linux process IDs and /proc must share a PID namespace",
    )
    def test_supervisor_sigterm_stops_and_reaps_the_running_trial(self):
        BASELINE.NATIVE_INPUT.enable_subreaper()
        log = Path(self.temporary.name) / "trial.log"
        code = """
import importlib.util
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("baseline", sys.argv[1])
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)
try:
    baseline.run_trial(
        [sys.executable, "-c", "import os,time; print(os.getpid(),flush=True); time.sleep(30)"],
        os.environ, Path(sys.argv[2]), 20,
    )
except InterruptedError as error:
    print(str(error), flush=True)
    raise SystemExit(42)
raise SystemExit("Cancellation did not interrupt the running trial")
"""
        supervisor = subprocess.Popen(
            [sys.executable, "-c", code, str(SCRIPT), str(log)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        observed = {}
        try:
            deadline = time.monotonic() + 3
            while not log.exists() or not log.read_text().strip():
                self.assertIsNone(supervisor.poll(), "Supervisor exited before trial")
                if time.monotonic() >= deadline:
                    self.fail(
                        "Supervised child did not report its PID within 3 seconds"
                    )
                time.sleep(0.01)
            child = int(log.read_text().strip())
            table = BASELINE.NATIVE_INPUT.process_table()
            for pid in [supervisor.pid, child]:
                observed[pid] = table[pid]["start_ticks"]
            supervisor.send_signal(signal.SIGTERM)
            stdout, stderr = supervisor.communicate(timeout=5)
            self.assertEqual(supervisor.returncode, 42, stderr)
            self.assertIn("Native baseline received signal", stdout)
            remaining = BASELINE.NATIVE_INPUT.process_table().get(child)
            self.assertTrue(
                remaining is None or remaining["start_ticks"] != observed[child],
                "Cancellation retained the running trial or an unreaped zombie",
            )
        finally:
            if not observed:
                observed = {
                    row["pid"]: row["start_ticks"]
                    for row in BASELINE.NATIVE_INPUT.owned_processes(
                        supervisor.pid, BASELINE.NATIVE_INPUT.process_table()
                    )
                }
            BASELINE.NATIVE_INPUT.cleanup(supervisor, observed)
            supervisor.stdout.close()
            supervisor.stderr.close()


if __name__ == "__main__":
    unittest.main()
