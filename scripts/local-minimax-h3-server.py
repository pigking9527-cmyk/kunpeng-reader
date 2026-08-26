"""Loopback-only MiniMax-H3 bridge for an already-installed ComfyUI/GGUF stack.

The reader never talks to a cloud endpoint. ComfyUI itself must be installed
and reviewed by the user. The supplied API workflow JSON needs two string
placeholders: ``__KUNPENG_PROMPT__`` and ``__KUNPENG_OUTPUT_PREFIX__``.
"""

from __future__ import annotations

import argparse
import json
import shutil
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

MODEL_ID = "MiniMaxAI/MiniMax-H3"
TASKS: dict[str, dict[str, Any]] = {}
TASK_LOCK = threading.Lock()
COMFY_LOCK = threading.Lock()
COMFY_ENDPOINT = ""
WORKFLOW_TEMPLATE = Path()
COMFY_OUTPUT = Path()
OUTPUT_DIR = Path()


def is_loopback(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"} and parsed.port is not None


def http_json(method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = 30) -> dict[str, Any]:
    url = f"{COMFY_ENDPOINT.rstrip('/')}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=timeout) as response:  # nosec: endpoint was loopback-validated at startup
        return json.loads(response.read().decode("utf-8"))


def replace_tokens(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        for source, target in replacements.items():
            value = value.replace(source, target)
        return value
    if isinstance(value, list):
        return [replace_tokens(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: replace_tokens(item, replacements) for key, item in value.items()}
    return value


def build_workflow(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    template = json.loads(WORKFLOW_TEMPLATE.read_text(encoding="utf-8"))
    replacements = {
        "__KUNPENG_PROMPT__": str(payload["prompt"]),
        "__KUNPENG_OUTPUT_PREFIX__": f"kunpeng/{task_id}",
        "__KUNPENG_KIND__": str(payload.get("kind", "video")),
        "__KUNPENG_DURATION__": str(payload.get("duration", 5)),
        "__KUNPENG_RESOLUTION__": str(payload.get("resolution", "544P")),
        "__KUNPENG_RATIO__": str(payload.get("ratio", payload.get("aspectRatio", "16:9"))),
    }
    return replace_tokens(template, replacements)


def safe_comfy_output(entry: dict[str, Any]) -> Path:
    filename = str(entry.get("filename", ""))
    subfolder = str(entry.get("subfolder", ""))
    kind = str(entry.get("type", "output"))
    if kind != "output" or not filename or Path(filename).name != filename:
        raise ValueError("ComfyUI returned an unsafe output reference")
    candidate = (COMFY_OUTPUT / subfolder / filename).resolve()
    root = COMFY_OUTPUT.resolve()
    if root not in candidate.parents or not candidate.is_file():
        raise ValueError("ComfyUI output does not exist under its output directory")
    return candidate


def collect_output(history: dict[str, Any], prompt_id: str, kind: str) -> list[Path]:
    record = history.get(prompt_id, {})
    outputs = record.get("outputs", {}) if isinstance(record, dict) else {}
    entries: list[dict[str, Any]] = []
    for node in outputs.values() if isinstance(outputs, dict) else []:
        if isinstance(node, dict):
            for field in ("images", "gifs", "videos"):
                values = node.get(field, [])
                if isinstance(values, list):
                    entries.extend(value for value in values if isinstance(value, dict))
    paths = [safe_comfy_output(item) for item in entries]
    extensions = {".png", ".jpg", ".jpeg", ".webp"} if kind == "image" else {".mp4", ".webm", ".mov", ".gif"}
    return [path for path in paths if path.suffix.lower() in extensions]


def submit_and_wait(task_id: str, payload: dict[str, Any]) -> Path:
    with COMFY_LOCK:
        response = http_json("POST", "/prompt", {"prompt": build_workflow(task_id, payload), "client_id": f"kunpeng-{task_id}"})
        prompt_id = response.get("prompt_id")
        if not isinstance(prompt_id, str) or not prompt_id:
            raise RuntimeError("ComfyUI did not return prompt_id")
        deadline = time.monotonic() + 30 * 60
        while time.monotonic() < deadline:
            paths = collect_output(http_json("GET", f"/history/{prompt_id}"), prompt_id, str(payload["kind"]))
            if paths:
                output_folder = OUTPUT_DIR / ("images" if payload["kind"] == "image" else "videos")
                output_folder.mkdir(parents=True, exist_ok=True)
                target = output_folder / f"{task_id}{paths[0].suffix.lower()}"
                shutil.copy2(paths[0], target)
                return target.resolve()
            time.sleep(1.5)
        raise TimeoutError("ComfyUI generation did not finish within 30 minutes")


def set_task(task_id: str, **updates: Any) -> None:
    with TASK_LOCK:
        TASKS.setdefault(task_id, {"taskId": task_id}).update(updates)


def run_video(task_id: str, payload: dict[str, Any]) -> None:
    set_task(task_id, status="processing", absolutePath=None, cacheKey=None, message="ComfyUI/GGUF 正在本机生成 MiniMax-H3 视频。")
    try:
        path = submit_and_wait(task_id, payload)
        set_task(task_id, status="success", absolutePath=str(path), cacheKey=path.name, message="已由本机 ComfyUI/GGUF 生成并缓存。")
    except Exception:
        set_task(task_id, status="failed", absolutePath=None, cacheKey=None, message="本机 ComfyUI/GGUF 生成失败；请查看本机受限日志。")


class Handler(BaseHTTPRequestHandler):
    server_version = "KunpengMiniMaxH3Comfy/1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, status: int, value: dict[str, Any]) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 65_536:
            raise ValueError("invalid request body")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("body must be an object")
        return value

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            try:
                http_json("GET", "/system_stats", timeout=3)
                self.send_json(200, {"model": MODEL_ID, "backend": "comfyui", "loopbackOnly": True})
            except Exception:
                self.send_json(503, {"model": MODEL_ID, "backend": "comfyui", "ready": False})
            return
        if self.path.startswith("/v1/tasks/"):
            task_id = self.path.rsplit("/", 1)[-1]
            with TASK_LOCK:
                task = dict(TASKS.get(task_id, {"taskId": task_id, "status": "failed", "absolutePath": None, "cacheKey": None, "message": "本地任务不存在。"}))
            self.send_json(200, task)
            return
        self.send_json(404, {"message": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self.read_json()
            prompt = str(payload.get("prompt", "")).strip()
            if not prompt or len(prompt) > 7_000:
                raise ValueError("invalid prompt")
            if self.path == "/v1/generate/image":
                task_id = uuid.uuid4().hex
                path = submit_and_wait(task_id, {"kind": "image", "prompt": prompt, "aspectRatio": payload.get("aspectRatio", "16:9")})
                self.send_json(200, {"requestId": task_id, "images": [{"absolutePath": str(path), "cacheKey": path.name}]})
                return
            if self.path == "/v1/generate/video":
                task_id = uuid.uuid4().hex
                task = {"kind": "video", "prompt": prompt, "resolution": payload.get("resolution", "544P"), "duration": payload.get("duration", 5), "ratio": payload.get("ratio", "16:9")}
                threading.Thread(target=run_video, args=(task_id, task), daemon=True).start()
                self.send_json(200, {"taskId": task_id, "status": "queued"})
                return
            self.send_json(404, {"message": "not found"})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"message": "invalid local request"})
        except Exception:
            self.send_json(500, {"message": "local ComfyUI task failed"})


def self_test() -> int:
    assert is_loopback("http://127.0.0.1:8188")
    assert not is_loopback("https://example.com:8188")
    source = {"1": {"inputs": {"text": "__KUNPENG_PROMPT__", "prefix": "__KUNPENG_OUTPUT_PREFIX__"}}}
    replaced = replace_tokens(source, {"__KUNPENG_PROMPT__": "hello", "__KUNPENG_OUTPUT_PREFIX__": "kunpeng/a"})
    assert replaced["1"]["inputs"]["text"] == "hello"
    assert replaced["1"]["inputs"]["prefix"] == "kunpeng/a"
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["comfyui"], default="comfyui")
    parser.add_argument("--comfy-endpoint", default="http://127.0.0.1:8188")
    parser.add_argument("--workflow-template")
    parser.add_argument("--comfy-output")
    parser.add_argument("--output-dir")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8095)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.host not in {"127.0.0.1", "::1", "localhost"} or not is_loopback(args.comfy_endpoint):
        raise SystemExit("MiniMax-H3 bridge is loopback-only")
    if not args.workflow_template or not args.comfy_output or not args.output_dir:
        raise SystemExit("ComfyUI workflow, output and reader cache paths are required")
    global COMFY_ENDPOINT, WORKFLOW_TEMPLATE, COMFY_OUTPUT, OUTPUT_DIR
    COMFY_ENDPOINT = args.comfy_endpoint.rstrip("/")
    WORKFLOW_TEMPLATE = Path(args.workflow_template).resolve()
    COMFY_OUTPUT = Path(args.comfy_output).resolve()
    OUTPUT_DIR = Path(args.output_dir).resolve()
    raw = WORKFLOW_TEMPLATE.read_text(encoding="utf-8")
    json.loads(raw)
    if "__KUNPENG_PROMPT__" not in raw or "__KUNPENG_OUTPUT_PREFIX__" not in raw:
        raise SystemExit("ComfyUI API workflow is missing required Kunpeng placeholders")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
