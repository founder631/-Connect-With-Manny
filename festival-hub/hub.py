#!/usr/bin/env python3
"""Festival Hub - a private dashboard for your FilmFreeway submissions.

Runs a small local web server that talks to the FilmFreeway Submissions API
on your behalf. Your API key stays on your computer: it is read from the
FILMFREEWAY_API_KEY environment variable or a `.env` file next to this script,
and it is never sent to the browser.

Usage:
    python3 hub.py                 # start the dashboard at http://127.0.0.1:8787
    python3 hub.py --demo          # same, with made-up demo data (no key needed)
    python3 hub.py sync            # download everything to data/ (JSON + CSV)

Only the Python standard library is used - nothing to install.
"""

import argparse
import csv
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
CACHE_FILE = DATA_DIR / "submissions.json"
DETAIL_DIR = DATA_DIR / "details"
WORKSPACE_FILE = DATA_DIR / "workspace.json"

API_BASE = "https://filmfreeway.com/api/v1"
PAGE_LIMIT = 1000
# Pre-signed image/PDF links in detail responses expire after 24 hours.
DETAIL_TTL_SECONDS = 20 * 60 * 60

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def load_api_key():
    key = os.environ.get("FILMFREEWAY_API_KEY", "").strip()
    if key:
        return key
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "FILMFREEWAY_API_KEY":
                return value.strip().strip('"').strip("'")
    return ""


class FilmFreewayClient:
    def __init__(self, api_key):
        self.api_key = api_key

    def _get(self, path, params=None):
        url = f"{API_BASE}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
                "User-Agent": "FestivalHub/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            if err.code == 401:
                raise ApiError(401, "FilmFreeway rejected the API key (401). Check FILMFREEWAY_API_KEY.") from err
            raise ApiError(err.code, f"FilmFreeway returned HTTP {err.code}.") from err
        except urllib.error.URLError as err:
            raise ApiError(502, f"Could not reach FilmFreeway: {err.reason}") from err

    def all_submissions(self):
        """Fetch every submission in the current season, following pagination."""
        submissions, meta, after_id = [], {}, None
        while True:
            params = {"limit": PAGE_LIMIT}
            if after_id:
                params["after_id"] = after_id
            page = self._get("/submissions", params)
            batch = page.get("submissions", [])
            meta = page.get("meta", {})
            submissions.extend(batch)
            next_after = meta.get("next_after_id")
            if not batch or not next_after or next_after == after_id or len(submissions) >= meta.get("total_count", 0):
                break
            after_id = next_after
            time.sleep(0.3)
        meta["count"] = len(submissions)
        return submissions, meta

    def submission(self, submission_id):
        data = self._get(f"/submissions/{submission_id}")
        if isinstance(data, dict):
            if isinstance(data.get("submission"), dict):
                return data["submission"]
            if isinstance(data.get("submissions"), list) and data["submissions"]:
                return data["submissions"][0]
        return data


