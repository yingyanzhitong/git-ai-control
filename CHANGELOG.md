# 更新日志

本项目的所有重要变更都会记录在此文件中。

## [0.4.1] - 2026-07-30

### 新增

- 新增敏感内容脱敏和 Agent / 模型治理独立插件；
- 仓库插件支持多个规则、全局兜底、仓库/目录/分支匹配和优先级；
- Git AI 设置与插件管理均可查看已写入磁盘的 JSON 配置；
- 插件管理使用统一添加顺序，新插件始终追加到列表最后；
- 新增 Git AI 启用与暂停状态展示及本机服务复用检测。

### 变更

- `npx git-ai-control` 改为唯一启动命令；已运行时复用现有本机服务，移除 `start` 子命令；
- 移除本地用量与成本看板、聚合数据文件和相关接口；
- 配置查看弹窗改为默认全展开的 JSON 树，并加宽显示区域。

## [0.4.0] - 2026-07-30

### 新增

- 新增 Git 标签触发的 npm Trusted Publishing 工作流；
- 发布前在 macOS、Linux 和 Windows 上验证同一份源码，并校验标签与 `package.json` 版本一致；
- npm 发布使用 GitHub Actions OIDC 短期凭据，不再需要长期 npm Access Token。

### 变更

- 前端静态资源在每个工作流中只构建一次，三平台矩阵只验证平台相关运行时；
- GitHub Actions 升级到 Node.js 24 运行时版本。

## [0.3.1] - 2026-07-30

### 修复

- 重新生成前端依赖锁文件，修复 macOS、Linux 和 Windows CI 中 `npm ci` 无法复现安装的问题。
- CI 仅在分支推送和 Pull Request 时运行，避免版本标签重复触发同一检查。

## [0.3.0] - 2026-07-30

### 新增

- 支持通过同一条 `npx git-ai-control start` 命令安装到 macOS、Linux 和 Windows；
- 新增 macOS LaunchAgent、Linux systemd user 和 Windows 任务计划程序适配；
- 新增跨平台 Python、Git AI 二进制和 Git 可执行文件检测；
- 新增 `npx git-ai-control uninstall` 跨平台卸载命令；
- 新增 macOS、Ubuntu、Windows 的 GitHub Actions 检查矩阵和服务定义测试。

### 变更

- 控制页面的服务状态与重启接口改为按当前操作系统执行；
- 安装、端点备份、运行时复制和健康检查统一由 Node.js 安装器管理；
- 文档补充三平台安装条件、服务管理方式和文件位置。

## [0.2.0] - 2026-07-30

### 新增

- 新增 npm 命令 `npx git-ai-control start`；
- 命令会安装或更新本机服务，并自动打开配置页面；
- README 增加项目简介、真实脱敏截图、快速开始和贡献指南。

### 安全

- 移除源码中硬编码的原上报端点，改为安装时备份至权限为 `0600` 的本机配置；
- 安装升级时可从旧版运行时迁移原上报端点；
- README 截图中的仓库地址、用户目录和 Skill 规则均使用 `example` 数据；
- 清理公开源码、发布产物和 Git 元数据中的组织及私人仓库信息。

## [0.1.0] - 2026-07-30

### 新增

- 基于 React、Vite 和 shadcn/ui 的 Git AI 本地配置中心；
- 仓库插件和 Skill 过滤插件的独立配置表单；
- 可配置的数据类型开关、仓库字段脱敏、Skill 关键词过滤和仓库主机匹配；
- 配置驱动的本机上传过滤运行时；
- Web 服务与过滤服务的 LaunchAgent 模板；
- 可重复执行的安装和卸载脚本；
- 右上角配置验证 Toast；
- `custom_metrics` 定制版和官方 `git-ai-project/git-ai` 的自动识别；
- 官方版 OSS 遥测开关及真实兼容能力提示；
- 官方版与定制版的兼容性说明。

### 安全

- GitHub 新安装默认仅允许脱敏 Token，阻断 Commit、Checkpoint、Agent、提示报告、提示耗时和 Skill 上报；
- 插件配置损坏时使用默认拒绝策略；
- Web 服务仅监听本机回环地址；
- 用户配置采用原子写入，安装过程保留已有配置；
- 官方版不支持细粒度过滤时不会修改无效的 `custom_metrics.json`。
