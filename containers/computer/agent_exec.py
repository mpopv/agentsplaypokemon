#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import resource
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


WORKSPACE = Path("/workspace")
RETURNED_STREAM_BYTES = int(os.environ.get("COMPUTER_OUTPUT_LIMIT_BYTES", "32768"))
GENERATED_OUTPUT_BYTES = int(os.environ.get("COMPUTER_GENERATED_OUTPUT_LIMIT_BYTES", "1048576"))
TIMEOUT_SECONDS = int(os.environ.get("COMPUTER_EXEC_TIMEOUT_SECONDS", "4"))
MAX_MEMORY_BYTES = 512 * 1024 * 1024
MAX_PROCESSES = 64
MAX_OPEN_FILES = 256
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_WORKSPACE_BYTES = 500 * 1024 * 1024
MAX_WORKSPACE_ENTRIES = 5_000
WORKSPACE_CHECK_INTERVAL_SECONDS = 0.25
METRICS_PREFIX = "__AGENTS_PLAY_EXEC_METRICS__="


@dataclass(frozen=True)
class WorkspaceUsage:
    entries: int
    bytes: int


def workspace_usage() -> WorkspaceUsage:
    entries = 0
    total_bytes = 0
    pending = [WORKSPACE]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as children:
                for child in children:
                    entries += 1
                    try:
                        details = child.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    if stat.S_ISDIR(details.st_mode) and not child.is_symlink():
                        pending.append(Path(child.path))
                    elif stat.S_ISREG(details.st_mode):
                        total_bytes += details.st_size
                    if entries > MAX_WORKSPACE_ENTRIES or total_bytes > MAX_WORKSPACE_BYTES:
                        return WorkspaceUsage(entries=entries, bytes=total_bytes)
        except FileNotFoundError:
            continue
    return WorkspaceUsage(entries=entries, bytes=total_bytes)


def workspace_baseline() -> dict[str, tuple[str, int]]:
    baseline: dict[str, tuple[str, int]] = {}
    pending = [WORKSPACE]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as children:
                for child in children:
                    path = Path(child.path)
                    try:
                        details = child.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    if stat.S_ISDIR(details.st_mode) and not child.is_symlink():
                        baseline[str(path)] = ("directory", 0)
                        pending.append(path)
                    elif stat.S_ISREG(details.st_mode):
                        baseline[str(path)] = ("file", details.st_size)
                    else:
                        baseline[str(path)] = ("other", 0)
        except FileNotFoundError:
            continue
    return baseline


def restore_workspace_quota(baseline: dict[str, tuple[str, int]]) -> None:
    current_paths: list[Path] = []
    pending = [WORKSPACE]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as children:
                for child in children:
                    path = Path(child.path)
                    current_paths.append(path)
                    if child.is_dir(follow_symlinks=False):
                        pending.append(path)
        except FileNotFoundError:
            continue

    for path in sorted(current_paths, key=lambda item: len(item.parts), reverse=True):
        original = baseline.get(str(path))
        try:
            if original is None:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
            elif original[0] == "file" and path.is_file() and path.stat().st_size > original[1]:
                with path.open("r+b") as output:
                    output.truncate(original[1])
        except FileNotFoundError:
            continue


def apply_resource_limits() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY_BYTES, MAX_MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_NPROC, (MAX_PROCESSES, MAX_PROCESSES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (MAX_OPEN_FILES, MAX_OPEN_FILES))
    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT_SECONDS, TIMEOUT_SECONDS + 1))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_BYTES, MAX_FILE_BYTES))


def sandbox_command(command: str, cwd: str) -> list[str]:
    return [
        "bwrap",
        "--die-with-parent",
        "--new-session",
        "--unshare-ipc",
        "--unshare-net",
        "--unshare-pid",
        "--unshare-user",
        "--unshare-uts",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/etc",
        "/etc",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/sbin",
        "/sbin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--bind",
        "/workspace",
        "/workspace",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/var",
        "--tmpfs",
        "/var/tmp",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/dev/shm",
        "--cap-drop",
        "ALL",
        "--uid",
        "10001",
        "--gid",
        "10001",
        "--clearenv",
        "--setenv",
        "HOME",
        "/tmp",
        "--setenv",
        "LANG",
        "C.UTF-8",
        "--setenv",
        "PATH",
        "/usr/local/bin:/usr/bin:/bin",
        "--setenv",
        "TERM",
        "dumb",
        "--chdir",
        cwd,
        "bash",
        "--noprofile",
        "--norc",
        "-lc",
        command,
    ]


def stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def execute(
    command: str,
    write: Callable[[int, bytes], int] = os.write,
    prepare: Callable[[], None] = apply_resource_limits,
) -> int:
    baseline = workspace_baseline()
    cwd = os.getcwd()
    process = subprocess.Popen(
        sandbox_command(command, cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        preexec_fn=prepare,
    )
    if process.stdout is None or process.stderr is None:
        raise RuntimeError("command output pipes are unavailable")

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    retained = {"stdout": bytearray(), "stderr": bytearray()}
    produced = {"stdout": 0, "stderr": 0}
    started_at = time.monotonic()
    next_workspace_check = started_at + WORKSPACE_CHECK_INTERVAL_SECONDS
    timed_out = False
    output_limit_exceeded = False
    workspace_limit_exceeded = False

    while selector.get_map():
        now = time.monotonic()
        if not timed_out and now - started_at >= TIMEOUT_SECONDS:
            timed_out = True
            stop_process(process)
        if not workspace_limit_exceeded and now >= next_workspace_check:
            usage = workspace_usage()
            if usage.entries > MAX_WORKSPACE_ENTRIES or usage.bytes > MAX_WORKSPACE_BYTES:
                workspace_limit_exceeded = True
                stop_process(process)
            next_workspace_check = now + WORKSPACE_CHECK_INTERVAL_SECONDS

        for key, _events in selector.select(timeout=0.05):
            chunk = os.read(key.fileobj.fileno(), 64 * 1024)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            stream = str(key.data)
            produced[stream] += len(chunk)
            remaining = RETURNED_STREAM_BYTES - len(retained[stream])
            if remaining > 0:
                retained[stream].extend(chunk[:remaining])
            if (
                not output_limit_exceeded
                and produced["stdout"] + produced["stderr"] > GENERATED_OUTPUT_BYTES
            ):
                output_limit_exceeded = True
                stop_process(process)

    exit_code = process.wait()
    process.stdout.close()
    process.stderr.close()
    usage = workspace_usage()
    if usage.entries > MAX_WORKSPACE_ENTRIES or usage.bytes > MAX_WORKSPACE_BYTES:
        workspace_limit_exceeded = True
    if workspace_limit_exceeded:
        restore_workspace_quota(baseline)
        usage = workspace_usage()

    if produced["stdout"] > len(retained["stdout"]):
        retained["stdout"].extend(
            f"\n[stdout truncated at {RETURNED_STREAM_BYTES} bytes]\n".encode()
        )
    if produced["stderr"] > len(retained["stderr"]):
        retained["stderr"].extend(
            f"\n[stderr truncated at {RETURNED_STREAM_BYTES} bytes]\n".encode()
        )
    if timed_out:
        retained["stderr"].extend(b"\n[command stopped at the time limit]\n")
        exit_code = 124
    if output_limit_exceeded:
        retained["stderr"].extend(b"\n[command stopped at the generated-output limit]\n")
        exit_code = 125
    if workspace_limit_exceeded:
        retained["stderr"].extend(b"\n[command stopped at the workspace quota]\n")
        exit_code = 126

    write(sys.stdout.fileno(), retained["stdout"])
    write(sys.stderr.fileno(), retained["stderr"])
    metrics = {
        "stdoutProducedBytes": produced["stdout"],
        "stderrProducedBytes": produced["stderr"],
        "stdoutReturnedBytes": min(produced["stdout"], RETURNED_STREAM_BYTES),
        "stderrReturnedBytes": min(produced["stderr"], RETURNED_STREAM_BYTES),
        "filesystemEntries": usage.entries,
        "filesystemBytes": usage.bytes,
        "timedOut": timed_out,
        "outputLimitExceeded": output_limit_exceeded,
        "workspaceLimitExceeded": workspace_limit_exceeded,
    }
    write(
        sys.stderr.fileno(),
        f"\n{METRICS_PREFIX}{json.dumps(metrics, separators=(',', ':'))}\n".encode(),
    )
    return exit_code


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("one command argument is required")
    raise SystemExit(execute(sys.argv[1]))


if __name__ == "__main__":
    main()
