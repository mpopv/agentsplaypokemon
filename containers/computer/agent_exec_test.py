from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

import agent_exec


class WorkspaceQuotaTest(unittest.TestCase):
    def test_uses_bubblewrap_implicit_empty_root(self) -> None:
        command = agent_exec.sandbox_command("true", "/workspace")

        self.assertNotIn(("--tmpfs", "/"), list(zip(command, command[1:])))
        self.assertIn("--unshare-net", command)
        self.assertIn("--ro-bind", command)

    def test_counts_regular_file_bytes_and_entries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "folder").mkdir()
            (root / "folder" / "note.txt").write_bytes(b"hello")
            with patch.object(agent_exec, "WORKSPACE", root):
                usage = agent_exec.workspace_usage()

        self.assertEqual(usage.entries, 2)
        self.assertEqual(usage.bytes, 5)

    def test_removes_new_paths_after_a_quota_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / "existing.txt"
            existing.write_bytes(b"old")
            with patch.object(agent_exec, "WORKSPACE", root):
                baseline = agent_exec.workspace_baseline()
                existing.write_bytes(b"old-and-too-large")
                (root / "new.txt").write_bytes(b"new")
                agent_exec.restore_workspace_quota(baseline)

            self.assertEqual(existing.read_bytes(), b"old")
            self.assertFalse((root / "new.txt").exists())

    def test_stops_a_command_that_generates_too_much_output(self) -> None:
        writes: list[tuple[int, bytes]] = []
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(agent_exec, "WORKSPACE", Path(directory)),
                patch.object(
                    agent_exec,
                    "sandbox_command",
                    return_value=[
                        sys.executable,
                        "-c",
                        "import sys; sys.stdout.write('x' * 2000000)",
                    ],
                ),
            ):
                exit_code = agent_exec.execute(
                    "high output",
                    lambda descriptor, data: writes.append((descriptor, data)) or len(data),
                    lambda: None,
                )

        stdout = b"".join(data for descriptor, data in writes if descriptor == 1)
        self.assertEqual(exit_code, 125)
        self.assertLessEqual(len(stdout), agent_exec.RETURNED_STREAM_BYTES + 100)

    def test_returns_success_for_a_bounded_command(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(agent_exec, "WORKSPACE", Path(directory)),
                patch.object(
                    agent_exec,
                    "sandbox_command",
                    return_value=[sys.executable, "-c", "print('ok')"],
                ),
            ):
                exit_code = agent_exec.execute(
                    "bounded",
                    lambda _descriptor, data: len(data),
                    lambda: None,
                )

        self.assertEqual(exit_code, 0)


if __name__ == "__main__":
    unittest.main()