def write_json_atomic(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


class Store:
    """Holds the submissions cache and the team workspace (shortlist, notes, blocks)."""

    def __init__(self, client=None, demo=False):
        self.client = client
        self.demo = demo
        self.lock = threading.Lock()
        self.payload = None

    def submissions(self, refresh=False):
        with self.lock:
            if self.payload and not refresh:
                return self.payload
            if not refresh and not self.demo and CACHE_FILE.exists():
                self.payload = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
                return self.payload
            if self.demo:
                from demo_data import build_demo_payload

                self.payload = build_demo_payload()
                return self.payload
            submissions, meta = self.client.all_submissions()
            self.payload = {"submissions": submissions, "meta": meta, "synced_at": time.time(), "demo": False}
            write_json_atomic(CACHE_FILE, self.payload)
            return self.payload

    def submission_detail(self, submission_id):
        if self.demo:
            for item in self.submissions()["submissions"]:
                if str(item["id"]) == str(submission_id):
                    return item
            raise ApiError(404, "Submission not found.")
        cache_path = DETAIL_DIR / f"{int(submission_id)}.json"
        if cache_path.exists() and time.time() - cache_path.stat().st_mtime < DETAIL_TTL_SECONDS:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        detail = self.client.submission(submission_id)
        write_json_atomic(cache_path, detail)
        return detail

    def workspace(self):
        path = self._workspace_path()
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        return {}

    def save_workspace(self, workspace):
        write_json_atomic(self._workspace_path(), workspace)

    def _workspace_path(self):
        return DATA_DIR / "demo-workspace.json" if self.demo else WORKSPACE_FILE


def make_handler(store):
    class Handler(BaseHTTPRequestHandler):
        server_version = "FestivalHub/1.0"

        def log_message(self, fmt, *args):
            sys.stderr.write("  %s\n" % (fmt % args))

        def _send(self, status, body, content_type="application/json; charset=utf-8"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            elif isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _error(self, err):
            status = err.status if isinstance(err, ApiError) else 500
            self._send(status, {"error": str(err)})

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            path = parsed.path
            try:
                if path == "/api/submissions":
                    payload = store.submissions(refresh=query.get("refresh") == ["1"])
                    return self._send(200, payload)
                match = re.fullmatch(r"/api/submissions/(\d+)", path)
                if match:
                    return self._send(200, store.submission_detail(match.group(1)))
                if path == "/api/workspace":
                    return self._send(200, store.workspace())
                return self._serve_static(path)
            except Exception as err:  # noqa: BLE001 - report every failure to the page
                return self._error(err)

        def do_POST(self):
            if urllib.parse.urlparse(self.path).path != "/api/workspace":
                return self._send(404, {"error": "Not found"})
            # Same-origin guard: the dashboard only ever posts from this server.
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlparse(origin).netloc != self.headers.get("Host"):
                return self._send(403, {"error": "Cross-origin request refused"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > 20 * 1024 * 1024:
                    return self._send(413, {"error": "Workspace too large"})
                workspace = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(workspace, dict):
                    return self._send(400, {"error": "Workspace must be a JSON object"})
                store.save_workspace(workspace)
                return self._send(200, {"ok": True})
            except (ValueError, json.JSONDecodeError):
                return self._send(400, {"error": "Invalid JSON"})

        def _serve_static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            target = (STATIC_DIR / path.lstrip("/")).resolve()
            if STATIC_DIR not in target.parents or not target.is_file():
                return self._send(404, {"error": "Not found"})
            content_type = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
            return self._send(200, target.read_bytes(), content_type)

    return Handler


def export_csv(submissions, path):
    columns = [
        "tracking_number", "id", "title", "director", "categories", "deadline", "status",
        "country", "runtime", "fee", "created_at", "genres", "languages", "student",
        "first_time_filmmaker", "trailer", "average_rating", "acceptance_status",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for item in submissions:
            project = item.get("project") or {}
            directors = [
                entry.get("name", "")
                for credit in project.get("credits") or []
                if re.match(r"^(co-)?directors?\b", (credit.get("type") or "").strip(), re.I)
                for entry in credit.get("entries") or []
            ]
            origin = (project.get("countries_of_origin") or {}).get("names") or []
            writer.writerow([
                item.get("tracking_number"), item.get("id"), (project.get("title") or "").strip(),
                "; ".join(directors), "; ".join(c.strip() for c in item.get("submission_categories") or []),
                "; ".join(item.get("submission_deadlines") or []), item.get("submission_status"),
                origin[0] if origin else project.get("country_name") or "", project.get("duration"),
                item.get("submission_fee"), item.get("created_at"), "; ".join(project.get("genres") or []),
                "; ".join(project.get("languages") or []), project.get("student_project"),
                project.get("first_time_filmmaker"), project.get("press_kit_trailer_url") or "",
                item.get("average_rating", ""), item.get("acceptance_status", ""),
            ])


def command_sync(store):
    payload = store.submissions(refresh=True)
    submissions = payload["submissions"]
    csv_path = DATA_DIR / ("demo-submissions.csv" if store.demo else "submissions.csv")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    export_csv(submissions, csv_path)
    print(f"Synced {len(submissions)} submissions.")
    if not store.demo:
        print(f"  JSON: {CACHE_FILE}")
    print(f"  CSV:  {csv_path}")


def main():
    parser = argparse.ArgumentParser(description="Festival Hub for FilmFreeway submissions")
    parser.add_argument("command", nargs="?", default="serve", choices=["serve", "sync"])
    parser.add_argument("--demo", action="store_true", help="use made-up demo data instead of the API")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (default: this computer only)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    args = parser.parse_args()

    client = None
    if not args.demo:
        api_key = load_api_key()
        if not api_key:
            sys.exit(
                "No API key found.\n"
                "Create a file named .env in this folder containing:\n"
                "    FILMFREEWAY_API_KEY=your-key-here\n"
                "or run with --demo to try the dashboard with made-up data."
            )
        client = FilmFreewayClient(api_key)

    store = Store(client=client, demo=args.demo)

    if args.command == "sync":
        try:
            command_sync(store)
        except ApiError as err:
            sys.exit(str(err))
        return

    server = ThreadingHTTPServer((args.host, args.port), make_handler(store))
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{args.port}/"
    print(f"Festival Hub running at {url}" + ("  (DEMO DATA)" if args.demo else ""))
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
