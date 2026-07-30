#!/usr/bin/env python3
"""Config-driven upload filter for Git AI custom metrics."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


EVENT_TYPES = {
    "/commit": "commit",
    "/legacy/commit": "commit",
    "/checkpoint": "checkpoint",
    "/legacy/checkpoint": "checkpoint",
    "/token-usage": "token",
    "/token-usage/batch": "token",
    "/token-usage/stats": "token",
    "/legacy/token-usage": "token",
    "/skill-usage": "skill",
    "/agent-usage": "agent",
    "/prompt-duration": "prompt_duration",
    "/prompt-report": "prompt_report",
}

HOST = "127.0.0.1"
PORT = 38741
POLICY_CONFIG_PATH = Path.home() / ".git-ai" / "filter_plugins.json"
UPSTREAM_CONFIG_PATH = Path.home() / ".git-ai" / "upstream_metrics.json"
OWNER_REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$")
SKILL_KEYS = {"skillName", "skill", "name"}
PATH_KEYS = {
    "cwd",
    "dir",
    "path",
    "project_dir",
    "projectDir",
    "repoDir",
    "repoRoot",
    "repo_work_dir",
    "repoWorkingDir",
    "root",
    "workspace_root",
    "workspaceRoot",
    "workdir",
    "workingDir",
}
REPOSITORY_KEYS = {
    "repo",
    "reponame",
    "repoid",
    "repourl",
    "repopath",
    "reporemote",
    "reposlug",
    "repoowner",
    "remote",
    "remoteurl",
    "remoteuri",
    "origin",
    "originurl",
    "originuri",
    "giturl",
    "gitremote",
    "url",
    "uri",
}
BRANCH_KEYS = {
    "branch",
    "branchname",
    "branchref",
    "headbranch",
    "basebranch",
    "sourcebranch",
    "targetbranch",
    "ref",
    "headref",
    "baseref",
}
NORMALIZED_PATH_KEYS = {re.sub(r"[^a-z0-9]", "", key.lower()) for key in PATH_KEYS}
DROP = object()

DEFAULT_POLICY_CONFIG = {
    "version": 1,
    "default_allow_unmatched": True,
    "skill_policy": {
        "installed": True,
        "enabled": True,
        "blocked_patterns": [
            "godot",
            r"\bgame\b",
            "game-",
            "-game",
            "game_studio",
            "game-studio",
            "phaser",
            "three",
            "webgl",
            "unity",
            "unreal",
            r"battle[-_ ]?brothers",
            "tactics",
            "sprite",
            "github",
            "git-hub",
            "cloudflare",
            "cloud-flare",
        ],
    },
    "plugins": [
        {
            "id": "github",
            "name": "GitHub 仓库",
            "enabled": True,
            "match": {"hosts": ["github.com"]},
            "fixed_project_directory": "",
            "allow": {
                "token": False,
                "skill": False,
                "commit": False,
                "checkpoint": False,
                "agent": False,
                "prompt_duration": False,
                "prompt_report": False,
            },
            "fields": {
                "repository": False,
                "path": False,
                "branch": False,
            },
        }
    ],
}


def clone_default_policy() -> dict:
    return json.loads(json.dumps(DEFAULT_POLICY_CONFIG))


def load_upstreams() -> tuple[dict[str, str], str]:
    try:
        config = json.loads(UPSTREAM_CONFIG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}, f"missing upstream config: {UPSTREAM_CONFIG_PATH}"
    except (OSError, json.JSONDecodeError) as error:
        return {}, f"invalid upstream config: {error}"

    routes = config.get("routes", config)
    if not isinstance(routes, dict):
        return {}, "invalid upstream config: routes must be an object"

    validated = {}
    for route, url in routes.items():
        if route not in EVENT_TYPES or not isinstance(url, str):
            continue
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            continue
        if parsed.hostname in {HOST, "localhost", "::1"} and parsed.port == PORT:
            continue
        validated[route] = url

    if not validated:
        return {}, "invalid upstream config: no usable routes"
    return validated, ""


def normalize_key(key) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def is_path_key(key) -> bool:
    return normalize_key(key) in NORMALIZED_PATH_KEYS


def is_repository_key(key) -> bool:
    normalized = normalize_key(key)
    return normalized in REPOSITORY_KEYS or normalized.startswith("repository")


def is_branch_key(key) -> bool:
    normalized = normalize_key(key)
    return normalized in BRANCH_KEYS or normalized.startswith("branch")


def iter_all_text(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from iter_all_text(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_all_text(child)
    elif isinstance(value, str):
        yield value


def iter_skill_text(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in SKILL_KEYS:
                yield from iter_all_text(child)
            else:
                yield from iter_skill_text(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_skill_text(child)


def iter_path_text(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if is_path_key(key):
                yield from iter_all_text(child)
            else:
                yield from iter_path_text(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_path_text(child)


def read_remote_text(path: str) -> str:
    if not isinstance(path, str) or not path:
        return ""
    expanded = os.path.expanduser(path)
    candidates = [expanded]
    if os.path.exists(expanded) and not os.path.isdir(expanded):
        candidates.insert(0, os.path.dirname(expanded))
    for candidate in candidates:
        if not os.path.isdir(candidate):
            continue
        try:
            result = subprocess.run(
                ["git", "-C", candidate, "remote", "-v"],
                check=False,
                capture_output=True,
                text=True,
                timeout=2,
            )
        except Exception:
            continue
        if result.stdout:
            return result.stdout
    return ""


def load_policy_config() -> tuple[dict, str]:
    try:
        with POLICY_CONFIG_PATH.open("r", encoding="utf-8") as handle:
            config = json.load(handle)
        if not isinstance(config, dict) or config.get("version") != 1:
            raise ValueError("unsupported policy version")
        if not isinstance(config.get("plugins"), list):
            raise ValueError("plugins must be a list")
        return config, ""
    except Exception as error:
        return clone_default_policy(), str(error)


def host_needles(plugin: dict) -> list[str]:
    hosts = plugin.get("match", {}).get("hosts", [])
    return [
        str(host).lower().replace("*", "").strip()
        for host in hosts
        if str(host).lower().replace("*", "").strip()
    ]


def plugin_matches(plugin: dict, payload, raw_body: bytes) -> bool:
    needles = host_needles(plugin)
    if not needles:
        return False
    raw_text = raw_body.decode("utf-8", errors="ignore").lower()
    if any(needle in raw_text for needle in needles):
        return True
    if any(needle in text.lower() for text in iter_all_text(payload) for needle in needles):
        return True
    for path in iter_path_text(payload):
        remote_text = read_remote_text(path).lower()
        if any(needle in remote_text for needle in needles):
            return True
    return False


def find_matching_plugin(config: dict, payload, raw_body: bytes) -> dict | None:
    for plugin in config.get("plugins", []):
        if plugin.get("enabled", True) and plugin_matches(plugin, payload, raw_body):
            return plugin
    return None


def skill_is_blocked(payload, skill_policy: dict) -> bool:
    if not skill_policy.get("installed", True) or not skill_policy.get("enabled", True):
        return False
    patterns = []
    for pattern in skill_policy.get("blocked_patterns", []):
        try:
            patterns.append(re.compile(str(pattern), re.IGNORECASE))
        except re.error:
            patterns.append(re.compile(re.escape(str(pattern)), re.IGNORECASE))
    return any(
        pattern.search(text)
        for text in iter_skill_text(payload)
        for pattern in patterns
    )


def replace_skill_project_dirs(value, directory: str):
    if isinstance(value, dict):
        replaced = {}
        for key, child in value.items():
            if is_path_key(key):
                replaced[key] = directory
            else:
                replaced[key] = replace_skill_project_dirs(child, directory)
        return replaced
    if isinstance(value, list):
        return [replace_skill_project_dirs(child, directory) for child in value]
    return value


def sanitize_fields(value, fields: dict, hosts: list[str]):
    if isinstance(value, dict):
        sanitized = {}
        for key, child in value.items():
            if not fields.get("path", True) and is_path_key(key):
                continue
            if not fields.get("repository", True) and is_repository_key(key):
                continue
            if not fields.get("branch", True) and is_branch_key(key):
                continue
            cleaned = sanitize_fields(child, fields, hosts)
            if cleaned is not DROP:
                sanitized[key] = cleaned
        return sanitized
    if isinstance(value, list):
        return [
            cleaned
            for child in value
            if (cleaned := sanitize_fields(child, fields, hosts)) is not DROP
        ]
    if isinstance(value, str) and not fields.get("repository", True):
        lowered = value.lower()
        if any(host in lowered for host in hosts) or OWNER_REPOSITORY_PATTERN.fullmatch(value):
            return DROP
    return value


def evaluate_request(
    endpoint_path: str,
    payload,
    raw_body: bytes | None = None,
    config: dict | None = None,
) -> dict:
    if config is None:
        config, config_error = load_policy_config()
    else:
        config_error = ""
    if raw_body is None:
        raw_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    event_type = EVENT_TYPES.get(endpoint_path)
    plugin = find_matching_plugin(config, payload, raw_body)
    plugin_id = plugin.get("id") if plugin else None

    skill_policy = config.get("skill_policy", {})
    if event_type == "skill" and skill_is_blocked(payload, skill_policy):
        return {
            "blocked": True,
            "reason": "skill_pattern",
            "payload": payload,
            "plugin": plugin_id,
            "config_error": config_error,
        }

    if plugin:
        allowed = bool(plugin.get("allow", {}).get(event_type, False))
        if not allowed:
            return {
                "blocked": True,
                "reason": f"plugin:{plugin_id}:{event_type}",
                "payload": payload,
                "plugin": plugin_id,
                "config_error": config_error,
            }
    elif not config.get("default_allow_unmatched", True):
        return {
            "blocked": True,
            "reason": "default_deny",
            "payload": payload,
            "plugin": None,
            "config_error": config_error,
        }

    transformed = payload
    if event_type == "skill" and plugin:
        fixed_directory = str(plugin.get("fixed_project_directory", "")).strip()
        if fixed_directory:
            transformed = replace_skill_project_dirs(transformed, fixed_directory)

    if plugin:
        transformed = sanitize_fields(
            transformed,
            plugin.get("fields", {}),
            host_needles(plugin),
        )
        if transformed is DROP:
            return {
                "blocked": True,
                "reason": f"plugin:{plugin_id}:empty",
                "payload": payload,
                "plugin": plugin_id,
                "config_error": config_error,
            }

    return {
        "blocked": False,
        "reason": "",
        "payload": transformed,
        "plugin": plugin_id,
        "config_error": config_error,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "git-ai-plugin-filter/3.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Allow", "POST,OPTIONS")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            config, config_error = load_policy_config()
            upstreams, upstream_error = load_upstreams()
            self.send_json(
                200,
                {
                    "ok": not bool(config_error or upstream_error),
                    "mode": "plugins",
                    "policyVersion": config.get("version"),
                    "plugins": [
                        plugin.get("id")
                        for plugin in config.get("plugins", [])
                        if plugin.get("enabled", True)
                    ],
                    "configError": config_error or None,
                    "upstreamConfigError": upstream_error or None,
                    "routes": sorted(upstreams),
                },
            )
            return
        self.send_json(404, {"ok": False, "message": "not found"})

    def do_POST(self):
        endpoint_path = urlsplit(self.path).path
        upstreams, upstream_error = load_upstreams()
        if upstream_error:
            self.send_json(
                503,
                {"code": -1, "data": None, "message": upstream_error},
            )
            return
        upstream_url = upstreams.get(endpoint_path)
        if not upstream_url:
            self.send_json(404, {"code": -1, "data": None, "message": "unknown endpoint"})
            return

        length = int(self.headers.get("Content-Length") or "0")
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.send_filtered(endpoint_path, "invalid_json")
            return

        decision = evaluate_request(endpoint_path, payload, body)
        if decision["blocked"]:
            self.send_filtered(endpoint_path, decision["reason"], decision.get("plugin"))
            return

        body = json.dumps(
            decision["payload"],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        request = urllib.request.Request(
            upstream_url,
            data=body,
            method="POST",
            headers={
                "Content-Type": self.headers.get("Content-Type", "application/json"),
                "Accept": self.headers.get("Accept", "application/json"),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response_body = response.read()
                self.send_response(response.status)
                self.send_header(
                    "Content-Type",
                    response.headers.get("Content-Type", "application/json"),
                )
                self.end_headers()
                self.wfile.write(response_body)
        except urllib.error.HTTPError as error:
            self.send_response(error.code)
            self.send_header(
                "Content-Type",
                error.headers.get("Content-Type", "application/json"),
            )
            self.end_headers()
            self.wfile.write(error.read())
        except Exception as error:
            self.send_json(502, {"code": -1, "data": None, "message": str(error)})

    def send_filtered(self, endpoint_path: str, reason: str, plugin: str | None = None):
        self.send_json(
            200,
            {
                "code": 0,
                "data": {
                    "filtered": True,
                    "reason": reason,
                    "plugin": plugin,
                },
                "message": "filtered",
            },
        )
        sys.stderr.write(f"filtered {endpoint_path} reason={reason} plugin={plugin or '-'}\n")

    def send_json(self, status: int, payload):
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"git-ai plugin filter listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
