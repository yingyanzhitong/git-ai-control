#!/usr/bin/env python3
"""Local-only Web configuration service for Git AI and its upload policy."""

from __future__ import annotations

import json
import os
import py_compile
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


HOST = "127.0.0.1"
PORT = 38742
APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
GIT_AI_ROOT = Path.home() / ".git-ai"
NATIVE_CONFIG_PATH = GIT_AI_ROOT / "config.json"
POLICY_CONFIG_PATH = GIT_AI_ROOT / "filter_plugins.json"
CUSTOM_METRICS_PATH = GIT_AI_ROOT / "custom_metrics.json"
FILTER_SCRIPT_PATH = GIT_AI_ROOT / "filters" / "plugin_filter_runtime.py"
FILTER_HEALTH_URL = "http://127.0.0.1:38741/health"
FILTER_LAUNCH_AGENT = f"gui/{os.getuid()}/com.git-ai.skill-usage-filter"

NATIVE_FIELDS = {
    "git_path",
    "exclude_prompts_in_repositories",
    "exclude_repositories",
    "disable_version_checks",
    "disable_auto_updates",
    "telemetry_oss",
}
EVENT_KEYS = {
    "token",
    "skill",
    "commit",
    "checkpoint",
    "agent",
    "prompt_duration",
    "prompt_report",
}
FIELD_KEYS = {"repository", "path", "branch"}
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")


class ConfigError(ValueError):
    pass


def read_json(path: Path, default):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default


def atomic_write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    current_mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, current_mode)
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def public_native_config() -> dict:
    raw = read_json(NATIVE_CONFIG_PATH, {})
    return {key: raw.get(key) for key in NATIVE_FIELDS if key in raw}


def validate_string_list(value, label: str, *, maximum: int = 128) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ConfigError(f"{label} 必须是最多 {maximum} 项的数组")
    result = []
    for item in value:
        if not isinstance(item, str) or not item.strip() or len(item) > 500:
            raise ConfigError(f"{label} 包含无效条目")
        result.append(item.strip())
    return result


def validate_native_config(value) -> dict:
    if not isinstance(value, dict):
        raise ConfigError("Git AI 配置必须是对象")

    result = {}
    if "git_path" in value:
        git_path = value["git_path"]
        if not isinstance(git_path, str) or not git_path.startswith("/") or len(git_path) > 500:
            raise ConfigError("Git 路径必须是绝对路径")
        result["git_path"] = git_path

    for key in ("exclude_prompts_in_repositories", "exclude_repositories"):
        result[key] = validate_string_list(value.get(key, []), key)

    for key in ("disable_version_checks", "disable_auto_updates"):
        candidate = value.get(key, False)
        if not isinstance(candidate, bool):
            raise ConfigError(f"{key} 必须是布尔值")
        result[key] = candidate

    telemetry_oss = value.get("telemetry_oss", "on")
    if telemetry_oss not in {"on", "off"}:
        raise ConfigError("telemetry_oss 只能是 on 或 off")
    result["telemetry_oss"] = telemetry_oss
    return result


def validate_policy_config(value) -> dict:
    if not isinstance(value, dict):
        raise ConfigError("插件策略必须是对象")
    if value.get("version") != 1:
        raise ConfigError("仅支持插件策略版本 1")

    skill_policy = value.get("skill_policy")
    if not isinstance(skill_policy, dict):
        raise ConfigError("缺少 skill_policy")
    skill_enabled = skill_policy.get("enabled", True)
    if not isinstance(skill_enabled, bool):
        raise ConfigError("skill_policy.enabled 必须是布尔值")
    skill_installed = skill_policy.get("installed", True)
    if not isinstance(skill_installed, bool):
        raise ConfigError("skill_policy.installed 必须是布尔值")
    blocked_patterns = validate_string_list(
        skill_policy.get("blocked_patterns", []),
        "blocked_patterns",
        maximum=256,
    )
    for pattern in blocked_patterns:
        try:
            re.compile(pattern)
        except re.error as error:
            raise ConfigError(f"无效的 Skill 正则：{pattern}（{error}）") from error

    plugins = value.get("plugins")
    if not isinstance(plugins, list) or len(plugins) > 1:
        raise ConfigError("仓库插件只能配置一次")

    seen_ids = set()
    normalized_plugins = []
    for index, plugin in enumerate(plugins):
        if not isinstance(plugin, dict):
            raise ConfigError(f"第 {index + 1} 个插件无效")
        plugin_id = plugin.get("id")
        if not isinstance(plugin_id, str) or not ID_PATTERN.fullmatch(plugin_id):
            raise ConfigError(f"第 {index + 1} 个插件 ID 无效")
        if plugin_id in seen_ids:
            raise ConfigError(f"插件 ID 重复：{plugin_id}")
        seen_ids.add(plugin_id)

        name = plugin.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ConfigError(f"插件 {plugin_id} 名称无效")
        enabled = plugin.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ConfigError(f"插件 {plugin_id} enabled 无效")

        match = plugin.get("match")
        if not isinstance(match, dict):
            raise ConfigError(f"插件 {plugin_id} match 无效")
        hosts = validate_string_list(match.get("hosts", []), f"{plugin_id}.match.hosts", maximum=32)
        fixed_directory = plugin.get("fixed_project_directory", "")
        if not isinstance(fixed_directory, str) or len(fixed_directory) > 500:
            raise ConfigError(f"插件 {plugin_id} 的固定项目目录无效")
        if fixed_directory and not fixed_directory.startswith("/"):
            raise ConfigError(f"插件 {plugin_id} 的固定项目目录必须是绝对路径")

        allow = plugin.get("allow")
        if not isinstance(allow, dict) or set(allow) != EVENT_KEYS:
            raise ConfigError(f"插件 {plugin_id} 的数据类型选项不完整")
        if not all(isinstance(allow[key], bool) for key in EVENT_KEYS):
            raise ConfigError(f"插件 {plugin_id} 的数据类型选项必须是布尔值")

        fields = plugin.get("fields")
        if not isinstance(fields, dict) or set(fields) != FIELD_KEYS:
            raise ConfigError(f"插件 {plugin_id} 的字段选项不完整")
        if not all(isinstance(fields[key], bool) for key in FIELD_KEYS):
            raise ConfigError(f"插件 {plugin_id} 的字段选项必须是布尔值")

        normalized_plugins.append(
            {
                "id": plugin_id,
                "name": name.strip(),
                "enabled": enabled,
                "match": {"hosts": hosts},
                "fixed_project_directory": fixed_directory,
                "allow": {key: allow[key] for key in sorted(EVENT_KEYS)},
                "fields": {key: fields[key] for key in sorted(FIELD_KEYS)},
            }
        )

    return {
        "version": 1,
        "default_allow_unmatched": bool(value.get("default_allow_unmatched", True)),
        "skill_policy": {
            "installed": skill_installed,
            "enabled": skill_enabled,
            "blocked_patterns": blocked_patterns,
        },
        "plugins": normalized_plugins,
    }


