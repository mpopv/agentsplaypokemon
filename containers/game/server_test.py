from __future__ import annotations

import asyncio
import importlib.util
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path


class FakePyBoy:
    def __init__(self, _rom_path: str, window: str) -> None:
        self.window = window
        self.frame_count = 0
        self.speed: int | None = None
        self.stopped = False
        self.button_events: list[str] = []

    def set_emulation_speed(self, speed: int) -> None:
        self.speed = speed

    def tick(self, count: int = 1, _render: bool = True) -> bool:
        self.frame_count += count
        return True

    def button_press(self, value: str) -> None:
        self.button_events.append(f"press:{value}")

    def button_release(self, value: str) -> None:
        self.button_events.append(f"release:{value}")

    def stop(self, save: bool) -> None:
        self.stopped = not save


fake_pyboy = types.ModuleType("pyboy")
fake_pyboy.PyBoy = FakePyBoy
sys.modules["pyboy"] = fake_pyboy

server_path = Path(__file__).with_name("server.py")
sys.path.insert(0, str(server_path.parent))
server_spec = importlib.util.spec_from_file_location("game_server", server_path)
if server_spec is None or server_spec.loader is None:
    raise RuntimeError("cannot load the game server module")
server = importlib.util.module_from_spec(server_spec)
server_spec.loader.exec_module(server)


class EmulatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        server.ROM_PATH = Path(self.temp_directory.name) / "current.gb"
        self.emulator = server.Emulator()

    def tearDown(self) -> None:
        self.emulator.shutdown()
        self.temp_directory.cleanup()

    def test_rom_runs_between_controller_inputs(self) -> None:
        self.emulator.load_rom(b"test-rom")
        with self.emulator.lock:
            pyboy = self.emulator._require()
            first_frame = pyboy.frame_count
            speed = pyboy.speed

        deadline = time.monotonic() + 0.2
        current_frame = first_frame
        while current_frame <= first_frame and time.monotonic() < deadline:
            time.sleep(0.005)
            with self.emulator.lock:
                current_frame = self.emulator._require().frame_count

        self.assertEqual(speed, 0)
        self.assertGreater(current_frame, first_frame)
        self.assertGreater(self.emulator.status()["frameCount"], first_frame)

    def test_controller_input_uses_the_running_clock(self) -> None:
        self.emulator.load_rom(b"test-rom")
        with self.emulator.lock:
            pyboy = self.emulator._require()
            first_frame = pyboy.frame_count

        result = self.emulator.apply_input("a", 12)

        with self.emulator.lock:
            pyboy = self.emulator._require()
            self.assertGreaterEqual(pyboy.frame_count, first_frame + 12)
            self.assertEqual(pyboy.button_events, ["press:a", "release:a"])
        self.assertEqual(result, {"input": "a", "frames": 12})


class FakeFrameSource:
    def __init__(self) -> None:
        self.frame_calls = 0
        self.party_calls = 0
        self.party = {"available": True, "party": []}

    def status(self) -> dict[str, bool]:
        return {"loaded": True}

    def frame(self) -> bytes:
        self.frame_calls += 1
        return b"png-frame"

    def party_snapshot(self) -> dict[str, object]:
        self.party_calls += 1
        return self.party


class FakeSocket:
    def __init__(self, blocked: bool = False) -> None:
        self.closed = False
        self.blocked = blocked
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.frames: list[bytes] = []
        self.messages: list[str] = []

    async def send_bytes(self, data: bytes) -> None:
        self.started.set()
        if self.blocked:
            await self.release.wait()
        self.frames.append(data)

    async def send_str(self, data: str) -> None:
        self.messages.append(data)

    async def close(self, *, code: int = 1000, message: bytes = b"") -> None:
        del code, message
        self.closed = True


class FrameBroadcasterTest(unittest.IsolatedAsyncioTestCase):
    async def test_one_encoding_is_shared_by_all_ready_clients(self) -> None:
        source = FakeFrameSource()
        broadcaster = server.FrameBroadcaster(source, party_sample_interval_seconds=0)
        first = FakeSocket()
        second = FakeSocket()
        broadcaster.add(first)
        broadcaster.add(second)

        sent = await broadcaster.broadcast_once()
        await asyncio.sleep(0)

        self.assertTrue(sent)
        self.assertEqual(source.frame_calls, 1)
        self.assertEqual(source.party_calls, 1)
        self.assertEqual(first.frames, [b"png-frame"])
        self.assertEqual(second.frames, [b"png-frame"])
        self.assertEqual(len(first.messages), 1)
        self.assertEqual(first.messages, second.messages)
        await broadcaster.stop()

    async def test_unchanged_party_is_not_sent_twice(self) -> None:
        source = FakeFrameSource()
        broadcaster = server.FrameBroadcaster(source, party_sample_interval_seconds=0)
        socket = FakeSocket()
        broadcaster.add(socket)

        self.assertTrue(await broadcaster.broadcast_once())
        await asyncio.sleep(0)
        self.assertTrue(await broadcaster.broadcast_once())
        await asyncio.sleep(0)

        self.assertEqual(source.party_calls, 2)
        self.assertEqual(len(socket.messages), 1)
        self.assertEqual(socket.frames, [b"png-frame", b"png-frame"])
        await broadcaster.stop()

    async def test_slow_client_drops_new_frames_instead_of_building_a_queue(self) -> None:
        source = FakeFrameSource()
        broadcaster = server.FrameBroadcaster(source, party_sample_interval_seconds=0)
        socket = FakeSocket(blocked=True)
        broadcaster.add(socket)

        self.assertTrue(await broadcaster.broadcast_once())
        await socket.started.wait()
        self.assertFalse(await broadcaster.broadcast_once())
        self.assertEqual(source.frame_calls, 1)

        socket.release.set()
        await asyncio.sleep(0)
        self.assertEqual(socket.frames, [b"png-frame"])
        await broadcaster.stop()


if __name__ == "__main__":
    unittest.main()
