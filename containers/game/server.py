from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import struct
import threading
import time
from array import array
from pathlib import Path
from typing import Any, Protocol

from pyboy import PyBoy
from pokemon_red import (
    PartyDataError,
    SUPPORTED_ROM_SHA256,
    read_party,
    unavailable_party,
)


MAX_ROM_BYTES = 8 * 1024 * 1024
MAX_STATE_BYTES = 4 * 1024 * 1024
MAX_JSON_BYTES = 16 * 1024
VALID_INPUTS = {"up", "down", "left", "right", "a", "b", "start", "select"}
ROM_PATH = Path("/app/current.gb")
FRAME_RATE = 60
FRAME_INTERVAL_SECONDS = 1 / FRAME_RATE
STREAM_FRAME_RATE = 30
PARTY_SAMPLE_INTERVAL_SECONDS = 0.25
AUDIO_SAMPLE_RATE = 48_000
AUDIO_CHANNELS = 2
AUDIO_FORMAT = "s8"
AUDIO_PACKET_HEADER_BYTES = 4


class BinarySocket(Protocol):
    closed: bool

    async def send_bytes(self, data: bytes) -> None: ...

    async def send_str(self, data: str) -> None: ...

    async def close(self, *, code: int = 1000, message: bytes = b"") -> Any: ...


class Emulator:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.frame_condition = threading.Condition(self.lock)
        self.pyboy: PyBoy | None = None
        self.rom_sha256: str | None = None
        self.last_party_snapshot: dict[str, Any] | None = None
        self.latest_audio_packet: tuple[int, bytes] | None = None
        self.audio_sequence = 0
        self.pending_release: tuple[str, int] | None = None
        self.stopped = threading.Event()
        self.runner = threading.Thread(
            target=self._run_realtime,
            name="pyboy-realtime",
            daemon=True,
        )
        self.runner.start()

    def load_rom(self, data: bytes) -> dict[str, str | bool]:
        if not data or len(data) > MAX_ROM_BYTES:
            raise ValueError("ROM size must be between 1 byte and 8 MiB")
        with self.lock:
            if self.pyboy is not None:
                self.pyboy.stop(save=False)
            self.latest_audio_packet = None
            ROM_PATH.write_bytes(data)
            self.pyboy = PyBoy(
                str(ROM_PATH),
                window="null",
                sound_emulated=True,
                sound_sample_rate=AUDIO_SAMPLE_RATE,
                sound_volume=100,
            )
            self.pyboy.set_emulation_speed(0)
            self.pyboy.tick(1, True)
            self._capture_audio_locked(self.pyboy)
            self.pending_release = None
            self.rom_sha256 = hashlib.sha256(data).hexdigest()
            self.last_party_snapshot = None
            self.frame_condition.notify_all()
            return {"loaded": True, "romSha256": self.rom_sha256}

    def apply_input(self, value: str, frames: int) -> dict[str, int | str]:
        if value not in VALID_INPUTS:
            raise ValueError("input is not valid")
        if frames < 1 or frames > 120:
            raise ValueError("frames must be between 1 and 120")
        with self.frame_condition:
            pyboy = self._require()
            press_frames = min(4, frames)
            if self.pending_release is not None:
                pyboy.button_release(self.pending_release[0])
            pyboy.button_press(value)
            first_frame = pyboy.frame_count
            self.pending_release = (value, first_frame + press_frames)
            final_frame = first_frame + frames
            while self.pyboy is pyboy and pyboy.frame_count < final_frame:
                if self.stopped.is_set():
                    break
                self.frame_condition.wait(timeout=1)
            if self.pyboy is not pyboy:
                raise RuntimeError("emulator stopped while applying input")
            return {"input": value, "frames": frames}

    def frame(self) -> bytes:
        with self.lock:
            image = self._require().screen.image.convert("RGB")
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=False)
            return output.getvalue()

    def save_state(self) -> bytes:
        with self.lock:
            output = io.BytesIO()
            self._require().save_state(output)
            return output.getvalue()

    def load_state(self, data: bytes) -> None:
        if not data or len(data) > MAX_STATE_BYTES:
            raise ValueError("state size must be between 1 byte and 4 MiB")
        with self.lock:
            source = io.BytesIO(data)
            self._require().load_state(source)
            self._require().tick(1, True)
            self._capture_audio_locked(self._require())
            self.pending_release = None
            self.last_party_snapshot = None

    def party_snapshot(self) -> dict[str, Any]:
        with self.lock:
            pyboy = self._require()
            if self.rom_sha256 != SUPPORTED_ROM_SHA256:
                return unavailable_party()
            try:
                snapshot = read_party(pyboy.memory)
            except PartyDataError:
                return self.last_party_snapshot or unavailable_party()
            self.last_party_snapshot = snapshot
            return snapshot

    def audio_packet(self) -> tuple[int, bytes] | None:
        with self.lock:
            return self.latest_audio_packet

    def status(self) -> dict[str, str | bool | int | None]:
        with self.lock:
            return {
                "loaded": self.pyboy is not None,
                "romSha256": self.rom_sha256,
                "frameCount": self.pyboy.frame_count if self.pyboy is not None else None,
            }

    def shutdown(self) -> None:
        self.stopped.set()
        with self.frame_condition:
            self.frame_condition.notify_all()
        self.runner.join(timeout=1)
        with self.lock:
            if self.pyboy is not None:
                self.pyboy.stop(save=False)
                self.pyboy = None

    def _run_realtime(self) -> None:
        next_frame_at = time.monotonic()
        while not self.stopped.is_set():
            with self.lock:
                pyboy = self.pyboy
            if pyboy is None:
                next_frame_at = time.monotonic()
                self.stopped.wait(0.1)
                continue

            wait_seconds = next_frame_at - time.monotonic()
            if wait_seconds > 0 and self.stopped.wait(wait_seconds):
                break

            try:
                with self.frame_condition:
                    if self.pyboy is not pyboy:
                        next_frame_at = time.monotonic()
                        continue
                    pyboy.tick(1, True)
                    self._capture_audio_locked(pyboy)
                    if self.pending_release is not None:
                        value, release_frame = self.pending_release
                        if pyboy.frame_count >= release_frame:
                            pyboy.button_release(value)
                            self.pending_release = None
                    self.frame_condition.notify_all()
            except Exception as error:
                with self.frame_condition:
                    if self.pyboy is pyboy:
                        self.pyboy = None
                        self.pending_release = None
                    self.frame_condition.notify_all()
                print(
                    json.dumps({"message": "real-time emulator loop failed", "error": str(error)}),
                    flush=True,
                )
                continue

            next_frame_at += FRAME_INTERVAL_SECONDS
            if next_frame_at < time.monotonic() - FRAME_INTERVAL_SECONDS:
                next_frame_at = time.monotonic()

    def _require(self) -> PyBoy:
        if self.pyboy is None:
            raise RuntimeError("no ROM is loaded")
        return self.pyboy

    def _capture_audio_locked(self, pyboy: PyBoy) -> None:
        raw_format = str(pyboy.sound.raw_buffer_format)
        if raw_format != "b":
            raise RuntimeError(f"unsupported PyBoy sound buffer format: {raw_format}")
        head = int(pyboy.sound.raw_buffer_head)
        if head <= 0:
            return
        pcm = array(raw_format, pyboy.sound.raw_buffer[:head]).tobytes()
        if not pcm:
            return
        self.audio_sequence += 1
        self.latest_audio_packet = (self.audio_sequence, pcm)