def merge_native_config(public_value: dict) -> dict:
    current = read_json(NATIVE_CONFIG_PATH, {})
    for key in NATIVE_FIELDS:
        current.pop(key, None)
    current.update(public_value)
    return current


def save_config_bundle(payload: dict) -> None:
    if not isinstance(payload, dict):
        raise ConfigError("请求内容必须是对象")
    native = validate_native_config(payload.get("gitAi"))
    policy = validate_policy_config(payload.get("policy"))
    merged_native = merge_native_config(native)

    previous_native = NATIVE_CONFIG_PATH.read_bytes() if NATIVE_CONFIG_PATH.exists() else None
    previous_policy = POLICY_CONFIG_PATH.read_bytes() if POLICY_CONFIG_PATH.exists() else None
    try:
        atomic_write_json(POLICY_CONFIG_PATH, policy)
        atomic_write_json(NATIVE_CONFIG_PATH, merged_native)
    except Exception:
        if previous_native is not None:
            NATIVE_CONFIG_PATH.write_bytes(previous_native)
        if previous_policy is not None:
            POLICY_CONFIG_PATH.write_bytes(previous_policy)
        raise


def filter_health() -> dict:
    try:
        with urllib.request.urlopen(FILTER_HEALTH_URL, timeout=2) as response:
            data = json.loads(response.read().decode("utf-8"))
            return {"ok": response.status == 200 and bool(data.get("ok")), "details": data}
    except Exception as error:
        return {"ok": False, "error": str(error)}


def launch_agent_status() -> dict:
    result = subprocess.run(
        ["launchctl", "print", FILTER_LAUNCH_AGENT],
        check=False,
        capture_output=True,
        text=True,
        timeout=3,
    )
    state_match = re.search(r"^\s*state = (\w+)", result.stdout, re.MULTILINE)
    return {
        "ok": result.returncode == 0 and state_match and state_match.group(1) == "running",
        "state": state_match.group(1) if state_match else "missing",
    }


