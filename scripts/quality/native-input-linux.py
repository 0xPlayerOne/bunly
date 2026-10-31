#!/usr/bin/env python3
"""Collect real X11 input evidence for an explicitly supplied Bun Native app.

Requires xdotool, ImageMagick's import, an X11 display and an EWMH window manager.
The app receives BUN_NATIVE_EVIDENCE_LOG and BUN_NATIVE_EVIDENCE_NONCE. It may
append JSON objects containing that nonce and its actual native events/render
reports. Only records written after input injection can satisfy expectations.
Screenshots are evidence, never automatically asserted to contain expected text.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time


MAX_LOG_BYTES = 4 * 1024 * 1024


class Unsupported(RuntimeError):
    """The environment cannot perform real native input verification."""


def proc_identity_matches():
    try:
        return int(Path("/proc/self/stat").read_text().split(" ", 1)[0]) == os.getpid()
    except (OSError, ValueError):
        return False


def enable_subreaper():
    """Adopt orphaned descendants so cleanup can reap them without relying on PID1."""
    # Process-local Linux API; no privilege or system-wide setting is changed.
    # https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
    try:
        prctl = ctypes.CDLL(None, use_errno=True).prctl
    except (AttributeError, OSError) as error:
        raise Unsupported("Linux child-subreaper support is unavailable") from error
    prctl.argtypes = [ctypes.c_int, *([ctypes.c_ulong] * 4)]
    prctl.restype = ctypes.c_int
    if prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise Unsupported(
            f"Cannot supervise orphaned children: {os.strerror(ctypes.get_errno())}"
        )


def run(command, timeout=3):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(
            f"{command[0]} exited {result.returncode}: {result.stderr[-2000:]}"
        )
    return result.stdout.strip()


def process_table():
    result = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            result[int(entry.name)] = {
                "pid": int(entry.name),
                "state": fields[0],
                "parent_pid": int(fields[1]),
                "process_group": int(fields[2]),
                "start_ticks": int(fields[19]),
                "rss_bytes": int(fields[21]) * os.sysconf("SC_PAGE_SIZE"),
            }
        except (OSError, ValueError, IndexError, ProcessLookupError):
            continue
    return result


def owned_processes(root_pid, table):
    owned = {root_pid}
    while True:
        children = {
            pid
            for pid, row in table.items()
            if row["parent_pid"] in owned or row["process_group"] == root_pid
        }
        if children.issubset(owned):
            return [row for pid, row in table.items() if pid in owned]
        owned.update(children)


def capture(stream, path, stats):
    with path.open("wb") as output:
        while chunk := stream.read(8192):
            remaining = max(0, MAX_LOG_BYTES - stats["written_bytes"])
            output.write(chunk[:remaining])
            stats["written_bytes"] += min(remaining, len(chunk))
            stats["discarded_bytes"] += max(0, len(chunk) - remaining)


def read_events(path, nonce, offset):
    if not path.exists():
        return []
    if path.stat().st_size > MAX_LOG_BYTES:
        raise RuntimeError("Application event evidence exceeded the 4 MiB limit")
    with path.open("rb") as stream:
        stream.seek(offset)
        data = stream.read(MAX_LOG_BYTES + 1)
    if len(data) > MAX_LOG_BYTES:
        raise RuntimeError("Application event evidence exceeded the 4 MiB limit")
    events = []
    # Ignore an unfinished final record until the next polling pass.
    for line in data.split(b"\n")[:-1]:
        value = json.loads(line)
        if not isinstance(value, dict) or value.get("nonce") != nonce:
            raise RuntimeError(
                "Application evidence has an invalid record or session nonce"
            )
        events.append(value)
    return events


def matches(event, expected):
    return bool(expected) and all(
        event.get(key) == value for key, value in expected.items()
    )


def matches_paint(event, expected):
    return (
        event.get("stage") == "native-paint"
        and event.get("status") != "omitted"
        and matches(event, expected)
    )


def fixture_paint(tree_revision, label, value=""):
    """Independent full-tree expectation shared by native smoke and baseline runs."""
    elements = [
        {
            "kind": "box",
            "style": {
                "direction": "column",
                "gap": 12,
                "padding": 24,
                "background": 0xF4F5F7,
            },
        },
        {"kind": "text", "text": "Bun Native", "style": {"font_size": 28}},
        {"kind": "text", "text": label, "style": {}},
        {
            "kind": "button",
            "text": "Increment",
            "disabled": False,
            "style": {"width": 160, "height": 44},
        },
        {"kind": "text", "text": "Native editable input", "style": {}},
        {
            "kind": "input",
            "value": value,
            "placeholder": "Type here…",
            "style": {"width": "fill", "font_size": 24},
        },
    ]
    nodes = [
        {
            "node_id": index + 1,
            "element": element,
            "children": [2, 3, 4, 5, 6] if index == 0 else [],
        }
        for index, element in enumerate(elements)
    ]
    # The smoke fixture types only ASCII; one native edit per typed character.
    nodes[-1]["input_revision"] = len(value.replace("{nonce}", "0" * 32))
    return {
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": tree_revision,
        "nodes": nodes,
    }


def javascript_fixture_paint(tree_revision, label, value, input_revision):
    state = fixture_paint(tree_revision, label, value)
    state["nodes"][1]["element"]["text"] = "JavaScript consumer"
    state["nodes"][3]["element"]["text"] = "Update"
    state["nodes"][4]["element"]["text"] = "Native input from JavaScript"
    state["nodes"][5]["input_revision"] = input_revision
    return state


def lifecycle_fixture_paint(tree_revision, label):
    state = fixture_paint(tree_revision, label)
    state["nodes"] = state["nodes"][:4]
    state["nodes"][0]["children"] = [2, 3, 4]
    state["nodes"][1]["element"]["text"] = "Public lifecycle"
    state["nodes"][3]["element"]["text"] = "Run 1,000 cycles"
    state["nodes"][3]["element"]["style"]["width"] = 200
    return state


def interrupted(signum, _frame):
    raise InterruptedError(f"Native input driver received signal {signum}")


def cleanup(app, observed):
    """Signal only this launched session and identity-checked observed descendants."""

    def reap_adopted():
        app.poll()
        table = process_table()
        for pid, started in observed.items():
            row = table.get(pid)
            if (
                pid != app.pid
                and row is not None
                and row["start_ticks"] == started
                and row["parent_pid"] == os.getpid()
                and row["state"] == "Z"
            ):
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass

    forced = False
    for sig, grace in [(signal.SIGTERM, 2), (signal.SIGKILL, 1)]:
        reap_adopted()
        table = process_table()
        alive = [
            row
            for pid, row in table.items()
            if pid in observed
            and row["start_ticks"] == observed[pid]
            and row["state"] != "Z"
        ]
        if not alive:
            break
        forced = True
        if any(row["process_group"] == app.pid for row in alive):
            try:
                os.killpg(app.pid, sig)
            except ProcessLookupError:
                pass
        for row in alive:
            if row["process_group"] != app.pid:
                try:
                    os.kill(row["pid"], sig)
                except ProcessLookupError:
                    pass
        try:
            app.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass
        time.sleep(0.1)
    reap_adopted()
    table = process_table()
    remaining = [
        pid
        for pid, started in observed.items()
        if pid in table
        and table[pid]["start_ticks"] == started
        and table[pid]["state"] != "Z"
    ]
    zombies = [
        pid
        for pid, started in observed.items()
        if pid in table
        and table[pid]["start_ticks"] == started
        and table[pid]["state"] == "Z"
    ]
    return {
        "forced_termination": forced,
        "remaining_observed_pids": remaining,
        "unreaped_observed_pids": zombies,
        "application_exit_code": app.poll(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, required=True, help="New evidence directory"
    )
    parser.add_argument(
        "--title", default="Bun Native BN1", help="Exact X11 window title"
    )
    parser.add_argument("--mode", required=True, choices=["development", "aot"])
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument(
        "--idle-seconds",
        type=float,
        default=0,
        help="Sample idle process-tree RSS after first paint, before input (0 to 10)",
    )
    parser.add_argument("--key", action="append", default=[])
    parser.add_argument(
        "--text", help="Text to type; {nonce} expands to this run identifier"
    )
    parser.add_argument("--click", nargs=2, type=int, metavar=("X", "Y"))
    parser.add_argument(
        "--expect-event", action="append", default=[], help="JSON object subset"
    )
    parser.add_argument(
        "--expect-render", help="JSON subset with type=rendered; app-reported only"
    )
    parser.add_argument(
        "--expect-initial-render",
        help="Native paint JSON subset required before idle sampling or input",
    )
    parser.add_argument(
        "--expect-software-renderer",
        action="store_true",
        help="Require the native window to report a software GPU adapter",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not (args.key or args.text is not None or args.click):
        parser.error(
            "supply an app command after -- and at least one --key, --text or --click"
        )
    if not 1 <= args.timeout <= 60:
        parser.error("--timeout must be between 1 and 60 seconds")
    if not 0 <= args.idle_seconds <= 10:
        parser.error("--idle-seconds must be between 0 and 10 seconds")
    if any(not re.fullmatch(r"[A-Za-z0-9_+]+", key) for key in args.key):
        parser.error("--key accepts xdotool key names and + modifiers only")
    if len(args.key) > 16 or (args.text is not None and len(args.text) > 200):
        parser.error("Native smoke input is limited to 16 keys and 200 text characters")
    args.output.mkdir(parents=True, exist_ok=False)
    nonce = secrets.token_hex(16)
    evidence_path = args.output.resolve() / "app-events.jsonl"
    report = {
        "schema_version": 1,
        "status": "failed",
        "nonce": nonce,
        "command": command,
        "execution_mode": {"declared": args.mode, "aot_verified_by_driver": False},
        "verification_scope": "owned X11 window, OS-injected input, application event/paint reports and close",
        "platform": {
            "os": platform.platform(),
            "architecture": platform.machine(),
            "display": os.environ.get("DISPLAY"),
            "display_protocol": "X11",
            "physical_input_tested": False,
            "vulkan_driver_files": os.environ.get("VK_DRIVER_FILES"),
            "software_gl_requested": os.environ.get("LIBGL_ALWAYS_SOFTWARE"),
        },
        "renderer": {"status": "unavailable"},
        "measurements": {
            "rss_method": "sampled sum of process RSS; shared pages may be counted twice",
            "cold_cache_controlled": False,
            "launch_kind": "fresh application process; OS page cache uncontrolled",
            "observation_poll_interval_ms": 100,
            "paint_is_presentation_timestamp": False,
            "samples": [],
        },
        "checks": {
            "window": "not-run",
            "os_input": "not-run",
            "app_input_event": "unsupported",
            "app_initial_render_report": "not-required",
            "app_render_report": "unsupported",
            "pixel_or_text_assertion": "unsupported",
            "os_close": "not-run",
            "renderer": "not-required",
        },
        "logs": {},
        "tools": {"python": sys.version},
    }
    app = None
    threads = []
    observed = {}
    started = time.monotonic()
    previous_sigterm = signal.signal(signal.SIGTERM, interrupted)

    def sample(phase="interaction"):
        rows = owned_processes(app.pid, process_table())
        for row in rows:
            observed[row["pid"]] = row["start_ticks"]
        if len(rows) > 128:
            raise RuntimeError("Application process tree exceeded 128 processes")
        report["measurements"]["samples"].append(
            {
                "elapsed_ms": (time.monotonic() - started) * 1000,
                "phase": phase,
                "tree_rss_bytes": sum(row["rss_bytes"] for row in rows),
                "processes": rows,
            }
        )
        return {row["pid"] for row in rows}

    def observe_first_paint():
        records = read_events(evidence_path, nonce, 0)
        key = "time_to_first_paint_report_observed_ms"
        if key not in report["measurements"] and any(
            event.get("type") == "rendered" and event.get("stage") == "native-paint"
            for event in records
        ):
            report["measurements"][key] = (time.monotonic() - started) * 1000
        return records

    try:
        pin_file = Path(__file__).resolve().parents[2] / "toolchain.json"
        if pin_file.is_file():
            pin_bytes = pin_file.read_bytes()
            pins = json.loads(pin_bytes)
            report["intended_toolchain"] = {
                "manifest_sha256": hashlib.sha256(pin_bytes).hexdigest(),
                "bun_revision": pins["bun"]["revision"],
                "rust": pins["rust"],
                "gpui": pins["gpui"],
            }
        if sys.platform != "linux" or not os.environ.get("DISPLAY"):
            raise Unsupported(
                "A Linux X11 display is required; no native interaction was attempted"
            )
        if not proc_identity_matches():
            raise Unsupported(
                "Process IDs and /proc belong to different namespaces; ownership and RSS cannot be verified"
            )
        enable_subreaper()
        report["platform"]["child_subreaper"] = True
        missing = [tool for tool in ["xdotool", "import"] if not shutil.which(tool)]
        if missing:
            raise Unsupported(
                f"Missing native input/capture tools: {', '.join(missing)}"
            )
        report["tools"] = {
            "python": sys.version,
            "xdotool": run(["xdotool", "version"]),
            "imagemagick": run(["import", "-version"]),
        }
        try:
            report["source"] = {
                "commit": run(["git", "rev-parse", "HEAD"]),
                "dirty": bool(run(["git", "status", "--porcelain"])),
            }
        except (RuntimeError, subprocess.TimeoutExpired):
            report["source"] = {"status": "unavailable"}
        expectations = [
            json.loads(item.replace("{nonce}", nonce)) for item in args.expect_event
        ]
        render = (
            json.loads(args.expect_render.replace("{nonce}", nonce))
            if args.expect_render
            else None
        )
        initial_render = (
            json.loads(args.expect_initial_render.replace("{nonce}", nonce))
            if args.expect_initial_render
            else None
        )
        if any(
            not isinstance(item, dict) or item.get("type") not in ["input", "click"]
            for item in expectations
        ):
            raise RuntimeError(
                "--expect-event must describe an actual input or click event"
            )
        for name, expected in [
            ("--expect-render", render),
            ("--expect-initial-render", initial_render),
        ]:
            if expected is not None and (
                not isinstance(expected, dict)
                or expected.get("type") != "rendered"
                or expected.get("stage", "native-paint") != "native-paint"
            ):
                raise RuntimeError(
                    f"{name} must describe type=rendered from native-paint, never an acknowledgement"
                )
        report["scenario"] = {
            "click": args.click,
            "keys": args.key,
            "text": args.text.replace("{nonce}", nonce)
            if args.text is not None
            else None,
            "expected_events": expectations,
            "expected_initial_render": initial_render,
            "expected_render": render,
        }
        report["native_host"] = {
            "path": os.environ.get("BUN_NATIVE_HOST"),
            "declared_profile": os.environ.get("BUN_NATIVE_HOST_PROFILE", "unreported"),
        }
        environment = dict(
            os.environ,
            BUN_NATIVE_EVIDENCE_LOG=str(evidence_path),
            BUN_NATIVE_EVIDENCE_NONCE=nonce,
        )
        started = time.monotonic()
        deadline = started + args.timeout
        app = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            start_new_session=True,
        )
        sample("startup")
        for name, stream in [("stdout", app.stdout), ("stderr", app.stderr)]:
            stats = {"written_bytes": 0, "discarded_bytes": 0}
            report["logs"][name] = stats
            thread = threading.Thread(
                target=capture,
                args=(stream, args.output / f"{name}.log", stats),
                daemon=True,
            )
            thread.start()
            threads.append(thread)
        window = None
        while time.monotonic() < deadline:
            owned = sample("startup")
            observe_first_paint()
            if app.poll() is not None:
                raise RuntimeError(
                    f"Application exited before opening its window: {app.returncode}"
                )
            search = subprocess.run(
                [
                    "xdotool",
                    "search",
                    "--onlyvisible",
                    "--name",
                    f"^{re.escape(args.title)}$",
                ],
                capture_output=True,
                text=True,
                timeout=3,
            )
            for candidate in search.stdout.split()[:16]:
                if time.monotonic() >= deadline:
                    break
                if candidate.isdigit():
                    try:
                        owner = int(run(["xdotool", "getwindowpid", candidate]))
                    except (RuntimeError, ValueError):
                        continue
                    if owner in owned:
                        window = candidate
                        break
            if window:
                break
            time.sleep(0.1)
        if not window:
            raise RuntimeError(
                "Timed out waiting for an application-owned native window"
            )
        report["checks"]["window"] = "passed"
        report["measurements"]["time_to_window_observed_ms"] = (
            time.monotonic() - started
        ) * 1000
        report["window_id"] = window
        # The first traversal can contain only the root, before the app's initial
        # batch. Match the mounted tree before targeting controls or sampling idle.
        if initial_render is not None or render is not None or args.idle_seconds:
            if initial_render is not None:
                report["checks"]["app_initial_render_report"] = "failed"
            while True:
                records = observe_first_paint()
                if "time_to_first_paint_report_observed_ms" in report[
                    "measurements"
                ] and (
                    initial_render is None
                    or any(matches_paint(event, initial_render) for event in records)
                ):
                    if initial_render is not None:
                        report["checks"]["app_initial_render_report"] = "passed"
                        report["measurements"][
                            "time_to_expected_initial_paint_report_observed_ms"
                        ] = (time.monotonic() - started) * 1000
                    break
                sample("startup")
                if app.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(
                        "The native window did not report the required initial paint"
                    )
                time.sleep(0.1)
        if args.idle_seconds:
            idle_started = time.monotonic()
            idle_end = idle_started + args.idle_seconds
            idle_rss = []
            while True:
                if app.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(
                        "Application exited or timed out during idle sampling"
                    )
                sample("idle")
                idle_rss.append(report["measurements"]["samples"][-1]["tree_rss_bytes"])
                remaining = idle_end - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(0.1, remaining))
            report["measurements"]["idle"] = {
                "requested_seconds": args.idle_seconds,
                "observed_duration_ms": (time.monotonic() - idle_started) * 1000,
                "sample_count": len(idle_rss),
                "median_tree_rss_bytes": statistics.median(idle_rss),
                "maximum_tree_rss_bytes": max(idle_rss),
            }

        def focus():
            if int(run(["xdotool", "getwindowpid", window])) not in sample():
                raise RuntimeError(
                    "Window no longer belongs to the launched application"
                )
            run(["xdotool", "windowactivate", "--sync", window])
            if run(["xdotool", "getactivewindow"]) != window:
                raise RuntimeError(
                    "Native window did not gain focus; no input was injected"
                )

        def screenshot(name):
            path = args.output / name
            run(["import", "-window", window, "-strip", str(path)])
            report.setdefault("screenshots", {})[name] = {
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }

        focus()
        screenshot("before.png")
        offset = evidence_path.stat().st_size if evidence_path.exists() else 0
        injection_started = time.monotonic()
        report["measurements"]["input_injection_started_ms"] = (
            injection_started - started
        ) * 1000
        if args.click:
            geometry = dict(
                line.split("=", 1)
                for line in run(
                    ["xdotool", "getwindowgeometry", "--shell", window]
                ).splitlines()
            )
            x, y = args.click
            if not (
                0 <= x < int(geometry["WIDTH"]) and 0 <= y < int(geometry["HEIGHT"])
            ):
                raise RuntimeError(
                    "Click coordinates are outside the owned application window"
                )
            run(["xdotool", "mousemove", "--window", window, str(x), str(y)])
            run(["xdotool", "click", "1"])
        for key in args.key:
            focus()
            run(["xdotool", "key", "--clearmodifiers", key])
        if args.text is not None:
            focus()
            run(
                [
                    "xdotool",
                    "type",
                    "--clearmodifiers",
                    "--delay",
                    "10",
                    "--",
                    args.text.replace("{nonce}", nonce),
                ]
            )
        report["checks"]["os_input"] = "injected-through-XTest"
        report["measurements"]["input_injection_completed_ms"] = (
            time.monotonic() - started
        ) * 1000
        events = []
        input_ok = render_ok = False
        while time.monotonic() < deadline:
            sample()
            events = read_events(evidence_path, nonce, offset)
            input_ok = bool(expectations) and all(
                any(matches(event, item) for event in events) for item in expectations
            )
            render_ok = render is not None and any(
                matches_paint(event, render) for event in events
            )
            for matched, key in [
                (input_ok, "input_start_to_matching_app_event_observed_ms"),
                (render_ok, "input_start_to_matching_paint_report_observed_ms"),
            ]:
                if matched and key not in report["measurements"]:
                    report["measurements"][key] = (
                        time.monotonic() - injection_started
                    ) * 1000
            if input_ok and (render is None or render_ok):
                break
            if not expectations and render is None:
                break
            if app.poll() is not None:
                raise RuntimeError(
                    "Application exited before producing requested input evidence"
                )
            time.sleep(0.1)
        report["observed_events"] = events
        renderer = [
            event
            for event in read_events(evidence_path, nonce, 0)
            if event.get("type") == "renderer"
        ]
        if renderer:
            report["renderer"] = {
                "status": "reported-by-native-window",
                "gpu": renderer[-1].get("gpu"),
            }
        if args.expect_software_renderer:
            gpu = report["renderer"].get("gpu")
            software_gpu = (
                isinstance(gpu, dict)
                and gpu.get("is_software_emulated") is True
                and all(
                    isinstance(gpu.get(key), str) and gpu[key]
                    for key in ["device_name", "driver_name", "driver_info"]
                )
            )
            report["checks"]["renderer"] = "passed" if software_gpu else "failed"
        if expectations:
            report["checks"]["app_input_event"] = "passed" if input_ok else "failed"
        if render is not None:
            report["checks"]["app_render_report"] = "passed" if render_ok else "failed"
        screenshot("after.png")
        focus()
        report["measurements"]["os_close_requested_ms"] = (
            time.monotonic() - started
        ) * 1000
        run(["xdotool", "key", "--clearmodifiers", "alt+F4"])
        try:
            app.wait(timeout=5)
            report["measurements"]["application_exit_observed_ms"] = (
                time.monotonic() - started
            ) * 1000
            report["checks"]["os_close"] = "passed" if app.returncode == 0 else "failed"
        except subprocess.TimeoutExpired:
            report["checks"]["os_close"] = "failed"
        report["status"] = (
            "failed"
            if "failed" in report["checks"].values()
            else ("passed" if input_ok and render_ok else "partial")
        )
    except Unsupported as error:
        report.update(status="unsupported", error=str(error))
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        report.update(status="failed", error=str(error))
    finally:
        # Finish bounded child cleanup even if a supervisor repeats termination.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if app is not None:
            try:
                report["cleanup"] = cleanup(app, observed)
                if (
                    report["cleanup"]["remaining_observed_pids"]
                    or report["cleanup"]["unreaped_observed_pids"]
                ):
                    report.update(
                        status="failed",
                        error="Observed application processes remain after cleanup",
                    )
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                report.update(
                    status="failed", error=f"Application cleanup failed: {error}"
                )
        for thread in threads:
            thread.join(timeout=1)
        if any(thread.is_alive() for thread in threads):
            report.update(
                status="failed", error="Application log pipes remain open after cleanup"
            )
        elif app is not None:
            app.stdout.close()
            app.stderr.close()
        samples = report["measurements"]["samples"]
        if samples:
            report["measurements"]["sampled_peak_tree_rss_bytes"] = max(
                row["tree_rss_bytes"] for row in samples
            )
        (args.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "status": report["status"],
                    "evidence": str(args.output / "result.json"),
                }
            )
        )
        signal.signal(signal.SIGTERM, previous_sigterm)
    return (
        0
        if report["status"] == "passed"
        else 2
        if report["status"] in ["partial", "unsupported"]
        else 1
    )


if __name__ == "__main__":
    sys.exit(main())