class FrameBroadcaster:
    def __init__(
        self,
        emulator: Emulator,
        frame_rate: int = STREAM_FRAME_RATE,
        party_sample_interval_seconds: float = PARTY_SAMPLE_INTERVAL_SECONDS,
    ) -> None:
        self.emulator = emulator
        self.frame_interval_seconds = 1 / frame_rate
        self.party_sample_interval_seconds = party_sample_interval_seconds
        self.clients: set[BinarySocket] = set()
        self.client_available = asyncio.Event()
        self.send_tasks: dict[BinarySocket, tuple[asyncio.Task[None], str | None]] = {}
        self.sent_party_messages: dict[BinarySocket, str | None] = {}
        self.latest_party_message: str | None = None
        self.next_party_sample_at = 0.0
        self.producer: asyncio.Task[None] | None = None

    def add(self, socket: BinarySocket) -> None:
        self.clients.add(socket)
        self.sent_party_messages[socket] = None
        self.client_available.set()

    async def remove(self, socket: BinarySocket) -> None:
        self.clients.discard(socket)
        if not self.clients:
            self.client_available.clear()
        self.sent_party_messages.pop(socket, None)
        entry = self.send_tasks.pop(socket, None)
        task = entry[0] if entry is not None else None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def start(self) -> None:
        if self.producer is None or self.producer.done():
            self.producer = asyncio.create_task(self._run(), name="game-frame-stream")

    async def stop(self) -> None:
        if self.producer is not None:
            self.producer.cancel()
            await asyncio.gather(self.producer, return_exceptions=True)
            self.producer = None

        tasks = [entry[0] for entry in self.send_tasks.values()]
        self.send_tasks.clear()
        self.sent_party_messages.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        clients = list(self.clients)
        self.clients.clear()
        if clients:
            await asyncio.gather(
                *(client.close(code=1001, message=b"server stopping") for client in clients),
                return_exceptions=True,
            )

    async def broadcast_once(self) -> bool:
        ready: list[BinarySocket] = []
        for client in tuple(self.clients):
            entry = self.send_tasks.get(client)
            if entry is not None and entry[0].done():
                self._finish_send(client, entry[0], entry[1])
            if client.closed:
                self.clients.discard(client)
                self.sent_party_messages.pop(client, None)
            elif client not in self.send_tasks:
                ready.append(client)

        if not ready or not self.emulator.status()["loaded"]:
            return False

        try:
            frame = await asyncio.to_thread(self.emulator.frame)
        except RuntimeError:
            return False
        except Exception as error:
            print(
                json.dumps({"message": "game frame encoding failed", "error": str(error)}),
                flush=True,
            )
            return False

        now = asyncio.get_running_loop().time()
        if self.latest_party_message is None or now >= self.next_party_sample_at:
            try:
                snapshot = await asyncio.to_thread(self.emulator.party_snapshot)
                self.latest_party_message = json.dumps(
                    {"type": "pokemon.party", "payload": snapshot},
                    separators=(",", ":"),
                )
            except RuntimeError:
                self.latest_party_message = None
            except Exception as error:
                print(
                    json.dumps(
                        {"message": "party telemetry failed", "error": str(error)}
                    ),
                    flush=True,
                )
            self.next_party_sample_at = now + self.party_sample_interval_seconds

        for client in ready:
            party_message = (
                self.latest_party_message
                if self.sent_party_messages.get(client) != self.latest_party_message
                else None
            )
            task = asyncio.create_task(self._send(client, frame, party_message))
            self.send_tasks[client] = (task, party_message)
            task.add_done_callback(
                lambda completed, socket=client, message=party_message: self._finish_send(
                    socket, completed, message
                )
            )
        return True

    async def _send(
        self,
        socket: BinarySocket,
        frame: bytes,
        party_message: str | None,
    ) -> None:
        if party_message is not None:
            await socket.send_str(party_message)
        await socket.send_bytes(frame)

    async def _run(self) -> None:
        next_frame_at = asyncio.get_running_loop().time()
        while True:
            while not self.clients:
                self.client_available.clear()
                if self.clients:
                    break
                await self.client_available.wait()
            next_frame_at = max(next_frame_at, asyncio.get_running_loop().time())

            wait_seconds = next_frame_at - asyncio.get_running_loop().time()
            if wait_seconds > 0:
                await asyncio.sleep(wait_seconds)
            await self.broadcast_once()
            next_frame_at += self.frame_interval_seconds
            if next_frame_at < asyncio.get_running_loop().time() - self.frame_interval_seconds:
                next_frame_at = asyncio.get_running_loop().time()

    def _finish_send(
        self,
        socket: BinarySocket,
        task: asyncio.Task[None],
        party_message: str | None,
    ) -> None:
        entry = self.send_tasks.get(socket)
        if entry is None or entry[0] is not task:
            return
        self.send_tasks.pop(socket, None)
        if task.cancelled():
            return
        try:
            task.result()
            if party_message is not None:
                self.sent_party_messages[socket] = party_message
        except Exception:
            self.clients.discard(socket)
            self.sent_party_messages.pop(socket, None)
            asyncio.create_task(self._close_failed_socket(socket))

    async def _close_failed_socket(self, socket: BinarySocket) -> None:
        try:
            await socket.close(code=1011, message=b"frame delivery failed")
        except Exception:
            pass