def git_ai_version() -> str:
    binary = GIT_AI_ROOT / "bin" / "git-ai"
    try:
        result = subprocess.run(
            [str(binary), "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
        return result.stdout.strip() or result.stderr.strip() or "unknown"
    except Exception:
        return "unknown"


@lru_cache(maxsize=1)
def custom_metrics_supported() -> bool:
    binary = GIT_AI_ROOT / "bin" / "git-ai"
    try:
        return b"custom_metrics.json" in binary.read_bytes()
    except Exception:
        return False


def custom_metrics_routed() -> bool:
    metrics = read_json(CUSTOM_METRICS_PATH, {})
    endpoint_keys = {
        "commit_endpoint",
        "checkpoint_endpoint",
        "token_usage_endpoint",
        "prompt_duration_endpoint",
        "commit_endpoint_v2",
        "checkpoint_endpoint_v2",
        "token_usage_endpoint_v2",
        "skill_usage_endpoint_v2",
        "agent_usage_endpoint_v2",
        "prompt_report_endpoint_v2",
    }
    return all(
        isinstance(metrics.get(key), str)
        and metrics[key].startswith("http://127.0.0.1:38741/")
        for key in endpoint_keys
    )


def runtime_status() -> dict:
    health = filter_health()
    agent = launch_agent_status()
    supports_custom_metrics = custom_metrics_supported()
    routes_are_local = custom_metrics_routed() if supports_custom_metrics else False
    granular_filter_active = (
        supports_custom_metrics
        and routes_are_local
        and bool(health.get("ok"))
        and bool(agent.get("ok"))
    )
    return {
        "ok": granular_filter_active if supports_custom_metrics else True,
        "distribution": "custom-metrics" if supports_custom_metrics else "upstream-oss",
        "granularFilterActive": granular_filter_active,
        "capabilities": {
            "nativeConfig": True,
            "granularUploadFilter": supports_custom_metrics,
        },
        "filter": health,
        "launchAgent": agent,
        "gitAiVersion": git_ai_version(),
        "paths": {
            "nativeConfig": str(NATIVE_CONFIG_PATH),
            "policyConfig": str(POLICY_CONFIG_PATH),
            "customMetrics": str(CUSTOM_METRICS_PATH),
            "filterScript": str(FILTER_SCRIPT_PATH),
        },
    }


def run_self_test() -> dict:
    checks = []
    try:
        py_compile.compile(str(FILTER_SCRIPT_PATH), doraise=True)
        checks.append({"name": "过滤脚本语法", "ok": True})
    except Exception as error:
        checks.append({"name": "过滤脚本语法", "ok": False, "message": str(error)})

    policy = read_json(POLICY_CONFIG_PATH, {})
    try:
        validate_policy_config(policy)
        checks.append({"name": "插件策略格式", "ok": True})
    except Exception as error:
        checks.append({"name": "插件策略格式", "ok": False, "message": str(error)})

    if custom_metrics_supported():
        checks.append(
            {
                "name": "上报端点路由",
                "ok": custom_metrics_routed(),
                "message": "" if custom_metrics_routed() else "custom_metrics.json 未完整指向本机过滤服务",
            }
        )
        health = filter_health()
        checks.append(
            {
                "name": "过滤服务连接",
                "ok": bool(health.get("ok")),
                "message": health.get("error", ""),
            }
        )
    else:
        checks.append(
            {
                "name": "细粒度过滤扩展点",
                "ok": False,
                "message": "官方上游版未提供 custom_metrics.json 扩展点；原生配置可用，插件上报规则不会生效",
            }
        )
    return {"ok": all(item["ok"] for item in checks), "checks": checks}


class Handler(BaseHTTPRequestHandler):
    server_version = "git-ai-control-panel/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.log_date_time_string(), fmt % args))

    def origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return origin in {
            f"http://{HOST}:{PORT}",
            f"http://localhost:{PORT}",
        }

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/config":
            self.send_json(
                200,
                {
                    "gitAi": public_native_config(),
                    "policy": read_json(POLICY_CONFIG_PATH, {}),
                    "runtime": runtime_status(),
                },
            )
            return
        if path == "/api/status":
            self.send_json(200, runtime_status())
            return
        self.serve_static(path)

    def do_PUT(self):
        if not self.origin_allowed():
            self.send_json(403, {"ok": False, "message": "请求来源不允许"})
            return
        if urlsplit(self.path).path != "/api/config":
            self.send_json(404, {"ok": False, "message": "接口不存在"})
            return
        try:
            payload = self.read_json_body()
            save_config_bundle(payload)
            self.send_json(
                200,
                {
                    "ok": True,
                    "message": "配置已保存",
                    "gitAi": public_native_config(),
                    "policy": read_json(POLICY_CONFIG_PATH, {}),
                },
            )
        except ConfigError as error:
            self.send_json(400, {"ok": False, "message": str(error)})
        except Exception as error:
            self.send_json(500, {"ok": False, "message": f"保存失败：{error}"})

    def do_POST(self):
        if not self.origin_allowed():
            self.send_json(403, {"ok": False, "message": "请求来源不允许"})
            return
        path = urlsplit(self.path).path
        if path == "/api/test":
            self.send_json(200, run_self_test())
            return
        if path == "/api/restart-filter":
            result = subprocess.run(
                ["launchctl", "kickstart", "-k", FILTER_LAUNCH_AGENT],
                check=False,
                capture_output=True,
                text=True,
                timeout=6,
            )
            self.send_json(
                200 if result.returncode == 0 else 500,
                {
                    "ok": result.returncode == 0,
                    "message": "过滤服务已重启" if result.returncode == 0 else result.stderr.strip(),
                },
            )
            return
        self.send_json(404, {"ok": False, "message": "接口不存在"})

    def read_json_body(self):
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0 or length > 1_000_000:
            raise ConfigError("请求大小无效")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ConfigError("请求不是有效 JSON") from error

    def serve_static(self, path: str):
        relative = "index.html" if path in {"", "/"} else unquote(path).lstrip("/")
        candidate = (STATIC_ROOT / relative).resolve()
        try:
            candidate.relative_to(STATIC_ROOT.resolve())
        except ValueError:
            self.send_error(404)
            return
        if not candidate.is_file():
            self.send_error(404)
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(candidate.suffix, "application/octet-stream")
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status: int, payload):
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Git AI Control Panel: http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
