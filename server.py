#!/usr/bin/env python3
"""Local-only Web configuration service for Git AI and its upload policy."""

from __future__ import annotations

import json
import os
import platform
import py_compile
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


HOST = "127.0.0.1"
PORT = 38742
APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
GIT_AI_ROOT = Path(os.environ.get("GIT_AI_ROOT", Path.home() / ".git-ai")).resolve()
NATIVE_CONFIG_PATH = GIT_AI_ROOT / "config.json"
POLICY_CONFIG_PATH = GIT_AI_ROOT / "filter_plugins.json"
CUSTOM_METRICS_PATH = GIT_AI_ROOT / "custom_metrics.json"
FILTER_SCRIPT_PATH = GIT_AI_ROOT / "filters" / "plugin_filter_runtime.py"
FILTER_AUDIT_PATH = GIT_AI_ROOT / "filter_audit.jsonl"
FILTER_AUDIT_RETENTION = timedelta(hours=24)
FILTER_HEALTH_URL = "http://127.0.0.1:38741/health"
FILTER_MAC_LABEL = "com.git-ai.skill-usage-filter"
FILTER_LINUX_UNIT = "git-ai-filter.service"
FILTER_WINDOWS_TASK = "GitAIFilter"

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
SENSITIVE_RULE_KEYS = {"api_key", "private_key", "credential", "email", "phone"}
POLICY_PLUGIN_ORDER_KEYS = {"skill_filter", "sensitive_data", "agent_model"}
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
    public = {key: raw.get(key) for key in NATIVE_FIELDS if key in raw}
    if not public.get("git_path"):
        public["git_path"] = shutil.which("git") or ""
    return public


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
        if (
            not isinstance(git_path, str)
            or not os.path.isabs(git_path)
            or len(git_path) > 500
        ):
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


def default_event_switches() -> dict:
    return {key: True for key in sorted(EVENT_KEYS)}


def validate_event_switches(value, label: str, *, default: bool = True) -> dict:
    if value is None:
        return {key: default for key in sorted(EVENT_KEYS)}
    if not isinstance(value, dict) or set(value) != EVENT_KEYS:
        raise ConfigError(f"{label} 必须包含全部数据类型")
    if not all(isinstance(value[key], bool) for key in EVENT_KEYS):
        raise ConfigError(f"{label} 的数据类型选项必须是布尔值")
    return {key: value[key] for key in sorted(EVENT_KEYS)}


def validate_plugin_control(value, label: str, *, extra: dict) -> dict:
    if not isinstance(value, dict):
        raise ConfigError(f"缺少 {label}")
    installed = value.get("installed", False)
    enabled = value.get("enabled", False)
    if not isinstance(installed, bool) or not isinstance(enabled, bool):
        raise ConfigError(f"{label} 的安装和启用状态必须是布尔值")
    return {"installed": installed, "enabled": enabled, **extra}


def normalize_plugin_order(
    value,
    plugins: list[dict],
    *,
    skill_installed: bool,
    sensitive_installed: bool,
    agent_model_installed: bool,
) -> list[str]:
    expected = [f"repository:{plugin['id']}" for plugin in plugins]
    if skill_installed:
        expected.append("skill_filter")
    if sensitive_installed:
        expected.append("sensitive_data")
    if agent_model_installed:
        expected.append("agent_model")

    if value is None:
        return expected
    if not isinstance(value, list) or len(value) > len(expected) + len(POLICY_PLUGIN_ORDER_KEYS):
        raise ConfigError("plugin_order 必须是有效的插件顺序数组")

    expected_keys = set(expected)
    result = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 80:
            raise ConfigError("plugin_order 包含无效条目")
        if item in expected_keys and item not in result:
            result.append(item)
    return [*result, *(item for item in expected if item not in result)]


