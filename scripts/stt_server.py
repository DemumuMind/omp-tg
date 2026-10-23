#!/usr/bin/env python3
"""Local faster-whisper HTTP server for omp-tg (loopback only)."""

import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("STT_MODEL", "small")
DEVICE = os.environ.get("STT_DEVICE", "cpu")
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
DOWNLOAD_ROOT = os.environ.get("STT_DOWNLOAD_ROOT", os.path.expanduser("~/.cache/omp-tg-stt"))
PORT = int(os.environ.get("STT_PORT", "8765"))
DEFAULT_LANGUAGE = os.environ.get("STT_LANGUAGE", "") or None
MAX_BYTES = 25 * 1024 * 1024

MODEL = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE, download_root=DOWNLOAD_ROOT)
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "omp-tg-stt/1"

    def log_message(self, fmt, *args):  # keep the journal quiet; errors are still reported
        pass

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": MODEL_NAME})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/transcribe":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > MAX_BYTES:
            self._json(413, {"error": "invalid body size"})
            return
        suffix = Path(self.headers.get("x-filename", "audio.ogg")).suffix or ".ogg"
        language = self.headers.get("x-language") or DEFAULT_LANGUAGE
        data = self.rfile.read(length)

        handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        try:
            handle.write(data)
            handle.close()
            decoded = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", handle.name, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
                capture_output=True,
                check=False,
                timeout=60,
            )
            if decoded.returncode != 0:
                raise RuntimeError(decoded.stderr.decode("utf-8", "replace").strip() or "ffmpeg decode failed")
            samples = np.frombuffer(decoded.stdout, dtype=np.int16).astype(np.float32) / 32768.0
            with LOCK:
                segments, info = MODEL.transcribe(samples, language=language, vad_filter=True)
                parts = [segment.text.strip() for segment in segments if segment.text.strip()]
            self._json(
                200,
                {
                    "text": " ".join(parts).strip(),
                    "language": info.language,
                    "duration": info.duration,
                },
            )
        except Exception as error:  # noqa: BLE001 - surface any model error to the caller
            self._json(500, {"error": str(error)})
        finally:
            try:
                os.unlink(handle.name)
            except OSError:
                pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
