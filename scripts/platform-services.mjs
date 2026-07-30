import path from "node:path"

export const SERVICE_DEFINITIONS = [
  {
    key: "filter",
    macLabel: "com.git-ai.skill-usage-filter",
    linuxUnit: "git-ai-filter.service",
    windowsTask: "GitAIFilter",
    script: ["filters", "plugin_filter_runtime.py"],
    stdout: ["filters", "skill_usage_filter.out.log"],
    stderr: ["filters", "skill_usage_filter.err.log"],
  },
  {
    key: "control",
    macLabel: "com.git-ai.control-panel",
    linuxUnit: "git-ai-control-panel.service",
    windowsTask: "GitAIControlPanel",
    script: ["control-panel", "server.py"],
    stdout: ["control-panel.out.log"],
    stderr: ["control-panel.err.log"],
  },
]

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function commandArguments(service, gitAiRoot, pythonCommand, pathApi = path) {
  return [
    ...pythonCommand,
    pathApi.join(gitAiRoot, ...service.script),
  ]
}

export function renderLaunchAgent(service, gitAiRoot, pythonCommand) {
  const argumentsXml = commandArguments(service, gitAiRoot, pythonCommand, path.posix)
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(service.macLabel)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GIT_AI_ROOT</key>
    <string>${xmlEscape(gitAiRoot)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.posix.join(gitAiRoot, ...service.stdout))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.posix.join(gitAiRoot, ...service.stderr))}</string>
</dict>
</plist>
`
}

export function renderSystemdUnit(service, gitAiRoot, pythonCommand) {
  const command = commandArguments(service, gitAiRoot, pythonCommand, path.posix)
    .map(systemdQuote)
    .join(" ")
  return `[Unit]
Description=Git AI ${service.key === "filter" ? "upload filter" : "control panel"}

[Service]
Type=simple
Environment=${systemdQuote(`GIT_AI_ROOT=${gitAiRoot}`)}
ExecStart=${command}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
}

export function renderWindowsWrapper(service, gitAiRoot, pythonCommand) {
  const [executable, ...argumentsList] = commandArguments(
    service,
    gitAiRoot,
    pythonCommand,
    path.win32,
  )
  const argumentsExpression = argumentsList.map(powershellQuote).join(" ")
  const stdoutPath = path.win32.join(gitAiRoot, ...service.stdout)
  const stderrPath = path.win32.join(gitAiRoot, ...service.stderr)
  return `$env:GIT_AI_ROOT = ${powershellQuote(gitAiRoot)}
& ${powershellQuote(executable)} ${argumentsExpression} 1>> ${powershellQuote(stdoutPath)} 2>> ${powershellQuote(stderrPath)}
exit $LASTEXITCODE
`
}

export function browserCommand(platform, url) {
  if (platform === "darwin") {
    return {command: "/usr/bin/open", args: [url]}
  }
  if (platform === "linux") {
    return {command: "xdg-open", args: [url]}
  }
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", '""', url],
    }
  }
  return null
}

export function gitAiBinaryCandidates(gitAiRoot, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const candidates = [pathApi.join(gitAiRoot, "bin", "git-ai")]
  if (platform === "win32") {
    candidates.unshift(pathApi.join(gitAiRoot, "bin", "git-ai.exe"))
  }
  return candidates
}

export function windowsTaskCommand(wrapperPath) {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${wrapperPath.replaceAll('"', '""')}"`
}
