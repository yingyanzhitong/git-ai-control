# Git AI 兼容性说明

## 操作系统

`npx git-ai-control start` 支持 macOS、Linux 和 Windows，三个系统共用相同的配置格式、过滤运行时和 Web 页面，仅用户级服务管理方式不同：

- macOS：LaunchAgent；
- Linux：systemd user；
- Windows：任务计划程序。

Linux 需要可用的 systemd 用户会话。Windows 需要当前用户拥有创建登录任务的权限。安装器会从 `PATH` 自动寻找 Python 3，并按当前系统检测 `git-ai` 或 `git-ai.exe`。

## 结论

本项目同时支持两类 Git AI，但支持层级不同：

| 能力 | `custom_metrics` 定制版 | 官方 `git-ai-project/git-ai` |
| --- | --- | --- |
| 管理 `~/.git-ai/config.json` | 支持 | 支持 |
| 自动更新、版本检查、仓库排除 | 支持 | 支持 |
| OSS Sentry/PostHog 遥测开关 | 配置会保留，定制版可忽略 | 支持 |
| 仓库级数据类型开关 | 支持 | 不支持 |
| 仓库、路径、分支字段脱敏 | 支持 | 不支持 |
| Skill 名称过滤 | 支持 | 不支持 |
| GitHub 仅上传脱敏 Token | 支持 | 官方版当前无法通过外部配置实现 |

安装脚本会检查 `git-ai` 二进制是否包含 `custom_metrics.json` 扩展点：

- 检测到扩展点时，将自定义指标端点指向 `127.0.0.1:38741`，启用完整过滤；
- 未检测到扩展点时，不创建或修改无效的 `custom_metrics.json`，只启用原生配置管理；
- Web 页面会显示当前发行版和细粒度过滤是否真正接管。

## 官方版为什么不能直接使用现有过滤器

审计基线：

- 上游仓库：[`git-ai-project/git-ai`](https://github.com/git-ai-project/git-ai)
- 上游提交：[`a751efd`](https://github.com/git-ai-project/git-ai/commit/a751efd64d129272947239f819822bfee14bef97)
- 审计日期：2026-07-30

官方版与本机定制版使用不同的上传接口：

1. 本机定制版读取 `~/.git-ai/custom_metrics.json`，每种事件都有独立端点，例如 `token_usage_endpoint_v2`、`skill_usage_endpoint_v2` 和 `agent_usage_endpoint_v2`。
2. 官方版没有读取 `custom_metrics.json`，登录或配置 API key 后，将压缩后的指标批量发送到 `/worker/metrics/upload`。
3. 官方指标批次使用位置编码的事件结构，提交、Checkpoint、Agent、Session 等事件混在同一个批次中，官方配置没有提供单独的指标代理地址。

相关上游源码：

- [`src/config.rs`](https://github.com/git-ai-project/git-ai/blob/main/src/config.rs)：原生配置字段和 `~/.git-ai/config.json` 路径；
- [`src/api/metrics.rs`](https://github.com/git-ai-project/git-ai/blob/main/src/api/metrics.rs)：官方 `/worker/metrics/upload` 上传入口；
- [`src/metrics/types.rs`](https://github.com/git-ai-project/git-ai/blob/main/src/metrics/types.rs)：批量指标协议；
- [`src/metrics/attrs.rs`](https://github.com/git-ai-project/git-ai/blob/main/src/metrics/attrs.rs)：仓库与分支等位置编码字段。

因此，把官方版的 `api_base_url` 直接改到当前过滤器并不安全：它还会影响登录、升级、Notes、CAS 和其他 API，并且需要正确代理认证头和全部请求类型。本项目不会用这种方式伪装成“已兼容”。

## 官方版当前可用的隐私能力

本项目可以管理官方版已经公开支持的原生设置：

- `exclude_repositories`：匹配后整个仓库停用 Git AI；
- `exclude_prompts_in_repositories`：提示词和会话内容仅保存在本地；
- `telemetry_oss=off`：关闭官方 OSS 的 Sentry/PostHog 遥测；
- `disable_auto_updates`、`disable_version_checks`：更新行为。

注意：`telemetry_oss=off` 不等于禁用登录后的 `/worker/metrics/upload`。官方源码中该上传是否执行由登录状态或 API key 决定。

## 达到完整官方兼容需要什么

要让官方版也支持“GitHub 仅上传脱敏 Token”，优先方案是推动上游提供稳定扩展点：

1. 可配置的 metrics endpoint；
2. 上传前本地过滤回调或插件接口；
3. 可按仓库和事件类型控制的官方配置；
4. 稳定、带版本号的指标批次字段说明。

在上游提供其中一种能力前，本项目对官方版保持“原生配置兼容”，不会宣称细粒度过滤已经生效。