def validate_policy_config(value) -> dict:
    if not isinstance(value, dict):
        raise ConfigError("插件策略必须是对象")
    if value.get("version") not in {1, 2}:
        raise ConfigError("仅支持插件策略版本 1 或 2")

    git_ai_enabled = value.get("git_ai_enabled", True)
    if not isinstance(git_ai_enabled, bool):
        raise ConfigError("git_ai_enabled 必须是布尔值")

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
    if not isinstance(plugins, list) or len(plugins) > 32:
        raise ConfigError("仓库插件最多配置 32 个")

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
        repositories = validate_string_list(
            match.get("repositories", []), f"{plugin_id}.match.repositories", maximum=64
        )
        directories = validate_string_list(
            match.get("directories", []), f"{plugin_id}.match.directories", maximum=64
        )
        branches = validate_string_list(
            match.get("branches", []), f"{plugin_id}.match.branches", maximum=64
        )
        all_repositories = match.get("all_repositories", False)
        if not isinstance(all_repositories, bool):
            raise ConfigError(f"{plugin_id}.match.all_repositories 必须是布尔值")
        if not all_repositories and not any((hosts, repositories, directories, branches)):
            raise ConfigError(f"插件 {plugin_id} 至少需要一个匹配条件，或开启全部仓库")
        priority = plugin.get("priority", 100)
        if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 1000:
            raise ConfigError(f"插件 {plugin_id} 的优先级必须是 0 到 1000 的整数")
        fixed_directory = plugin.get("fixed_project_directory", "")
        if not isinstance(fixed_directory, str) or len(fixed_directory) > 500:
            raise ConfigError(f"插件 {plugin_id} 的固定项目目录无效")
        if fixed_directory and not os.path.isabs(fixed_directory):
            raise ConfigError(f"插件 {plugin_id} 的固定项目目录必须是绝对路径")

        allow = plugin.get("allow")
        allow = validate_event_switches(allow, f"插件 {plugin_id} 的数据类型选项")

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
                "priority": priority,
                "match": {
                    "all_repositories": all_repositories,
                    "hosts": hosts,
                    "repositories": repositories,
                    "directories": directories,
                    "branches": branches,
                },
                "fixed_project_directory": fixed_directory,
                "allow": allow,
                "fields": {key: fields[key] for key in sorted(FIELD_KEYS)},
            }
        )

    sensitive = value.get("sensitive_data_policy", {})
    sensitive_rules = sensitive.get("built_in_rules", {}) if isinstance(sensitive, dict) else {}
    if sensitive_rules and set(sensitive_rules) != SENSITIVE_RULE_KEYS:
        raise ConfigError("敏感内容插件的内置规则不完整")
    if sensitive_rules and not all(isinstance(sensitive_rules[key], bool) for key in SENSITIVE_RULE_KEYS):
        raise ConfigError("敏感内容插件的内置规则必须是布尔值")
    sensitive_patterns = validate_string_list(
        sensitive.get("custom_patterns", []) if isinstance(sensitive, dict) else [],
        "敏感内容插件自定义正则",
        maximum=64,
    )
    for pattern in sensitive_patterns:
        try:
            re.compile(pattern)
        except re.error as error:
            raise ConfigError(f"无效的敏感内容正则：{pattern}（{error}）") from error
    sensitive_action = sensitive.get("action", "redact") if isinstance(sensitive, dict) else "redact"
    if sensitive_action not in {"redact", "block"}:
        raise ConfigError("敏感内容插件动作只能是 redact 或 block")
    normalized_sensitive = validate_plugin_control(
        sensitive,
        "敏感内容插件",
        extra={
            "action": sensitive_action,
            "event_types": validate_event_switches(
                sensitive.get("event_types") if isinstance(sensitive, dict) else None,
                "敏感内容插件作用事件",
            ),
            "built_in_rules": {
                key: sensitive_rules.get(key, key in {"api_key", "private_key", "credential"})
                for key in sorted(SENSITIVE_RULE_KEYS)
            },
            "custom_patterns": sensitive_patterns,
        },
    )

    agent_model = value.get("agent_model_policy", {})
    agent_mode = agent_model.get("mode", "audit") if isinstance(agent_model, dict) else "audit"
    if agent_mode not in {"audit", "block"}:
        raise ConfigError("Agent / 模型治理模式只能是 audit 或 block")
    agent_blocked_patterns = validate_string_list(
        agent_model.get("blocked_patterns", []) if isinstance(agent_model, dict) else [],
        "Agent / 模型治理拦截正则",
        maximum=128,
    )
    for pattern in agent_blocked_patterns:
        try:
            re.compile(pattern)
        except re.error as error:
            raise ConfigError(f"无效的 Agent / 模型正则：{pattern}（{error}）") from error
    normalized_agent_model = validate_plugin_control(
        agent_model,
        "Agent / 模型治理插件",
        extra={
            "mode": agent_mode,
            "allowed_agents": validate_string_list(
                agent_model.get("allowed_agents", []) if isinstance(agent_model, dict) else [],
                "允许的 Agent",
                maximum=128,
            ),
            "allowed_models": validate_string_list(
                agent_model.get("allowed_models", []) if isinstance(agent_model, dict) else [],
                "允许的模型",
                maximum=128,
            ),
            "blocked_patterns": agent_blocked_patterns,
        },
    )
    plugin_order = normalize_plugin_order(
        value.get("plugin_order"),
        normalized_plugins,
        skill_installed=skill_installed,
        sensitive_installed=normalized_sensitive["installed"],
        agent_model_installed=normalized_agent_model["installed"],
    )

    return {
        "version": 2,
        "git_ai_enabled": git_ai_enabled,
        "default_allow_unmatched": bool(value.get("default_allow_unmatched", True)),
        "skill_policy": {
            "installed": skill_installed,
            "enabled": skill_enabled,
            "blocked_patterns": blocked_patterns,
        },
        "plugins": normalized_plugins,
        "plugin_order": plugin_order,
        "sensitive_data_policy": normalized_sensitive,
        "agent_model_policy": normalized_agent_model,
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


def service_manager_name() -> str:
    return {
        "Darwin": "launchd",
        "Linux": "systemd-user",
        "Windows": "task-scheduler",
    }.get(platform.system(), "unknown")


def filter_service_status(health: dict | None = None) -> dict:
    manager = service_manager_name()
    if health and health.get("ok"):
        return {"ok": True, "state": "running", "manager": manager}

    try:
        if platform.system() == "Darwin":
            label = f"gui/{os.getuid()}/{FILTER_MAC_LABEL}"
            result = subprocess.run(
                ["launchctl", "print", label],
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
            )
            state_match = re.search(r"^\s*state = (\w+)", result.stdout, re.MULTILINE)
            state = state_match.group(1) if state_match else "missing"
            return {
                "ok": result.returncode == 0 and state == "running",
                "state": state,
                "manager": manager,
            }
        if platform.system() == "Linux":
            result = subprocess.run(
                ["systemctl", "--user", "is-active", FILTER_LINUX_UNIT],
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
            )
            state = result.stdout.strip() or "missing"
            return {
                "ok": result.returncode == 0 and state == "active",
                "state": "running" if state == "active" else state,
                "manager": manager,
            }
        if platform.system() == "Windows":
            result = subprocess.run(
                ["schtasks.exe", "/Query", "/TN", FILTER_WINDOWS_TASK],
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
            )
            return {
                "ok": False,
                "state": "registered" if result.returncode == 0 else "missing",
                "manager": manager,
            }
    except Exception as error:
        return {"ok": False, "state": "unknown", "manager": manager, "error": str(error)}
    return {"ok": False, "state": "unsupported", "manager": manager}


def git_ai_binary_path() -> Path:
    candidates = [
        GIT_AI_ROOT / "bin" / "git-ai.exe",
        GIT_AI_ROOT / "bin" / "git-ai",
    ]
    return next((candidate for candidate in candidates if candidate.exists()), candidates[-1])


def git_ai_version() -> str:
    binary = git_ai_binary_path()
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
    binary = git_ai_binary_path()
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
    service = filter_service_status(health)
    supports_custom_metrics = custom_metrics_supported()
    routes_are_local = custom_metrics_routed() if supports_custom_metrics else False
    granular_filter_active = (
        supports_custom_metrics
        and routes_are_local
        and bool(health.get("ok"))
        and bool(service.get("ok"))
    )
    policy = read_json(POLICY_CONFIG_PATH, {})
    git_ai_enabled = (
        policy.get("git_ai_enabled", True)
        if isinstance(policy, dict) and isinstance(policy.get("git_ai_enabled", True), bool)
        else True
    )
    return {
        "ok": granular_filter_active if supports_custom_metrics else True,
        "gitAiEnabled": git_ai_enabled,
        "gitAiStatus": "enabled" if git_ai_enabled else "paused",
        "distribution": "custom-metrics" if supports_custom_metrics else "upstream-oss",
        "granularFilterActive": granular_filter_active,
        "capabilities": {
            "nativeConfig": True,
            "granularUploadFilter": supports_custom_metrics,
        },
        "filter": health,
        "launchAgent": service,
        "service": service,
        "platform": platform.system().lower(),
        "gitAiVersion": git_ai_version(),
        "paths": {
            "nativeConfig": str(NATIVE_CONFIG_PATH),
            "policyConfig": str(POLICY_CONFIG_PATH),
            "customMetrics": str(CUSTOM_METRICS_PATH),
            "filterScript": str(FILTER_SCRIPT_PATH),
        },
    }


def read_filter_audit_events(now: datetime | None = None) -> tuple[str, list[dict]]:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now = now.astimezone(timezone.utc)
    cutoff = now - FILTER_AUDIT_RETENTION
    events = []
    try:
        lines = FILTER_AUDIT_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []

    for line in lines:
        try:
            event = json.loads(line)
            timestamp = datetime.fromisoformat(str(event.get("timestamp", "")).replace("Z", "+00:00"))
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
            continue
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        timestamp = timestamp.astimezone(timezone.utc)
        if timestamp < cutoff or not isinstance(event, dict):
            continue
        repositories = event.get("repositories", [])
        skills = event.get("skills", [])
        events.append(
            {
                "timestamp": timestamp.isoformat(timespec="seconds").replace("+00:00", "Z"),
                "eventType": str(event.get("eventType", ""))[:80],
                "reason": str(event.get("reason", ""))[:160],
                "plugin": str(event["plugin"])[:80] if event.get("plugin") else None,
                "repositories": [
                    str(value)[:240]
                    for value in repositories
                    if isinstance(value, str) and value.strip()
                ][:10]
                if isinstance(repositories, list)
                else [],
                "skills": [
                    str(value)[:160]
                    for value in skills
                    if isinstance(value, str) and value.strip()
                ][:10]
                if isinstance(skills, list)
                else [],
            }
        )
    return (
        cutoff.isoformat(timespec="seconds").replace("+00:00", "Z"),
        sorted(events, key=lambda event: event["timestamp"], reverse=True)[:2_000],
    )


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


def restart_filter_service() -> subprocess.CompletedProcess:
    system = platform.system()
    if system == "Darwin":
        label = f"gui/{os.getuid()}/{FILTER_MAC_LABEL}"
        command = ["launchctl", "kickstart", "-k", label]
    elif system == "Linux":
        command = ["systemctl", "--user", "restart", FILTER_LINUX_UNIT]
    elif system == "Windows":
        subprocess.run(
            ["schtasks.exe", "/End", "/TN", FILTER_WINDOWS_TASK],
            check=False,
            capture_output=True,
            text=True,
            timeout=6,
        )
        command = ["schtasks.exe", "/Run", "/TN", FILTER_WINDOWS_TASK]
    else:
        return subprocess.CompletedProcess(
            args=[],
            returncode=1,
            stdout="",
            stderr=f"不支持当前操作系统：{system}",
        )
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=6,
    )


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
        if path == "/api/filter-events":
            since, events = read_filter_audit_events()
            self.send_json(200, {"since": since, "events": events})
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
                    "runtime": runtime_status(),
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
            result = restart_filter_service()
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