class AudioBroadcaster:
    def __init__(self, emulator: Emulator, packet_rate: int = FRAME_RATE) -> None:
        self.emulator = emulator
        self.packet_interval_seconds = 1 / packet_rate
        self.clients: set[BinarySocket] = set()
        self.client_available = asyncio.Event()
        self.send_tasks: dict[BinarySocket, tuple[asyncio.Task[None], int]] = {}
        self.sent_sequences: dict[BinarySocket, int] = {}
        self.producer: asyncio.Task[None] | None = None

    def add(self, socket: BinarySocket) -> None:
        self.clients.add(socket)
        self.sent_sequences[socket] = -1
        self.client_available.set()

    async def remove(self, socket: BinarySocket) -> None:
        self.clients.discard(socket)
        if not self.clients:
            self.client_available.clear()
        self.sent_sequences.pop(socket, None)
        entry = self.send_tasks.pop(socket, None)
        task = entry[0] if entry is not None else None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def start(self) -> None:
        if self.producer is None or self.producer.done():
            self.producer = asyncio.create_task(self._run(), name="game-audio-stream")

    async def stop(self) -> None:
        if self.producer is not None:
            self.producer.cancel()
            await asyncio.gather(self.producer, return_exceptions=True)
            self.producer = None

        tasks = [entry[0] for entry in self.send_tasks.values()]
        self.send_tasks.clear()
        self.sent_sequences.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        clients = list(self.clients)
        self.clients.clear()
        if clients:
            await asyncio.gather(
                *(client.close(code=1001, message=b"server stopping") for client in clients),
                return_exceptions=True,
            )

    async def broadcast_once(self) -> bool:
        ready: list[BinarySocket] = []
        for client in tuple(self.clients):
            entry = self.send_tasks.get(client)
            if entry is not None and entry[0].done():
                self._finish_send(client, entry[0], entry[1])
            if client.closed:
                self.clients.discard(client)
                self.sent_sequences.pop(client, None)
            elif client not in self.send_tasks:
                ready.append(client)

        if not ready or not self.emulator.status()["loaded"]:
            return False
        packet = self.emulator.audio_packet()
        if packet is None:
            return False
        sequence, pcm = packet
        payload = struct.pack(">I", sequence % (2**32)) + pcm
        sent = False
        for client in ready:
            if self.sent_sequences.get(client, -1) >= sequence:
                continue
            task = asyncio.create_task(client.send_bytes(payload))
            self.send_tasks[client] = (task, sequence)
            task.add_done_callback(
                lambda completed, socket=client, sent_sequence=sequence: self._finish_send(
                    socket, completed, sent_sequence
                )
            )
            sent = True
        return sent

    async def _run(self) -> None:
        next_packet_at = asyncio.get_running_loop().time()
        while True:
            while not self.clients:
                self.client_available.clear()
                if self.clients:
                    break
                await self.client_available.wait()
            next_packet_at = max(next_packet_at, asyncio.get_running_loop().time())
            wait_seconds = next_packet_at - asyncio.get_running_loop().time()
            if wait_seconds > 0:
                await asyncio.sleep(wait_seconds)
            await self.broadcast_once()
            next_packet_at += self.packet_interval_seconds
            if next_packet_at < asyncio.get_running_loop().time() - self.packet_interval_seconds:
                next_packet_at = asyncio.get_running_loop().time()

    def _finish_send(
        self,
        socket: BinarySocket,
        task: asyncio.Task[None],
        sequence: int,
    ) -> None:
        entry = self.send_tasks.get(socket)
        if entry is None or entry[0] is not task:
            return
        self.send_tasks.pop(socket, None)
        if task.cancelled():
            return
        try:
            task.result()
            self.sent_sequences[socket] = sequence
        except Exception:
            self.clients.discard(socket)
            self.sent_sequences.pop(socket, None)
            asyncio.create_task(self._close_failed_socket(socket))

    async def _close_failed_socket(self, socket: BinarySocket) -> None:
        try:
            await socket.close(code=1011, message=b"audio delivery failed")
        except Exception:
            pass


