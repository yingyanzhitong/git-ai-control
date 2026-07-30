#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GIT_AI_ROOT=${GIT_AI_ROOT:-"${HOME}/.git-ai"}
LAUNCH_AGENTS_ROOT="${HOME}/Library/LaunchAgents"
CONTROL_PANEL_DIR="${GIT_AI_ROOT}/control-panel"
FILTER_DIR="${GIT_AI_ROOT}/filters"
GIT_AI_BINARY="${GIT_AI_ROOT}/bin/git-ai"
POLICY_PATH="${GIT_AI_ROOT}/filter_plugins.json"
METRICS_PATH="${GIT_AI_ROOT}/custom_metrics.json"
UPSTREAMS_PATH="${GIT_AI_ROOT}/upstream_metrics.json"
CUSTOM_METRICS_MARKER="${CONTROL_PANEL_DIR}/.custom-metrics-managed"
CONTROL_PANEL_PLIST="${LAUNCH_AGENTS_ROOT}/com.git-ai.control-panel.plist"
FILTER_PLIST="${LAUNCH_AGENTS_ROOT}/com.git-ai.skill-usage-filter.plist"
CONTROL_PANEL_LABEL="gui/$(id -u)/com.git-ai.control-panel"
FILTER_LABEL="gui/$(id -u)/com.git-ai.skill-usage-filter"

require_file() {
  if [ ! -f "$1" ]; then
    echo "缺少安装文件：$1" >&2
    exit 1
  fi
}

wait_for_port_release() {
  port=$1
  attempt=0
  while [ "${attempt}" -lt 20 ]; do
    if ! /usr/sbin/lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  echo "端口 ${port} 仍被占用，停止安装" >&2
  exit 1
}

wait_for_http() {
  url=$1
  label=$2
  attempt=0
  while [ "${attempt}" -lt 20 ]; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  echo "${label} 启动失败：${url}" >&2
  exit 1
}

require_file "${PROJECT_ROOT}/server.py"
require_file "${PROJECT_ROOT}/static/index.html"
require_file "${PROJECT_ROOT}/plugins/upload-filter/plugin_filter_runtime.py"
require_file "${PROJECT_ROOT}/policy.example.json"
require_file "${PROJECT_ROOT}/launchagents/com.git-ai.control-panel.plist.in"
require_file "${PROJECT_ROOT}/launchagents/com.git-ai.skill-usage-filter.plist.in"
require_file "${GIT_AI_BINARY}"

mkdir -p "${CONTROL_PANEL_DIR}" "${FILTER_DIR}" "${LAUNCH_AGENTS_ROOT}"

if [ ! -f "${POLICY_PATH}" ]; then
  install -m 600 "${PROJECT_ROOT}/policy.example.json" "${POLICY_PATH}"
fi

if /usr/bin/strings "${GIT_AI_BINARY}" | grep -Fq "custom_metrics.json"; then
  /usr/bin/python3 - \
    "${METRICS_PATH}" \
    "${UPSTREAMS_PATH}" \
    "${FILTER_DIR}/plugin_filter_runtime.py" <<'PY'
import ast
import json
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

path = Path(sys.argv[1])
upstreams_path = Path(sys.argv[2])
installed_filter_path = Path(sys.argv[3])


def is_external_http_url(value):
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.netloc)
        and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
    )


def write_json(destination, payload):
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, destination)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


try:
    config = json.loads(path.read_text(encoding="utf-8"))
except FileNotFoundError:
    config = {}

if upstreams_path.exists():
    saved_upstreams = json.loads(upstreams_path.read_text(encoding="utf-8"))
    saved_routes = saved_upstreams.get("routes", saved_upstreams)
    if not isinstance(saved_routes, dict) or not any(
        is_external_http_url(url) for url in saved_routes.values()
    ):
        raise SystemExit("原上报端点备份无效，已停止安装")
    os.chmod(upstreams_path, 0o600)
