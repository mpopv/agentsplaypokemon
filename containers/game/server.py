from __future__ import annotations

import hashlib
import io
import json
import os
import signal
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pyboy import PyBoy


MAX_ROM_BYTES = 8 * 1024 * 1024
MAX_STATE_BYTES = 4 * 1024 * 1024
VALID_INPUTS = {"up", "down", "left", "right", "a", "b", "start", "select"}
ROM_PATH = Path("/app/current.gb")
FRAME_RATE = 60
FRAME_INTERVAL_SECONDS = 1 / FRAME_RATE


class Emulator:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.frame_condition = threading.Condition(self.lock)
        self.pyboy: PyBoy | None = None
        self.rom_sha256: str | None = None
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
            ROM_PATH.write_bytes(data)
            self.pyboy = PyBoy(str(ROM_PATH), window="null")
            self.pyboy.set_emulation_speed(0)
            self.pyboy.tick(1, True)
            self.pending_release = None
            self.rom_sha256 = hashlib.sha256(data).hexdigest()
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
            self.pending_release = None

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


EMULATOR = Emulator()


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentsPlayPokemonEmulator/1"

    def do_GET(self) -> None:
        try:
            if self.path == "/health":
                self._json({"ok": True, **EMULATOR.status()})
                return
            if self.path == "/status":
                self._json(EMULATOR.status())
                return
            if self.path == "/frame":
                self._bytes(EMULATOR.frame(), "image/png")
                return
            if self.path == "/state":
                self._bytes(EMULATOR.save_state(), "application/octet-stream")
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except RuntimeError as error:
            self._error(HTTPStatus.CONFLICT, str(error))
        except Exception as error:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))

    def do_POST(self) -> None:
        try:
            if self.path == "/load":
                self._json(EMULATOR.load_rom(self._body(MAX_ROM_BYTES)))
                return
            if self.path == "/load-state":
                EMULATOR.load_state(self._body(MAX_STATE_BYTES))
                self._json({"loaded": True})
                return
            if self.path == "/input":
                payload = json.loads(self._body(16 * 1024).decode("utf-8"))
                self._json(
                    EMULATOR.apply_input(
                        str(payload.get("input", "")).lower(),
                        int(payload.get("frames", 12)),
                    )
                )
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
            self._error(HTTPStatus.BAD_REQUEST, str(error))
        except RuntimeError as error:
            self._error(HTTPStatus.CONFLICT, str(error))
        except Exception as error:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))

    def log_message(self, format: str, *args: object) -> None:
        print(json.dumps({"message": format % args, "path": self.path}), flush=True)

    def _body(self, limit: int) -> bytes:
        raw_length = self.headers.get("content-length")
        if raw_length is None:
            raise ValueError("content-length is required")
        length = int(raw_length)
        if length < 1 or length > limit:
            raise ValueError("request body is too large")
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError("request body is incomplete")
        return data

    def _json(self, value: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        self._bytes(
            json.dumps(value, separators=(",", ":")).encode("utf-8"),
            "application/json; charset=utf-8",
            status,
        )

    def _error(self, status: HTTPStatus, message: str) -> None:
        self._json({"error": message}, status)

    def _bytes(
        self,
        data: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)

    def stop_server(_signal_number: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_server)
    print(json.dumps({"message": "emulator server started", "port": port}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        EMULATOR.shutdown()


if __name__ == "__main__":
    main()