EMULATOR = Emulator()


def create_app() -> Any:
    from aiohttp import WSMsgType, WSCloseCode, web

    broadcaster = FrameBroadcaster(EMULATOR)
    audio_broadcaster = AudioBroadcaster(EMULATOR)

    def json_response(value: object, status: int = 200) -> Any:
        return web.json_response(
            value,
            status=status,
            dumps=lambda item: json.dumps(item, separators=(",", ":")),
        )

    def error_response(status: int, message: str) -> Any:
        return json_response({"error": message}, status)

    async def read_body(request: Any, limit: int) -> bytes:
        raw_length = request.headers.get("content-length")
        if raw_length is None:
            raise ValueError("content-length is required")
        length = int(raw_length)
        if length < 1 or length > limit:
            raise ValueError("request body is too large")
        data = await request.read()
        if len(data) != length:
            raise ValueError("request body is incomplete")
        return data

    @web.middleware
    async def error_middleware(request: Any, handler: Any) -> Any:
        try:
            return await handler(request)
        except web.HTTPException as error:
            return error_response(error.status, error.reason)
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
            return error_response(400, str(error))
        except RuntimeError as error:
            return error_response(409, str(error))
        except Exception as error:
            print(
                json.dumps(
                    {
                        "message": "emulator request failed",
                        "path": request.path,
                        "error": str(error),
                    }
                ),
                flush=True,
            )
            return error_response(500, str(error))

    async def set_response_headers(_request: Any, response: Any) -> None:
        response.headers["cache-control"] = "no-store"

    async def health(_request: Any) -> Any:
        return json_response({"ok": True, **EMULATOR.status()})

    async def status(_request: Any) -> Any:
        return json_response(EMULATOR.status())

    async def frame(_request: Any) -> Any:
        data = await asyncio.to_thread(EMULATOR.frame)
        return web.Response(body=data, content_type="image/png")

    async def state(_request: Any) -> Any:
        data = await asyncio.to_thread(EMULATOR.save_state)
        return web.Response(body=data, content_type="application/octet-stream")

    async def load(request: Any) -> Any:
        data = await read_body(request, MAX_ROM_BYTES)
        return json_response(await asyncio.to_thread(EMULATOR.load_rom, data))

    async def load_state(request: Any) -> Any:
        data = await read_body(request, MAX_STATE_BYTES)
        await asyncio.to_thread(EMULATOR.load_state, data)
        return json_response({"loaded": True})

    async def apply_input(request: Any) -> Any:
        payload = json.loads((await read_body(request, MAX_JSON_BYTES)).decode("utf-8"))
        result = await asyncio.to_thread(
            EMULATOR.apply_input,
            str(payload.get("input", "")).lower(),
            int(payload.get("frames", 12)),
        )
        return json_response(result)

    async def game_stream(request: Any) -> Any:
        if request.headers.get("upgrade", "").lower() != "websocket":
            return error_response(426, "websocket upgrade required")
        if not EMULATOR.status()["loaded"]:
            return error_response(409, "no ROM is loaded")

        socket = web.WebSocketResponse(heartbeat=15, max_msg_size=1024, compress=False)
        await socket.prepare(request)
        broadcaster.add(socket)
        try:
            async for message in socket:
                if message.type in (WSMsgType.TEXT, WSMsgType.BINARY):
                    await socket.close(
                        code=WSCloseCode.POLICY_VIOLATION,
                        message=b"game stream is read only",
                    )
                    break
                if message.type == WSMsgType.ERROR:
                    break
        finally:
            await broadcaster.remove(socket)
        return socket

    async def audio_stream(request: Any) -> Any:
        if request.headers.get("upgrade", "").lower() != "websocket":
            return error_response(426, "websocket upgrade required")
        if not EMULATOR.status()["loaded"]:
            return error_response(409, "no ROM is loaded")

        socket = web.WebSocketResponse(heartbeat=15, max_msg_size=1024, compress=False)
        await socket.prepare(request)
        await socket.send_str(
            json.dumps(
                {
                    "type": "audio.config",
                    "sampleRate": AUDIO_SAMPLE_RATE,
                    "channels": AUDIO_CHANNELS,
                    "format": AUDIO_FORMAT,
                    "packetHeaderBytes": AUDIO_PACKET_HEADER_BYTES,
                },
                separators=(",", ":"),
            )
        )
        audio_broadcaster.add(socket)
        try:
            async for message in socket:
                if message.type in (WSMsgType.TEXT, WSMsgType.BINARY):
                    await socket.close(
                        code=WSCloseCode.POLICY_VIOLATION,
                        message=b"audio stream is read only",
                    )
                    break
                if message.type == WSMsgType.ERROR:
                    break
        finally:
            await audio_broadcaster.remove(socket)
        return socket

    async def start_stream(_app: Any) -> None:
        await broadcaster.start()
        await audio_broadcaster.start()

    async def stop_stream(_app: Any) -> None:
        await broadcaster.stop()
        await audio_broadcaster.stop()

    async def stop_service(_app: Any) -> None:
        EMULATOR.shutdown()

    app = web.Application(client_max_size=MAX_ROM_BYTES, middlewares=[error_middleware])
    app.on_response_prepare.append(set_response_headers)
    app.on_startup.append(start_stream)
    app.on_shutdown.append(stop_stream)
    app.on_cleanup.append(stop_service)
    app.router.add_get("/health", health)
    app.router.add_get("/status", status)
    app.router.add_get("/frame", frame)
    app.router.add_get("/state", state)
    app.router.add_get("/game-stream", game_stream)
    app.router.add_get("/audio-stream", audio_stream)
    app.router.add_post("/load", load)
    app.router.add_post("/load-state", load_state)
    app.router.add_post("/input", apply_input)
    return app


def main() -> None:
    from aiohttp import web

    port = int(os.environ.get("PORT", "8080"))
    print(json.dumps({"message": "emulator server started", "port": port}), flush=True)
    web.run_app(create_app(), host="0.0.0.0", port=port, access_log=None)


if __name__ == "__main__":
    main()
