#!/usr/bin/env python3
"""Config-driven upload filter for Git AI custom metrics."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from fnmatch import fnmatchcase
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
GIT_AI_ROOT = Path(os.environ.get("GIT_AI_ROOT", Path.home() / ".git-ai")).resolve()
POLICY_CONFIG_PATH = GIT_AI_ROOT / "filter_plugins.json"
UPSTREAM_CONFIG_PATH = GIT_AI_ROOT / "upstream_metrics.json"
FILTER_AUDIT_PATH = GIT_AI_ROOT / "filter_audit.jsonl"
RECENT_SKILL_HOLD_PATH = GIT_AI_ROOT / "recent_skill_holds.json"
FILTER_AUDIT_RETENTION = timedelta(hours=24)
FILTER_AUDIT_MAX_EVENTS = 2_000
FILTER_AUDIT_LOCK = threading.Lock()
RECENT_SKILL_HOLD_LOCK = threading.Lock()
RECENT_DIRECTORY_MAX_AGE = timedelta(days=7)
RECENT_SKILL_HOLD_DURATION = timedelta(hours=24)
RECENT_SKILL_HOLD_RETENTION = timedelta(days=7)
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
AGENT_KEYS = {"agent", "agentname", "agentid", "agenttype", "tool", "toolname"}
MODEL_KEYS = {"model", "modelname", "modelid", "llmmodel"}
SENSITIVE_PATTERNS = {
    "api_key": re.compile(
        r"(?i)\b(?:sk|rk|ghp|github_pat|glpat|xox[baprs]|akia)[a-z0-9_=-]{12,}\b"
    ),
    "private_key": re.compile(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"
    ),
    "credential": re.compile(
        r"(?i)\b(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*([^\s,;\]\}]{4,})"
    ),
    "email": re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
    "phone": re.compile(r"(?<!\d)(?:\+?\d[\s-]?){7,14}\d(?!\d)"),
}
DROP = object()

DEFAULT_POLICY_CONFIG = {
    "version": 2,
    "git_ai_enabled": True,
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
        "recent_directory_guard": {
            "enabled": True,
            "allowlist_patterns": [],
            "blocklist_patterns": [],
        },
    },
    "plugins": [
        {
            "id": "github",
            "name": "GitHub 仓库",
            "enabled": True,
            "priority": 100,
            "match": {
                "all_repositories": False,
                "hosts": ["github.com"],
                "repositories": [],
                "directories": [],
                "branches": [],
            },
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
    "plugin_order": ["repository:github", "skill_filter"],
    "sensitive_data_policy": {
        "installed": False,
        "enabled": False,
        "action": "redact",
        "event_types": {
            "token": True,
            "skill": True,
            "commit": True,
            "checkpoint": True,
            "agent": True,
            "prompt_duration": True,
            "prompt_report": True,
        },
        "built_in_rules": {
            "api_key": True,
            "private_key": True,
            "credential": True,
            "email": False,
            "phone": False,
        },
        "custom_patterns": [],
    },
    "agent_model_policy": {
        "installed": False,
        "enabled": False,
        "mode": "audit",
        "allowed_agents": [],
        "allowed_models": [],
        "blocked_patterns": [],
    },
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


def skill_names(payload) -> list[str]:
    names = set()
    for value in iter_skill_text(payload):
        name = audit_text(value, 160)
        if name:
            names.add(name)
    return sorted(names)


def audit_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_audit_timestamp(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp.astimezone(timezone.utc)


def audit_text(value, maximum: int = 240) -> str:
    return str(value).strip()[:maximum]


def audit_repository_label(value) -> str:
    label = audit_text(value)
    label = re.sub(r"([a-z][a-z0-9+.-]*://)[^/\s]*@", r"\1", label, flags=re.IGNORECASE)
    label = re.sub(r"^[^@/\s]+@", "", label)
    return label.split("?", 1)[0].split("#", 1)[0]


def read_filter_audit_events(
    *, now: datetime | None = None, path: Path | None = None
) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    cutoff = now.astimezone(timezone.utc) - FILTER_AUDIT_RETENTION
    path = path or FILTER_AUDIT_PATH
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []

    events = []
    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        timestamp = parse_audit_timestamp(event.get("timestamp"))
        if timestamp is None or timestamp < cutoff:
            continue
        repositories = sorted(
            {
                label
                for value in event.get("repositories", [])
                if isinstance(value, str)
                if (label := audit_repository_label(value))
            }
        )[:10]
        skills = sorted(
            {
                label
                for value in event.get("skills", [])
                if isinstance(value, str)
                if (label := audit_text(value, 160))
            }
        )[:10]
        events.append(
            {
                "timestamp": timestamp.isoformat(timespec="seconds").replace("+00:00", "Z"),
                "eventType": audit_text(event.get("eventType", ""), 80),
                "reason": audit_text(event.get("reason", ""), 160),
                "plugin": audit_text(event.get("plugin", ""), 80) or None,
                "repositories": repositories,
                "skills": skills,
            }
        )
    return sorted(events, key=lambda event: event["timestamp"], reverse=True)[:FILTER_AUDIT_MAX_EVENTS]


def write_filter_audit_events(events: list[dict], *, path: Path | None = None) -> None:
    path = path or FILTER_AUDIT_PATH
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(
            "".join(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n" for event in events),
            encoding="utf-8",
        )
        if os.name != "nt":
            os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        if temporary:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def record_filter_event(
    endpoint_path: str, payload, reason: str, plugin: str | None = None
) -> None:
    event = {
        "timestamp": audit_timestamp(),
        "eventType": EVENT_TYPES.get(endpoint_path, ""),
        "reason": reason,
        "plugin": plugin,
        "repositories": sorted(
            {
                label
                for value in iter_repository_text(payload)
                if (label := audit_repository_label(value))
            }
        )[:10],
        "skills": sorted(
            {
                label
                for value in iter_skill_text(payload)
                if (label := audit_text(value, 160))
            }
        )[:10],
    }
    with FILTER_AUDIT_LOCK:
        events = read_filter_audit_events()
        events.append(event)
        write_filter_audit_events(
            sorted(events, key=lambda item: item["timestamp"], reverse=True)[:FILTER_AUDIT_MAX_EVENTS]
        )


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


def iter_repository_text(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if is_repository_key(key):
                yield from iter_all_text(child)
            else:
                yield from iter_repository_text(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_repository_text(child)


def iter_branch_text(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if is_branch_key(key):
                yield from iter_all_text(child)
            else:
                yield from iter_branch_text(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_branch_text(child)


def iter_named_text(value, keys: set[str]):
    if isinstance(value, dict):
        for key, child in value.items():
            if normalize_key(key) in keys:
                yield from iter_all_text(child)
            else:
                yield from iter_named_text(child, keys)
    elif isinstance(value, list):
        for child in value:
            yield from iter_named_text(child, keys)


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
        if not isinstance(config, dict) or config.get("version") not in {1, 2}:
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


def selector_matches(pattern: str, candidates) -> bool:
    normalized_pattern = str(pattern).strip().lower()
    if not normalized_pattern:
        return False
    for candidate in candidates:
        normalized_candidate = str(candidate).lower()
        if fnmatchcase(normalized_candidate, normalized_pattern):
            return True
        if "*" not in normalized_pattern and "?" not in normalized_pattern and normalized_pattern in normalized_candidate:
            return True
    return False


def selectors_match(patterns, candidates) -> bool:
    if not patterns:
        return True
    return any(selector_matches(pattern, candidates) for pattern in patterns)


def plugin_matches(plugin: dict, payload, raw_body: bytes) -> bool:
    match = plugin.get("match", {})
    if match.get("all_repositories", False):
        return True
    needles = host_needles(plugin)
    repositories = match.get("repositories", [])
    directories = match.get("directories", [])
    branches = match.get("branches", [])
    if not any((needles, repositories, directories, branches)):
        return False
    raw_text = raw_body.decode("utf-8", errors="ignore").lower()
    path_values = list(iter_path_text(payload))
    remote_values = [read_remote_text(path) for path in path_values]
    host_values = [raw_text, *iter_all_text(payload), *remote_values]
    repository_values = [*iter_repository_text(payload), *remote_values]
    return (
        selectors_match(needles, host_values)
        and selectors_match(repositories, repository_values)
        and selectors_match(directories, path_values)
        and selectors_match(branches, iter_branch_text(payload))
    )


def plugin_sort_key(item) -> tuple[int, int, int]:
    index, plugin = item
    match = plugin.get("match", {})
    global_rule = bool(match.get("all_repositories", False))
    priority = plugin.get("priority", 100)
    return (1 if global_rule else 0, -priority if isinstance(priority, int) else -100, index)


def find_matching_plugin(config: dict, payload, raw_body: bytes) -> dict | None:
    plugins = sorted(enumerate(config.get("plugins", [])), key=plugin_sort_key)
    for _, plugin in plugins:
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


def sensitive_policy_matches(policy: dict, event_type: str | None) -> bool:
    return bool(
        policy.get("installed", False)
        and policy.get("enabled", False)
        and policy.get("event_types", {}).get(event_type, False)
    )


def redact_sensitive_content(value, policy: dict) -> tuple[object, list[str]]:
    patterns = [
        (name, pattern)
        for name, pattern in SENSITIVE_PATTERNS.items()
        if policy.get("built_in_rules", {}).get(name, False)
    ]
    for index, source in enumerate(policy.get("custom_patterns", []), start=1):
        try:
            patterns.append((f"custom_{index}", re.compile(str(source), re.IGNORECASE)))
        except re.error:
            continue

    findings: list[str] = []

    def clean(current):
        if isinstance(current, dict):
            return {key: clean(child) for key, child in current.items()}
        if isinstance(current, list):
            return [clean(child) for child in current]
        if not isinstance(current, str):
            return current
        sanitized = current
        for name, pattern in patterns:
            sanitized, count = pattern.subn(f"[已脱敏:{name}]", sanitized)
            if count:
                findings.append(name)
        return sanitized

    return clean(value), sorted(set(findings))


def matches_allowlist(value: str, patterns) -> bool:
    return any(selector_matches(pattern, [value]) for pattern in patterns)


def compile_skill_patterns(patterns) -> list[re.Pattern]:
    compiled = []
    for pattern in patterns:
        try:
            compiled.append(re.compile(str(pattern), re.IGNORECASE))
        except re.error:
            continue
    return compiled


def directory_created_at(path: Path) -> datetime | None:
    try:
        metadata = path.stat()
    except OSError:
        return None

    timestamp = getattr(metadata, "st_birthtime", None)
    if timestamp is None and os.name == "nt":
        timestamp = metadata.st_ctime
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, timezone.utc)


def recent_payload_directories(payload, now: datetime) -> list[str]:
    directories = set()
    for value in iter_path_text(payload):
        if not isinstance(value, str) or not value.strip():
            continue
        try:
            path = Path(value).expanduser().resolve(strict=True)
        except OSError:
            continue
        if not path.is_dir():
            path = path.parent
        created_at = directory_created_at(path)
        if created_at is not None and now - created_at < RECENT_DIRECTORY_MAX_AGE:
            directories.add(str(path))
    return sorted(directories)


def normalize_recent_skill_hold(value) -> dict | None:
    if isinstance(value, str) and parse_audit_timestamp(value) is not None:
        return {"first_seen": value}
    if not isinstance(value, dict):
        return None
    first_seen = value.get("first_seen")
    if parse_audit_timestamp(first_seen) is None:
        return None
    hold = {"first_seen": first_seen}
    for key in ("directory", "skill"):
        if isinstance(value.get(key), str) and value[key].strip():
            hold[key] = audit_text(value[key], 500)
    return hold


def read_recent_skill_holds(path: Path = RECENT_SKILL_HOLD_PATH) -> dict[str, dict]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    holds = value.get("holds", {}) if isinstance(value, dict) else {}
    if not isinstance(holds, dict):
        return {}
    return {
        key: hold
        for key, value in holds.items()
        if isinstance(key, str)
        if (hold := normalize_recent_skill_hold(value)) is not None
    }


def write_recent_skill_holds(
    holds: dict[str, dict], path: Path = RECENT_SKILL_HOLD_PATH
) -> None:
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(
            json.dumps({"version": 2, "holds": holds}, ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf-8",
        )
        if os.name != "nt":
            os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        if temporary:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def recent_skill_hold_key(directory: str, skill: str) -> str:
    return hashlib.sha256(f"{directory}\0{skill}".encode("utf-8")).hexdigest()


def recent_directory_skill_guard(
    payload,
    skill_policy: dict,
    *,
    now: datetime | None = None,
    state_path: Path = RECENT_SKILL_HOLD_PATH,
) -> str | None:
    if not skill_policy.get("installed", True) or not skill_policy.get("enabled", True):
        return None
    guard = skill_policy.get("recent_directory_guard", {})
    if not isinstance(guard, dict):
        return None
    skills = skill_names(payload) or ["[unknown]"]
    blocklist = compile_skill_patterns(guard.get("blocklist_patterns", []))
    if any(pattern.search(skill) for skill in skills for pattern in blocklist):
        return "recent_directory_skill_blocklist"
    if not guard.get("enabled", True):
        return None
    allowlist = compile_skill_patterns(guard.get("allowlist_patterns", []))
    if skills and all(any(pattern.search(skill) for pattern in allowlist) for skill in skills):
        return None

    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now = now.astimezone(timezone.utc)
    directories = recent_payload_directories(payload, now)
    if not directories:
        return None

    with RECENT_SKILL_HOLD_LOCK:
        holds = read_recent_skill_holds(state_path)
        holds = {
            key: hold
            for key, hold in holds.items()
            if now - parse_audit_timestamp(hold["first_seen"])
            < RECENT_SKILL_HOLD_RETENTION
        }
        should_hold = False
        for directory in directories:
            for skill in skills:
                key = recent_skill_hold_key(directory, skill)
                hold = holds.get(key, {})
                first_seen = parse_audit_timestamp(hold.get("first_seen"))
                if first_seen is None:
                    first_seen = now
                    hold = {"first_seen": audit_timestamp_from(now)}
                hold.update({"directory": directory, "skill": skill})
                holds[key] = hold
                if now - first_seen < RECENT_SKILL_HOLD_DURATION:
                    should_hold = True
        write_recent_skill_holds(holds, state_path)
    return "recent_directory_skill_hold" if should_hold else None


def audit_timestamp_from(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def governance_findings(payload, policy: dict) -> list[str]:
    if not policy.get("installed", False) or not policy.get("enabled", False):
        return []
    agents = sorted(set(iter_named_text(payload, AGENT_KEYS)))
    models = sorted(set(iter_named_text(payload, MODEL_KEYS)))
    compiled_patterns = []
    for source in policy.get("blocked_patterns", []):
        try:
            compiled_patterns.append(re.compile(str(source), re.IGNORECASE))
        except re.error:
            continue
    findings = []
    for label, values, allowlist in (
        ("agent", agents, policy.get("allowed_agents", [])),
        ("model", models, policy.get("allowed_models", [])),
    ):
        for value in values:
            if any(pattern.search(value) for pattern in compiled_patterns):
                findings.append(f"blocked_{label}")
            elif allowlist and not matches_allowlist(value, allowlist):
                findings.append(f"unapproved_{label}")
    return sorted(set(findings))


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
    if not config.get("git_ai_enabled", True):
        return {
            "blocked": True,
            "reason": "git_ai_paused",
            "payload": payload,
            "plugin": None,
            "config_error": config_error,
        }
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
    if event_type == "skill" and (
        reason := recent_directory_skill_guard(payload, skill_policy)
    ):
        return {
            "blocked": True,
            "reason": reason,
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

    sensitive_findings: list[str] = []
    sensitive_policy = config.get("sensitive_data_policy", {})
    if sensitive_policy_matches(sensitive_policy, event_type):
        transformed, sensitive_findings = redact_sensitive_content(
            transformed, sensitive_policy
        )
        if sensitive_findings and sensitive_policy.get("action") == "block":
            return {
                "blocked": True,
                "reason": "sensitive_content",
                "payload": payload,
                "plugin": plugin_id,
                "config_error": config_error,
                "findings": sensitive_findings,
            }

    governance_findings_list = governance_findings(
        transformed, config.get("agent_model_policy", {})
    )
    agent_model_policy = config.get("agent_model_policy", {})
    if governance_findings_list and agent_model_policy.get("mode") == "block":
        return {
            "blocked": True,
            "reason": "agent_model_policy",
            "payload": payload,
            "plugin": plugin_id,
            "config_error": config_error,
            "findings": governance_findings_list,
        }

    return {
        "blocked": False,
        "reason": "",
        "payload": transformed,
        "plugin": plugin_id,
        "config_error": config_error,
        "findings": {
            "sensitive": sensitive_findings,
            "agent_model": governance_findings_list,
        },
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
                    "gitAiEnabled": config.get("git_ai_enabled", True),
                    "gitAiStatus": "enabled"
                    if config.get("git_ai_enabled", True)
                    else "paused",
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
        if endpoint_path not in EVENT_TYPES:
            self.send_json(404, {"code": -1, "data": None, "message": "unknown endpoint"})
            return

        length = int(self.headers.get("Content-Length") or "0")
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.send_filtered(endpoint_path, "invalid_json", payload={})
            return

        decision = evaluate_request(endpoint_path, payload, body)
        if decision["blocked"]:
            self.send_filtered(
                endpoint_path,
                decision["reason"],
                decision.get("plugin"),
                payload,
            )
            return

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

    def send_filtered(
        self,
        endpoint_path: str,
        reason: str,
        plugin: str | None = None,
        payload=None,
    ):
        record_filter_event(endpoint_path, payload or {}, reason, plugin)
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
