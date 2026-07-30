#!/bin/sh
set -eu

GIT_AI_ROOT=${GIT_AI_ROOT:-"${HOME}/.git-ai"}
LAUNCH_AGENTS_ROOT="${HOME}/Library/LaunchAgents"
CONTROL_PANEL_DIR="${GIT_AI_ROOT}/control-panel"
FILTER_SCRIPT="${GIT_AI_ROOT}/filters/plugin_filter_runtime.py"
METRICS_PATH="${GIT_AI_ROOT}/custom_metrics.json"
UPSTREAMS_PATH="${GIT_AI_ROOT}/upstream_metrics.json"
CUSTOM_METRICS_MARKER="${CONTROL_PANEL_DIR}/.custom-metrics-managed"
CONTROL_PANEL_PLIST="${LAUNCH_AGENTS_ROOT}/com.git-ai.control-panel.plist"
FILTER_PLIST="${LAUNCH_AGENTS_ROOT}/com.git-ai.skill-usage-filter.plist"
CONTROL_PANEL_LABEL="gui/$(id -u)/com.git-ai.control-panel"
FILTER_LABEL="gui/$(id -u)/com.git-ai.skill-usage-filter"

case "${GIT_AI_ROOT}" in
  "${HOME}/.git-ai") ;;
  *)
    echo "拒绝卸载非默认目录：${GIT_AI_ROOT}" >&2
    exit 1
    ;;
esac

launchctl bootout "${CONTROL_PANEL_LABEL}" >/dev/null 2>&1 || true
launchctl bootout "${FILTER_LABEL}" >/dev/null 2>&1 || true

if [ -f "${CUSTOM_METRICS_MARKER}" ]; then
  /usr/bin/python3 - "${METRICS_PATH}" "${UPSTREAMS_PATH}" <<'PY'
import json
import os
import sys
import tempfile
from pathlib import Path

path = Path(sys.argv[1])
upstreams_path = Path(sys.argv[2])
if not path.exists():
    raise SystemExit(0)
if not upstreams_path.exists():
    raise SystemExit("缺少原上报端点备份，已停止卸载以避免留下无效配置")

config = json.loads(path.read_text(encoding="utf-8"))
upstreams = json.loads(upstreams_path.read_text(encoding="utf-8"))
routes = upstreams.get("routes", upstreams)
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
for route, key in route_keys.items():
    url = routes.get(route)
    if isinstance(url, str) and url:
        config[key] = url

descriptor, temporary_name = tempfile.mkstemp(
    prefix=f".{path.name}.",
    suffix=".tmp",
    dir=path.parent,
)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary_name, 0o600)
    os.replace(temporary_name, path)
except Exception:
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass
    raise
PY
fi

rm -f "${CONTROL_PANEL_PLIST}" "${FILTER_PLIST}" "${FILTER_SCRIPT}"
rm -rf "${CONTROL_PANEL_DIR}"

echo "卸载完成。保留了以下用户数据："
echo "  ${GIT_AI_ROOT}/config.json"
echo "  ${GIT_AI_ROOT}/filter_plugins.json"
echo "  ${GIT_AI_ROOT}/upstream_metrics.json"
echo "  ${GIT_AI_ROOT}/filters/*.log"