else:
    route_keys = {
        "/legacy/commit": "commit_endpoint",
        "/legacy/checkpoint": "checkpoint_endpoint",
        "/legacy/token-usage": "token_usage_endpoint",
        "/prompt-duration": "prompt_duration_endpoint",
        "/commit": "commit_endpoint_v2",
        "/checkpoint": "checkpoint_endpoint_v2",
        "/token-usage": "token_usage_endpoint_v2",
        "/skill-usage": "skill_usage_endpoint_v2",
        "/agent-usage": "agent_usage_endpoint_v2",
        "/prompt-report": "prompt_report_endpoint_v2",
    }
    routes = {
        route: config[key]
        for route, key in route_keys.items()
        if is_external_http_url(config.get(key))
    }
    token_url = routes.get("/token-usage")
    if token_url:
        routes["/token-usage/batch"] = f"{token_url.rstrip('/')}/batch"
        routes["/token-usage/stats"] = f"{token_url.rstrip('/')}/stats"

    if not routes and installed_filter_path.exists():
        try:
            module = ast.parse(installed_filter_path.read_text(encoding="utf-8"))
            for statement in module.body:
                if not isinstance(statement, ast.Assign):
                    continue
                if not any(
                    isinstance(target, ast.Name) and target.id == "UPSTREAMS"
                    for target in statement.targets
                ):
                    continue
                legacy_routes = ast.literal_eval(statement.value)
                routes = {
                    route: url
                    for route, url in legacy_routes.items()
                    if is_external_http_url(url)
                }
                break
        except (OSError, SyntaxError, ValueError):
            routes = {}

    if not routes:
        raise SystemExit(
            "无法从 custom_metrics.json 识别原上报端点；"
            "为避免丢失或回环请求，已停止安装"
        )
    write_json(upstreams_path, {"version": 1, "routes": routes})

config.update(
    {
        "enable": True,
        "commit_endpoint": "http://127.0.0.1:38741/legacy/commit",
        "checkpoint_endpoint": "http://127.0.0.1:38741/legacy/checkpoint",
        "token_usage_endpoint": "http://127.0.0.1:38741/legacy/token-usage",
        "prompt_duration_endpoint": "http://127.0.0.1:38741/prompt-duration",
        "commit_endpoint_v2": "http://127.0.0.1:38741/commit",
        "checkpoint_endpoint_v2": "http://127.0.0.1:38741/checkpoint",
        "token_usage_endpoint_v2": "http://127.0.0.1:38741/token-usage",
        "skill_usage_endpoint_v2": "http://127.0.0.1:38741/skill-usage",
        "agent_usage_endpoint_v2": "http://127.0.0.1:38741/agent-usage",
        "prompt_report_endpoint_v2": "http://127.0.0.1:38741/prompt-report",
    }
)

write_json(path, config)
PY
  touch "${CUSTOM_METRICS_MARKER}"
  echo "检测到 custom_metrics 定制版：已启用细粒度上报过滤"
else
  rm -f "${CUSTOM_METRICS_MARKER}"
  echo "检测到官方上游版：保留原生配置管理，不修改无效的 custom_metrics.json"
fi

install -m 700 "${PROJECT_ROOT}/server.py" "${CONTROL_PANEL_DIR}/server.py"
install -m 700 \
  "${PROJECT_ROOT}/plugins/upload-filter/plugin_filter_runtime.py" \
  "${FILTER_DIR}/plugin_filter_runtime.py"
/usr/bin/rsync -a --delete "${PROJECT_ROOT}/static/" "${CONTROL_PANEL_DIR}/static/"

sed "s#__GIT_AI_ROOT__#${GIT_AI_ROOT}#g" \
  "${PROJECT_ROOT}/launchagents/com.git-ai.control-panel.plist.in" \
  > "${CONTROL_PANEL_PLIST}"
sed "s#__GIT_AI_ROOT__#${GIT_AI_ROOT}#g" \
  "${PROJECT_ROOT}/launchagents/com.git-ai.skill-usage-filter.plist.in" \
  > "${FILTER_PLIST}"
chmod 600 "${CONTROL_PANEL_PLIST}" "${FILTER_PLIST}"

plutil -lint "${CONTROL_PANEL_PLIST}" "${FILTER_PLIST}"
/usr/bin/python3 -m py_compile \
  "${CONTROL_PANEL_DIR}/server.py" \
  "${FILTER_DIR}/plugin_filter_runtime.py"

launchctl bootout "${CONTROL_PANEL_LABEL}" >/dev/null 2>&1 || true
launchctl bootout "${FILTER_LABEL}" >/dev/null 2>&1 || true
wait_for_port_release 38741
wait_for_port_release 38742
launchctl bootstrap "gui/$(id -u)" "${FILTER_PLIST}"
launchctl bootstrap "gui/$(id -u)" "${CONTROL_PANEL_PLIST}"
wait_for_http "http://127.0.0.1:38741/health" "过滤服务"
wait_for_http "http://127.0.0.1:38742/api/status" "配置页面"

echo "安装完成："
echo "  配置页面：http://127.0.0.1:38742"
echo "  过滤服务：http://127.0.0.1:38741/health"
echo "  用户配置：${GIT_AI_ROOT}"
