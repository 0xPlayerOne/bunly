#!/usr/bin/env python3
"""Measure matched Bun development/AOT fixtures in an isolated Linux X11 session.

Uses the same release host, source fixture, OS input and idle interval for both
modes. Each observation launches a fresh application process. OS caches are
never flushed. Results are descriptive; no guessed performance budget applies.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import signal
import statistics
import subprocess
import sys
import time


REPOSITORY = Path(__file__).resolve().parents[1]
DRIVER = REPOSITORY / "scripts/quality/native-input-linux.py"
DRIVER_SPEC = importlib.util.spec_from_file_location("native_input_linux", DRIVER)
NATIVE_INPUT = importlib.util.module_from_spec(DRIVER_SPEC)
DRIVER_SPEC.loader.exec_module(NATIVE_INPUT)


class Unsupported(RuntimeError):
    """The host cannot provide the native measurement environment."""


def machine_metadata():
    model = "unavailable"
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            key, separator, value = line.partition(":")
            if separator and key.strip() == "model name":
                model = value.strip()
                break
    except OSError:
        pass
    return {
        "os": platform.platform(),
        "architecture": platform.machine(),
        "cpu_model": model,
        "logical_cpus": os.cpu_count(),
        "available_cpus": len(os.sched_getaffinity(0))
        if hasattr(os, "sched_getaffinity")
        else None,
        "power_mode": "uncontrolled and unverified; no machine settings changed",
        "github_run_id": os.environ.get("GITHUB_RUN_ID"),
        "runner_environment": os.environ.get("RUNNER_ENVIRONMENT"),
    }


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def distribution(values):
    if not values or any(not math.isfinite(value) or value < 0 for value in values):
        raise ValueError("Metric samples must be finite, nonnegative and nonempty")
    ordered = sorted(values)
    return {
        "samples": len(values),
        "minimum": ordered[0],
        "median": statistics.median(ordered),
        "p95_observed": ordered[math.ceil(len(ordered) * 0.95) - 1],
        "maximum": ordered[-1],
    }


def expected_sources(repository):
    paths = {
        "examples/native-window/main.ts",
        "examples/native-window/content.ts",
        "package.json",
        "bun.lock",
        "bunfig.toml",
        "tsconfig.json",
        "packages/protocol/package.json",
        "packages/runtime/package.json",
        "packages/core/package.json",
        ".bun-version",
        "rust-toolchain.toml",
        "toolchain.json",
        "Cargo.toml",
        "Cargo.lock",
        "native/gpui-host/Cargo.toml",
        "native/protocol/Cargo.toml",
    }
    for directory, extension in [
        ("packages/protocol/src", "ts"),
        ("packages/runtime/src", "ts"),
        ("packages/core/src", "ts"),
        ("native/gpui-host/src", "rs"),
        ("native/protocol/src", "rs"),
    ]:
        paths.update(
            path.relative_to(repository).as_posix()
            for path in (repository / directory).rglob(f"*.{extension}")
        )
    return paths


def verify_sources(repository, manifest):
    records = manifest["source"]["files"]
    names = [record["path"] for record in records]
    if len(names) != len(set(names)) or set(names) != expected_sources(repository):
        raise ValueError(
            "AOT manifest must describe every current application/host source"
        )
    for record in records:
        path = (repository / record["path"]).resolve()
        if not path.is_relative_to(repository.resolve()):
            raise ValueError("Source paths must remain inside the repository")
        if fingerprint(path) != {key: record[key] for key in ["bytes", "sha256"]}:
            raise ValueError(f"Source differs from the AOT build: {record['path']}")


def verify_package(package, repository):
    path = package / "manifest.json"
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("AOT manifest exceeds 4 MiB")
    manifest = json.loads(path.read_text())
    if manifest["schemaVersion"] != 1:
        raise ValueError("Unsupported AOT manifest schema")
    if manifest.get("entrypoint") != "examples/native-window/main.ts":
        raise ValueError("The baseline requires the compiled native-window fixture")
    if manifest["host"].get("placement") != "bundled":
        raise ValueError("The baseline requires the matching bundled native host")
    if manifest["host"]["profile"] != "release":
        raise ValueError(
            "A comparable production baseline requires a release-profile host"
        )
    if (
        manifest["verification"]["aotCompiledProgram"] != "passed"
        or manifest["verification"].get("jitOmission") != "passed"
        or manifest["application"]["inspection"]["hasCompiledProgram"] is not True
    ):
        raise ValueError(
            "AOT compiled-program and JIT-omission inspection must have passed"
        )
    for key, name in [("application", "native-window"), ("host", "bun-native-host")]:
        record = manifest[key]
        if record["file"] != name:
            raise ValueError(f"Unexpected Linux {key} artifact filename")
        artifact = package / name
        if not artifact.resolve().is_relative_to(package.resolve()):
            raise ValueError(
                "Executable artifacts must remain inside the package directory"
            )
        if not os.access(artifact, os.X_OK):
            raise ValueError(f"{name} is not executable")
        if fingerprint(artifact) != {
            item: record[item] for item in ["bytes", "sha256"]
        }:
            raise ValueError(f"{name} differs from its inspected build manifest")
    pins = json.loads((repository / "toolchain.json").read_text())
    if manifest["toolchain"] != pins:
        raise ValueError("The current source and AOT artifact toolchains differ")
    architecture = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    if (
        architecture is None
        or manifest["target"]["os"] != "linux"
        or manifest["target"]["architecture"] != architecture
    ):
        raise ValueError("The AOT artifact does not target this Linux architecture")
    verify_sources(repository, manifest)
    return manifest


def run_trial(command, environment, output, timeout):
    def interrupted(signum, _frame):
        # Preserve the cleanup window if a supervisor repeats termination.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise InterruptedError(f"Native baseline received signal {signum}")

    with output.open("w") as log:
        previous_sigterm = signal.signal(signal.SIGTERM, interrupted)
        process = None
        try:
            process = subprocess.Popen(
                command,
                cwd=REPOSITORY,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            return process.wait(timeout=timeout)
        finally:
            try:
                if process is not None and process.poll() is None:
                    # The driver cleans its own native session before exiting.
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
            finally:
                signal.signal(signal.SIGTERM, previous_sigterm)


def metrics(report):
    measured = report["measurements"]
    values = {
        key: measured[key]
        for key in [
            "time_to_window_observed_ms",
            "time_to_first_paint_report_observed_ms",
            "time_to_expected_initial_paint_report_observed_ms",
            "sampled_peak_tree_rss_bytes",
            "input_start_to_matching_app_event_observed_ms",
            "input_start_to_matching_paint_report_observed_ms",
        ]
    }
    values["idle_median_tree_rss_bytes"] = measured["idle"]["median_tree_rss_bytes"]
    values["idle_maximum_tree_rss_bytes"] = measured["idle"]["maximum_tree_rss_bytes"]
    values["os_close_to_app_exit_observed_ms"] = (
        measured["application_exit_observed_ms"] - measured["os_close_requested_ms"]
    )
    for value in values.values():
        distribution([value])
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--package", type=Path, required=True, help="Inspected AOT package"
    )
    parser.add_argument("--bun", type=Path, required=True, help="Pinned Bun executable")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--idle-seconds", type=float, default=2)
    parser.add_argument(
        "--timeout", type=float, default=30, help="Per-trial driver deadline"
    )
    args = parser.parse_args()
    if not 3 <= args.samples <= 30 or not 0 <= args.warmups <= 5:
        parser.error("Use 3 to 30 measured samples and 0 to 5 warm-ups per mode")
    if not 1 <= args.idle_seconds <= 10 or not 15 <= args.timeout <= 60:
        parser.error("Use 1 to 10 idle seconds and a 15 to 60 second trial deadline")
    args.output = args.output.resolve()
    args.package = args.package.resolve()
    args.bun = args.bun.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    summary = {
        "schema_version": 1,
        "status": "failed",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "platform": machine_metadata(),
        "methodology": {
            "samples_per_mode": args.samples,
            "warmups_per_mode": args.warmups,
            "idle_seconds": args.idle_seconds,
            "order": "development/AOT, alternating measured order each repetition",
            "launch": "fresh application and native-host processes for every trial",
            "cache": "OS page cache uncontrolled; no cache flushes",
            "input": "XTest pointer click; the same native button and Bun update",
            "fixture": "BN1 public application API; complete initial and changed native tree snapshots",
            "renderer": "software GPU, actual adapter must match across trials",
            "rss": "sum of process RSS; shared pages may be counted more than once",
            "timing": "driver observations at nominal 100 ms polling; no presentation timestamps",
            "p95": "nearest rank of observed samples; small samples do not establish a population tail",
            "budgets": "none; correctness failures stop the run",
        },
        "unsupported_metrics": [
            "controlled cold-cache startup",
            "startup-to-interactive without the deliberate idle interval",
            "display-presentation or physical-input latency",
            "true peak memory between samples",
            "CPU/GPU utilization and power",
            "long-term leaks and development reload",
            "installed/download size including system libraries",
        ],
        "trials": [],
    }
    started = time.monotonic()
    try:
        if sys.platform != "linux" or not os.environ.get("DISPLAY"):
            raise Unsupported("Run inside a dedicated Linux X11/window-manager session")
        manifest = verify_package(args.package, REPOSITORY)
        revision = subprocess.run(
            [str(args.bun), "--revision"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
        if revision != manifest["toolchain"]["bun"]["cliRevision"]:
            raise ValueError("Development Bun does not match the AOT compiler revision")
        summary["provenance"] = {
            "aot_manifest": str(args.package / "manifest.json"),
            "manifest_fingerprint": fingerprint(args.package / "manifest.json"),
            "manifest": manifest,
            "driver_fingerprint": fingerprint(DRIVER),
            "baseline_fingerprint": fingerprint(Path(__file__)),
            "session_fingerprint": fingerprint(
                REPOSITORY / "scripts/quality/native-linux-session.sh"
            ),
            "baseline_command": [sys.executable, *sys.argv],
            "bun_revision": revision,
            "native_host_profile": "release; caller-supplied build provenance in manifest",
        }
        summary["artifact_bytes"] = {
            "application": manifest["application"]["bytes"],
            "native_host": manifest["host"]["bytes"],
            "two_executable_payload": manifest["application"]["bytes"]
            + manifest["host"]["bytes"],
        }
        summary["aot_compile_wall_ms"] = manifest["buildMs"]
        commands = {
            "development": [
                str(args.bun),
                str(REPOSITORY / "examples/native-window/main.ts"),
            ],
            "aot": [str(args.package / "native-window")],
        }
        environment = dict(
            os.environ,
            BUN_NATIVE_HOST=str(args.package / "bun-native-host"),
            BUN_NATIVE_HOST_PROFILE="release",
        )
        samples = {mode: [] for mode in commands}
        renderer = None
        for phase, count in [("warmup", args.warmups), ("measured", args.samples)]:
            for index in range(count):
                modes = list(commands)
                if index % 2:
                    modes.reverse()
                for mode in modes:
                    name = f"{phase}-{index + 1:02d}-{mode}"
                    output = args.output / name
                    command = [
                        sys.executable,
                        str(DRIVER),
                        "--output",
                        str(output),
                        "--mode",
                        mode,
                        "--timeout",
                        str(args.timeout),
                        "--idle-seconds",
                        str(args.idle_seconds),
                        "--expect-software-renderer",
                        "--title",
                        "Bun Native BN1",
                        "--expect-initial-render",
                        json.dumps(NATIVE_INPUT.fixture_paint(1, "Clicks: 0")),
                        "--click",
                        "100",
                        "130",
                        "--expect-event",
                        '{"type":"click","stage":"bun-application","sequence":1,"target":"increment"}',
                        "--expect-render",
                        json.dumps(NATIVE_INPUT.fixture_paint(2, "Clicks: 1")),
                        "--",
                        *commands[mode],
                    ]
                    exit_code = run_trial(
                        command,
                        environment,
                        args.output / f"{name}.log",
                        args.timeout + 20,
                    )
                    report = json.loads((output / "result.json").read_text())
                    summary["trials"].append(
                        {
                            "mode": mode,
                            "phase": phase,
                            "path": name,
                            "status": report["status"],
                        }
                    )
                    if exit_code != 0 or report["status"] != "passed":
                        raise RuntimeError(
                            f"Native correctness failed for {name}; inspect its raw evidence"
                        )
                    gpu = report["renderer"]["gpu"]
                    if renderer is not None and gpu != renderer:
                        raise RuntimeError(
                            "The actual renderer changed between matched trials"
                        )
                    renderer = gpu
                    if phase == "measured":
                        samples[mode].append(metrics(report))
                    print(json.dumps({"trial": name, "status": "passed"}), flush=True)
        verify_sources(REPOSITORY, manifest)
        summary["renderer"] = renderer
        summary["metrics"] = {
            mode: {
                key: distribution([trial[key] for trial in trials]) for key in trials[0]
            }
            for mode, trials in samples.items()
        }
        summary["status"] = "passed"
    except Unsupported as error:
        summary.update(status="unsupported", error=str(error))
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as error:
        summary["error"] = str(error)
    finally:
        summary["elapsed_seconds"] = time.monotonic() - started
        (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "status": summary["status"],
                    "summary": str(args.output / "summary.json"),
                }
            )
        )
    return (
        0
        if summary["status"] == "passed"
        else 2
        if summary["status"] == "unsupported"
        else 1
    )


if __name__ == "__main__":
    sys.exit(main())
