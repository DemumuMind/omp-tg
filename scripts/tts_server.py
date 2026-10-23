#!/usr/bin/env python3
"""Local Piper TTS HTTP server for omp-tg (loopback only)."""

import json
import os
import subprocess
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from piper.voice import PiperVoice

MODEL = os.environ.get(
    "TTS_MODEL",
    os.path.expanduser("~/.local/share/omp-tg/piper/ru_RU-irina-medium.onnx"),
)
PORT = int(os.environ.get("TTS_PORT", "8767"))
MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "4000"))
VOICE = PiperVoice.load(MODEL)
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "omp-tg-tts/1"

    def log_message(self, fmt, *args):
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
            self._json(200, {"ok": True, "voice": os.path.basename(MODEL)})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/speak":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > 64 * 1024:
            self._json(413, {"error": "invalid body size"})
            return
        try:
            text = self.rfile.read(length).decode("utf-8").strip()
        except UnicodeDecodeError:
            self._json(400, {"error": "body must be utf-8"})
            return
        if text == "":
            self._json(400, {"error": "empty text"})
            return
        text = text[:MAX_CHARS]

        wav_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
                wav_path = handle.name
            with wave.open(wav_path, "wb") as wav:
                with LOCK:
                    VOICE.synthesize_wav(text, wav)
            encoded = subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-i", wav_path,
                    "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1",
                    "-f", "ogg", "-",
                ],
                capture_output=True,
                check=False,
                timeout=60,
            )
            if encoded.returncode != 0:
                raise RuntimeError(encoded.stderr.decode("utf-8", "replace").strip() or "ffmpeg encode failed")
            self.send_response(200)
            self.send_header("content-type", "audio/ogg")
            self.send_header("content-length", str(len(encoded.stdout)))
            self.end_headers()
            self.wfile.write(encoded.stdout)
        except Exception as error:  # noqa: BLE001 - surface any model error to the caller
            self._json(500, {"error": str(error)})
        finally:
            if wav_path:
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
