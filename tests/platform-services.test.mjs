import assert from "node:assert/strict"
import test from "node:test"

import {
  SERVICE_DEFINITIONS,
  browserCommand,
  gitAiBinaryCandidates,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsWrapper,
  windowsTaskCommand,
} from "../scripts/platform-services.mjs"

const filterService = SERVICE_DEFINITIONS.find((service) => service.key === "filter")

test("macOS LaunchAgent 包含 Python、根目录和过滤脚本", () => {
  const plist = renderLaunchAgent(
    filterService,
    "/Users/example/.git-ai",
    ["/opt/homebrew/bin/python3"],
  )
  assert.match(plist, /com\.git-ai\.skill-usage-filter/)
  assert.match(plist, /\/opt\/homebrew\/bin\/python3/)
  assert.match(plist, /\/Users\/example\/\.git-ai\/filters\/plugin_filter_runtime\.py/)
  assert.match(plist, /<key>GIT_AI_ROOT<\/key>/)
})

test("Linux systemd user unit 会自动重启并设置根目录", () => {
  const unit = renderSystemdUnit(
    filterService,
    "/home/example/.git-ai",
    ["/usr/bin/python3"],
  )
  assert.match(unit, /Environment="GIT_AI_ROOT=\/home\/example\/\.git-ai"/)
  assert.match(
    unit,
    /ExecStart="\/usr\/bin\/python3" "\/home\/example\/\.git-ai\/filters\/plugin_filter_runtime\.py"/,
  )
  assert.match(unit, /Restart=always/)
  assert.match(unit, /WantedBy=default\.target/)
})

test("Windows wrapper 使用 Windows 路径并设置根目录", () => {
  const wrapper = renderWindowsWrapper(
    filterService,
    String.raw`C:\Users\example\.git-ai`,
    [String.raw`C:\Python312\python.exe`],
  )
  assert.match(wrapper, /\$env:GIT_AI_ROOT = 'C:\\Users\\example\\\.git-ai'/)
  assert.match(wrapper, /C:\\Python312\\python\.exe/)
  assert.match(wrapper, /filters\\plugin_filter_runtime\.py/)
  assert.match(wrapper, /skill_usage_filter\.err\.log/)
})

test("Windows 任务命令只启动本机 PowerShell wrapper", () => {
  const command = windowsTaskCommand(
    String.raw`C:\Users\example\.git-ai\services\filter.ps1`,
  )
  assert.equal(
    command,
    String.raw`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\example\.git-ai\services\filter.ps1"`,
  )
})

test("三个系统生成各自的浏览器启动命令", () => {
  const url = "http://127.0.0.1:38742"
  assert.deepEqual(browserCommand("darwin", url), {
    command: "/usr/bin/open",
    args: [url],
  })
  assert.deepEqual(browserCommand("linux", url), {
    command: "xdg-open",
    args: [url],
  })
  assert.deepEqual(browserCommand("win32", url), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "start", '""', url],
  })
})

test("Windows 优先检测 git-ai.exe", () => {
  assert.deepEqual(
    gitAiBinaryCandidates(String.raw`C:\Users\example\.git-ai`, "win32"),
    [
      String.raw`C:\Users\example\.git-ai\bin\git-ai.exe`,
      String.raw`C:\Users\example\.git-ai\bin\git-ai`,
    ],
  )
})
