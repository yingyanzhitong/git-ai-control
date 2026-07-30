# Git AI Control Panel

公司统一安装了 Git AI，但不想让私人 GitHub 项目的仓库名、路径、分支或 Skill 使用情况被上报？可以试试 Git AI Control Panel。

它是一个仅运行在 macOS 本机的 Git AI 配置与上传策略管理页面：不用手改 JSON，也不用为每条隐私规则编写脚本，就能按仓库主机控制允许上传的数据类型和字段。前端使用 React、Vite 与 shadcn/ui，Web 服务只监听 `127.0.0.1:38742`，不会向局域网或公网开放。

> [!IMPORTANT]
> 项目可以识别 `custom_metrics` 定制版和官方 [`git-ai-project/git-ai`](https://github.com/git-ai-project/git-ai)，但两者支持层级不同。仓库级事件开关、字段脱敏和 Skill 过滤目前需要 `custom_metrics` 扩展点；官方版只能管理 Git AI 已公开的原生配置。安装前请阅读[兼容性说明](COMPATIBILITY.md)。

## 功能

- 可视化管理 Git AI 自动更新、版本检查、仓库排除和提示词排除；
- 通过“匹配仓库主机”统一处理 GitHub、GitLab、Gitee 或其他 Git 服务；
- 分别控制 Token、Skills、Commit、Checkpoint、Agent、提示耗时和提示报告；
- 可删除仓库信息、项目路径和分支名称等敏感字段；
- 可将允许上传的 Skill 项目目录替换为固定目录；
- 可按关键词或正则拦截指定 Skill；
- 仓库插件与 Skill 过滤插件使用各自独立的配置表单；
- 支持配置验证、运行状态检查和本机过滤服务重启。

## 界面截图

### Git AI 原生设置

![Git AI 原生设置页面](docs/images/git-ai-settings.jpg)

### 插件管理

![仓库插件与 Skill 过滤插件管理页面](docs/images/plugin-management.jpg)

仓库插件可以同时配置匹配主机、允许上传的数据类型和允许保留的字段；Skill 过滤插件使用独立表单管理名称规则。每种插件类型只能配置一次，新增其他类型的插件会增加新的配置模块，不会替换已有模块。

## 快速开始

### 1. 一条命令启动

目前支持 macOS，并要求 Git AI 已安装在：

```text
~/.git-ai/bin/git-ai
```

确认文件存在后运行：

```bash
npx git-ai-control start
```

该命令会自动下载最新版本、安装或更新本机服务，并打开 Git AI 配置中心。安装过程会：

1. 识别当前 Git AI 是否支持 `custom_metrics` 扩展；
2. 将原始上报端点备份到仅当前用户可读的本机配置；
3. 安装控制页面和上传过滤运行时；
4. 保留已有的 `config.json` 与 `filter_plugins.json`；
5. 创建并启动两个 macOS LaunchAgent；
6. 等待控制页面和过滤服务通过健康检查。

如果浏览器没有自动打开，可以手动访问：

```text
http://127.0.0.1:38742
```

页面顶部会显示当前 Git AI 发行版、过滤接管状态和服务状态。

### 2. 配置仓库插件

以“GitHub 私人仓库只允许上传 Token”为例：

1. 在“仓库插件”中添加或打开现有仓库插件；
2. 在“匹配仓库主机”中填写 `github.com`；
3. 只打开 `Token`，关闭 `Skills`、`Commit`、`Checkpoint`、`Agent`、提示耗时和提示报告；
4. 关闭“仓库信息”“项目路径”和“分支名称”；
5. 保存配置。

同一个仓库插件也可以填写多个主机，每行一个。GitLab、Gitee 和自建 Git 服务不需要单独开发插件。

### 3. 配置 Skill 过滤插件

需要按名称拦截 Skill 时：

1. 添加“Skill 过滤插件”；
2. 打开插件；
3. 每行填写一个关键词或正则；
4. 保存配置。

Skill 过滤插件只负责名称规则。仓库匹配、上传类型和目录替换仍由仓库插件负责。

### 4. 验证配置

点击页面中的“验证配置”。结果会通过右上角 Toast 显示，不会占用配置表单空间。

也可以在终端检查两个本机服务：

```bash
curl -fsS http://127.0.0.1:38742/api/status
curl -fsS http://127.0.0.1:38741/health
```

## 工作方式

本项目不会修改 `~/.git-ai/bin/git-ai` 二进制。检测到 `custom_metrics` 扩展点后，安装脚本会将 Git AI 的自定义上报端点指向本机过滤服务：

```text
Git AI
  -> ~/.git-ai/custom_metrics.json
  -> http://127.0.0.1:38741
  -> 读取 ~/.git-ai/filter_plugins.json
  -> 读取 ~/.git-ai/upstream_metrics.json
  -> 拦截，或脱敏后转发至原上报服务
```

控制页面保存时只更新：

- `~/.git-ai/config.json`：Git AI 原生设置；
- `~/.git-ai/filter_plugins.json`：仓库插件和 Skill 过滤插件策略。

过滤逻辑来自仓库中的 `plugins/upload-filter/plugin_filter_runtime.py`。控制页面不会动态生成或改写 Python 脚本，`~/.git-ai` 只保存安装副本和用户配置。

## 文件位置

| 内容 | 位置 |
| --- | --- |
| 过滤运行时源码 | `plugins/upload-filter/plugin_filter_runtime.py` |
| LaunchAgent 模板 | `launchagents/*.plist.in` |
| 安装与卸载脚本 | `scripts/install.sh`、`scripts/uninstall.sh` |
| Git AI 原生配置 | `~/.git-ai/config.json` |
| 插件策略 | `~/.git-ai/filter_plugins.json` |
| 原上报端点本机备份 | `~/.git-ai/upstream_metrics.json` |
| 过滤运行时安装副本 | `~/.git-ai/filters/plugin_filter_runtime.py` |
| Web 服务安装副本 | `~/.git-ai/control-panel` |
| Web 服务 LaunchAgent | `~/Library/LaunchAgents/com.git-ai.control-panel.plist` |
| 过滤服务 LaunchAgent | `~/Library/LaunchAgents/com.git-ai.skill-usage-filter.plist` |

## 卸载

```bash
./scripts/uninstall.sh
```

卸载脚本会停止两个服务、删除本项目安装的程序副本，并将上报端点恢复为 Git AI 原地址。`config.json`、`filter_plugins.json` 和日志会保留。

## 参与贡献

欢迎提交 Issue 和 Pull Request，尤其欢迎：

- 补充不同 Git AI 版本的兼容性验证；
- 新增与仓库过滤不同类型的独立插件；
- 改进过滤规则的测试覆盖；
- 修正文档、交互和无障碍问题。

开发前请先 Fork 仓库并创建主题分支。前端源码位于 `frontend/git-ai-control-panel`，shadcn/ui 组件位于 `src/components/ui`。

```bash
cd frontend/git-ai-control-panel
npm ci
npm run lint
npm run build
cd ../..
/usr/bin/python3 -m py_compile server.py plugins/upload-filter/plugin_filter_runtime.py
```

提交 Pull Request 时请说明：

1. 解决的问题和使用场景；
2. 对配置结构或过滤行为的影响；
3. 已执行的验证命令；
4. 涉及界面变化时附上前后截图。

新增插件类型时，请为它设计独立的数据结构和配置表单；不要复用仓库插件表单来表达无关能力。涉及上报兼容性时，应基于实际 Git AI 版本和请求路径验证，避免把“页面可配置”误写成“运行时已接管”。

## 安全边界

- Web 服务只绑定本机回环地址；
- 不读取或展示 Git AI API key 等敏感字段；
- 原始上报端点不会写入项目源码，只保存在权限为 `0600` 的本机配置中；
- 配置保存采用临时文件替换，避免写入中断产生不完整文件；
- 页面没有跨域权限，拒绝非本页面来源的修改请求；
- 插件配置缺失或损坏时，GitHub 默认策略保持全部阻断；
- 官方版缺少细粒度过滤扩展点时，页面会显示“仅原生配置兼容”，不会把空闲代理误报为已接管。
