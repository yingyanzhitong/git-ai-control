import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  CircleCheck,
  FlaskConical,
  FolderGit2,
  GitBranch,
  ListFilter,
  LoaderCircle,
  Plus,
  Puzzle,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Toaster } from "@/components/ui/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const EVENT_LABELS = {
  token: "Token",
  skill: "Skills",
  commit: "Commit",
  checkpoint: "Checkpoint",
  agent: "Agent",
  prompt_duration: "提示耗时",
  prompt_report: "提示报告",
} as const

const FIELD_LABELS = {
  repository: "仓库信息",
  path: "项目路径",
  branch: "分支名称",
} as const

type EventKey = keyof typeof EVENT_LABELS
type FieldKey = keyof typeof FIELD_LABELS

type GitAiConfig = {
  git_path: string
  exclude_repositories: string[]
  exclude_prompts_in_repositories: string[]
  disable_auto_updates: boolean
  disable_version_checks: boolean
  telemetry_oss: "on" | "off"
}

type RepositoryPlugin = {
  id: string
  name: string
  enabled: boolean
  match: { hosts: string[] }
  fixed_project_directory: string
  allow: Record<EventKey, boolean>
  fields: Record<FieldKey, boolean>
}

type PolicyConfig = {
  version: 1
  default_allow_unmatched: boolean
  skill_policy: {
    installed: boolean
    enabled: boolean
    blocked_patterns: string[]
  }
  plugins: RepositoryPlugin[]
}

type RuntimeStatus = {
  ok: boolean
  gitAiVersion?: string
  distribution?: "custom-metrics" | "upstream-oss"
  granularFilterActive?: boolean
  capabilities?: {
    nativeConfig: boolean
    granularUploadFilter: boolean
  }
}

type ConfigResponse = {
  gitAi: Partial<GitAiConfig>
  policy: PolicyConfig
  runtime?: RuntimeStatus
}

const EMPTY_GIT_AI: GitAiConfig = {
  git_path: "/usr/bin/git",
  exclude_repositories: [],
  exclude_prompts_in_repositories: [],
  disable_auto_updates: false,
  disable_version_checks: false,
  telemetry_oss: "on",
}

function toLines(value: string[] | undefined) {
  return Array.isArray(value) ? value.join("\n") : ""
}

function fromLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizePolicy(value: PolicyConfig): PolicyConfig {
  const legacySkillPolicy = value.skill_policy as PolicyConfig["skill_policy"] & {
    fixed_project_directory?: string
  }
  return {
    ...value,
    skill_policy: {
      installed: value.skill_policy.installed ?? true,
      enabled: value.skill_policy.enabled,
      blocked_patterns: value.skill_policy.blocked_patterns,
    },
    plugins: value.plugins.map((plugin) => ({
      ...plugin,
      fixed_project_directory:
        plugin.fixed_project_directory ??
        (plugin.id === "github"
          ? legacySkillPolicy.fixed_project_directory ?? ""
          : ""),
    })),
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    ok?: boolean
    message?: string
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `请求失败：${response.status}`)
  }
  return payload
}

function SettingSwitch({
  id,
  title,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  title: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-lg border p-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{title}</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function PermissionSwitch({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function LoadingPage() {
  return (
    <div className="mx-auto flex min-h-svh max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  )
}

export function App() {
  const [gitAi, setGitAi] = useState<GitAiConfig | null>(null)
  const [policy, setPolicy] = useState<PolicyConfig | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus>({ ok: false })
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [addPluginOpen, setAddPluginOpen] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/config", { cache: "no-store" })
      const payload = await readResponse<ConfigResponse>(response)
      setGitAi({ ...EMPTY_GIT_AI, ...payload.gitAi })
      setPolicy(normalizePolicy(payload.policy))
      setRuntime(payload.runtime ?? { ok: false })
      setDirty(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取配置失败")
    }
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadConfig())
    return () => window.cancelAnimationFrame(frame)
  }, [loadConfig])

  const enabledPlugins = useMemo(
    () => policy?.plugins.filter((plugin) => plugin.enabled) ?? [],
    [policy],
  )
  const allowedChannels = useMemo(
    () =>
      enabledPlugins.reduce(
        (total, plugin) =>
          total + Object.values(plugin.allow).filter(Boolean).length,
        0,
      ),
    [enabledPlugins],
  )
  const installedModuleCount =
    (policy?.plugins.length ? 1 : 0) +
    (policy?.skill_policy.installed ? 1 : 0)
  const enabledModuleCount =
    (policy?.plugins.some((plugin) => plugin.enabled) ? 1 : 0) +
    (policy?.skill_policy.installed && policy.skill_policy.enabled ? 1 : 0)
  const availablePluginTypes = useMemo(() => {
    const available: Array<"repository" | "skill_filter"> = []
    if (!policy?.plugins.length) available.push("repository")
    if (!policy?.skill_policy.installed) available.push("skill_filter")
    return available
  }, [policy])
  const markGitAi = (next: GitAiConfig) => {
    setGitAi(next)
    setDirty(true)
  }

  const markPolicy = (next: PolicyConfig) => {
    setPolicy(next)
    setDirty(true)
  }

  const updatePlugin = (
    pluginId: string,
    updater: (plugin: RepositoryPlugin) => RepositoryPlugin,
  ) => {
    if (!policy) return
    markPolicy({
      ...policy,
      plugins: policy.plugins.map((plugin) =>
        plugin.id === pluginId ? updater(plugin) : plugin,
      ),
    })
  }

  const addPlugin = (type: "repository" | "skill_filter") => {
    if (!policy) return
    if (type === "repository") {
      if (policy.plugins.length) return
      markPolicy({
        ...policy,
        plugins: [
          {
            id: "repository",
            name: "仓库插件",
            enabled: true,
            match: { hosts: ["example.com"] },
            fixed_project_directory: "",
            allow: Object.fromEntries(
              Object.keys(EVENT_LABELS).map((key) => [key, false]),
            ) as Record<EventKey, boolean>,
            fields: Object.fromEntries(
              Object.keys(FIELD_LABELS).map((key) => [key, false]),
            ) as Record<FieldKey, boolean>,
          },
        ],
      })
    } else {
      markPolicy({
        ...policy,
        skill_policy: {
          ...policy.skill_policy,
          installed: true,
          enabled: true,
        },
      })
    }
    setAddPluginOpen(false)
  }

  const deletePlugin = (pluginId: string) => {
    if (!policy) return
    markPolicy({
      ...policy,
      plugins: policy.plugins.filter((plugin) => plugin.id !== pluginId),
    })
  }

  const deleteSkillPlugin = () => {
    if (!policy) return
    markPolicy({
      ...policy,
      skill_policy: {
        ...policy.skill_policy,
        installed: false,
        enabled: false,
      },
    })
  }

  const saveConfig = async () => {
    if (!gitAi || !policy) return
    setBusy(true)
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gitAi, policy }),
      })
      const payload = await readResponse<ConfigResponse>(response)
      setGitAi({ ...EMPTY_GIT_AI, ...payload.gitAi })
      setPolicy(normalizePolicy(payload.policy))
      if (payload.runtime) {
        setRuntime(payload.runtime)
      }
      setDirty(false)
      toast.success("配置已保存，下一次上报立即使用新策略")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    setBusy(true)
    const toastId = toast.loading("正在验证配置", {
      description: "检查插件策略、过滤脚本和本地服务连接…",
    })
    try {
      const response = await fetch("/api/test", { method: "POST" })
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string
        checks: Array<{ name: string; ok: boolean; message?: string }>
      }
      if (!response.ok || !Array.isArray(payload.checks)) {
        throw new Error(payload.message || `请求失败：${response.status}`)
      }
      const failed = payload.checks.filter((check) => !check.ok)
      if (failed.length) {
        toast.error("配置验证失败", {
          id: toastId,
          description: failed
            .map((item) =>
              item.message ? `${item.name}：${item.message}` : item.name,
            )
            .join("；"),
        })
      } else {
        toast.success("配置验证通过", {
          id: toastId,
          description: payload.checks.map((item) => item.name).join("、"),
        })
      }
    } catch (error) {
      toast.error("配置验证失败", {
        id: toastId,
        description: error instanceof Error ? error.message : "验证请求失败",
      })
    } finally {
      setBusy(false)
    }
  }

  const restartFilter = async () => {
    setBusy(true)
    try {
      const response = await fetch("/api/restart-filter", { method: "POST" })
      const payload = await readResponse<{ message?: string }>(response)
      toast.success(payload.message || "过滤服务已重启")
      window.setTimeout(() => void loadConfig(), 900)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重启失败")
    } finally {
      setBusy(false)
    }
  }

  if (!gitAi || !policy) {
    return (
      <>
        <LoadingPage />
        <Toaster position="top-right" richColors closeButton duration={5000} />
      </>
    )
  }

  return (
    <TooltipProvider>
      <div className="min-h-svh bg-muted/30 pb-24">
        <header className="border-b bg-background">
          <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <ShieldCheck className="size-5" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">Git AI 配置中心</h1>
                <p className="text-sm text-muted-foreground">
                  本机插件策略与上传权限
                </p>
              </div>
            </div>
            <Badge
              variant={
                runtime.distribution === "upstream-oss"
                  ? "outline"
                  : runtime.ok
                    ? "secondary"
                    : "destructive"
              }
            >
              <Activity className="size-3.5" />
              {runtime.distribution === "upstream-oss"
                ? "上游 OSS · 原生配置"
                : runtime.ok
                  ? "定制版 · 过滤在线"
                  : "定制版 · 过滤异常"}
              {runtime.gitAiVersion ? ` · ${runtime.gitAiVersion}` : ""}
            </Badge>
          </div>
        </header>

        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card size="sm">
              <CardHeader>
                <CardDescription>已安装插件</CardDescription>
                <CardTitle className="flex items-baseline gap-2 text-2xl">
                  {installedModuleCount}
                  <span className="text-xs font-normal text-muted-foreground">
                    {enabledModuleCount} 个启用
                  </span>
                </CardTitle>
              </CardHeader>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>允许的数据通道</CardDescription>
                <CardTitle className="text-2xl">{allowedChannels}</CardTitle>
              </CardHeader>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>配置状态</CardDescription>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CircleCheck
                    className={`size-4 ${dirty ? "text-amber-600" : "text-emerald-600"}`}
                  />
                  {dirty ? "有未保存更改" : "已同步"}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Tabs defaultValue="system">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="system">
                <Settings2 />
                Git AI 设置
              </TabsTrigger>
              <TabsTrigger value="plugins">
                <Puzzle />
                插件管理
              </TabsTrigger>
            </TabsList>

            <TabsContent value="system" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Git AI 原生设置</CardTitle>
                  <CardDescription>
                    写入 ~/.git-ai/config.json，未知字段会原样保留。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    <SettingSwitch
                      id="auto-updates"
                      title="自动更新"
                      description="检测到稳定版本后自动安装"
                      checked={!gitAi.disable_auto_updates}
                      onCheckedChange={(checked) =>
                        markGitAi({
                          ...gitAi,
                          disable_auto_updates: !checked,
                        })
                      }
                    />
                    <SettingSwitch
                      id="version-checks"
                      title="版本检查"
                      description="在 fetch、pull、push 时检查版本"
                      checked={!gitAi.disable_version_checks}
                      onCheckedChange={(checked) =>
                        markGitAi({
                          ...gitAi,
                          disable_version_checks: !checked,
                        })
                      }
                    />
                    <SettingSwitch
                      id="oss-telemetry"
                      title="上游 OSS 遥测"
                      description="控制官方版的 Sentry/PostHog 遥测，不等同于细粒度事件过滤"
                      checked={gitAi.telemetry_oss !== "off"}
                      onCheckedChange={(checked) =>
                        markGitAi({
                          ...gitAi,
                          telemetry_oss: checked ? "on" : "off",
                        })
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="git-path">Git 可执行文件</Label>
                    <Input
                      id="git-path"
                      className="font-mono"
                      value={gitAi.git_path}
                      onChange={(event) =>
                        markGitAi({ ...gitAi, git_path: event.target.value })
                      }
                    />
                  </div>

                  <div className="grid gap-6 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="exclude-repositories">排除的仓库</Label>
                      <p className="text-sm text-muted-foreground">
                        每行一个远程地址、路径或通配符。匹配后 Git AI 整体停用。
                      </p>
                      <Textarea
                        id="exclude-repositories"
                        className="min-h-44 font-mono text-xs"
                        value={toLines(gitAi.exclude_repositories)}
                        onChange={(event) =>
                          markGitAi({
                            ...gitAi,
                            exclude_repositories: fromLines(event.target.value),
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="exclude-prompts">
                        不保存提示词的仓库
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        每行一个规则，只影响提示词与会话内容。
                      </p>
                      <Textarea
                        id="exclude-prompts"
                        className="min-h-44 font-mono text-xs"
                        value={toLines(
                          gitAi.exclude_prompts_in_repositories,
                        )}
                        onChange={(event) =>
                          markGitAi({
                            ...gitAi,
                            exclude_prompts_in_repositories: fromLines(
                              event.target.value,
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="plugins" className="mt-4 space-y-4">
              <Card size="sm">
                <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <CardTitle>Git AI 运行兼容性</CardTitle>
                    <CardDescription>
                      {runtime.distribution === "upstream-oss"
                        ? "检测到官方上游版：原生设置生效，但官方版没有 custom_metrics 扩展点，下面的仓库和 Skill 细粒度上报规则不会接管 /worker/metrics/upload。"
                        : "检测到 custom_metrics 定制版：仓库、Skill、数据类型和字段规则会在请求离开本机前执行。"}
                    </CardDescription>
                  </div>
                  <Badge
                    variant={
                      runtime.granularFilterActive ? "secondary" : "outline"
                    }
                  >
                    {runtime.granularFilterActive
                      ? "细粒度过滤已接管"
                      : "仅原生配置兼容"}
                  </Badge>
                </CardHeader>
              </Card>

              {policy.plugins.map((plugin) => (
                <Card key={plugin.id}>
                  <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <Badge variant="secondary">
                        <GitBranch />
                        仓库插件
                      </Badge>
                      <Input
                        aria-label="插件名称"
                        className="max-w-md text-base font-medium"
                        value={plugin.name}
                        onChange={(event) =>
                          updatePlugin(plugin.id, (current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                      <CardDescription className="font-mono">
                        plugin://{plugin.id}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`plugin-${plugin.id}`}>启用</Label>
                        <Switch
                          id={`plugin-${plugin.id}`}
                          checked={plugin.enabled}
                          onCheckedChange={(checked) =>
                            updatePlugin(plugin.id, (current) => ({
                              ...current,
                              enabled: checked,
                            }))
                          }
                        />
                      </div>
                      <AlertDialog>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`删除插件 ${plugin.name}`}
                              >
                                <Trash2 />
                              </Button>
                            </AlertDialogTrigger>
                          </TooltipTrigger>
                          <TooltipContent>删除当前插件</TooltipContent>
                        </Tooltip>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>删除仓库插件？</AlertDialogTitle>
                            <AlertDialogDescription>
                              将删除“{plugin.name}”的全部配置。保存更改前不会写入磁盘。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deletePlugin(plugin.id)}
                            >
                              删除
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <SettingSwitch
                      id="default-allow"
                      title="未匹配主机的仓库"
                      description="控制未命中此插件主机规则的仓库是否允许原始上报"
                      checked={policy.default_allow_unmatched}
                      onCheckedChange={(checked) =>
                        markPolicy({
                          ...policy,
                          default_allow_unmatched: checked,
                        })
                      }
                    />

                    <div className="grid gap-6 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`hosts-${plugin.id}`}>
                          匹配仓库主机
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          每行一个，例如 github.com。
                        </p>
                        <Textarea
                          id={`hosts-${plugin.id}`}
                          className="min-h-28 font-mono text-xs"
                          value={toLines(plugin.match.hosts)}
                          onChange={(event) =>
                            updatePlugin(plugin.id, (current) => ({
                              ...current,
                              match: { hosts: fromLines(event.target.value) },
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`directory-${plugin.id}`}>
                          Skill 上报目录
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          仅替换此插件允许上传的 Skill 路径。留空则保留原路径。
                        </p>
                        <Input
                          id={`directory-${plugin.id}`}
                          className="font-mono"
                          value={plugin.fixed_project_directory}
                          onChange={(event) =>
                            updatePlugin(plugin.id, (current) => ({
                              ...current,
                              fixed_project_directory: event.target.value,
                            }))
                          }
                        />
                        <div className="rounded-lg border bg-muted/50 p-3">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <FolderGit2 className="size-4" />
                            上报目录预览
                          </div>
                          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                            {plugin.fixed_project_directory || "保留原路径"}
                          </p>
                        </div>
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <div>
                        <h3 className="text-sm font-medium">允许上传的数据</h3>
                        <p className="text-sm text-muted-foreground">
                          每类事件可单独启用，关闭时请求会在本机被拦截。
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {(Object.keys(EVENT_LABELS) as EventKey[]).map((key) => (
                          <PermissionSwitch
                            key={key}
                            id={`${plugin.id}-event-${key}`}
                            label={EVENT_LABELS[key]}
                            checked={plugin.allow[key]}
                            onCheckedChange={(checked) =>
                              updatePlugin(plugin.id, (current) => ({
                                ...current,
                                allow: { ...current.allow, [key]: checked },
                              }))
                            }
                          />
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <h3 className="text-sm font-medium">允许保留的字段</h3>
                        <p className="text-sm text-muted-foreground">
                          关闭的仓库、目录和分支字段会在请求离开本机前删除。
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        {(Object.keys(FIELD_LABELS) as FieldKey[]).map((key) => (
                          <PermissionSwitch
                            key={key}
                            id={`${plugin.id}-field-${key}`}
                            label={FIELD_LABELS[key]}
                            checked={plugin.fields[key]}
                            onCheckedChange={(checked) =>
                              updatePlugin(plugin.id, (current) => ({
                                ...current,
                                fields: { ...current.fields, [key]: checked },
                              }))
                            }
                          />
                        ))}
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter className="justify-between border-t">
                    <Badge variant={plugin.enabled ? "outline" : "secondary"}>
                      {plugin.enabled
                        ? `${Object.values(plugin.allow).filter(Boolean).length}/7 数据类型 · ${Object.values(plugin.fields).filter(Boolean).length}/3 字段`
                        : "插件已停用"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      按仓库主机匹配
                    </span>
                  </CardFooter>
                </Card>
              ))}

              {policy.skill_policy.installed && (
                <Card>
                  <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-2">
                      <Badge variant="secondary">
                        <ListFilter />
                        Skill 过滤插件
                      </Badge>
                      <CardTitle>Skill 关键词过滤</CardTitle>
                      <CardDescription>
                        根据 Skill 名称拦截指定类型的调用。
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2">
                        <Label htmlFor="skill-enabled">启用</Label>
                        <Switch
                          id="skill-enabled"
                          checked={policy.skill_policy.enabled}
                          onCheckedChange={(checked) =>
                            markPolicy({
                              ...policy,
                              skill_policy: {
                                ...policy.skill_policy,
                                enabled: checked,
                              },
                            })
                          }
                        />
                      </div>
                      <AlertDialog>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="删除插件 Skill 过滤插件"
                              >
                                <Trash2 />
                              </Button>
                            </AlertDialogTrigger>
                          </TooltipTrigger>
                          <TooltipContent>删除 Skill 过滤插件</TooltipContent>
                        </Tooltip>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              删除 Skill 过滤插件？
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              删除后关键词拦截将停用，现有关键词会保留，重新添加插件时可以继续使用。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction onClick={deleteSkillPlugin}>
                              删除
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="max-w-2xl space-y-2">
                      <Label htmlFor="blocked-patterns">拦截关键词 / 正则</Label>
                      <p className="text-sm text-muted-foreground">
                        每行一个，不区分大小写。命中 skillName、skill 或 name 即拦截。
                      </p>
                      <Textarea
                        id="blocked-patterns"
                        className="min-h-72 font-mono text-xs"
                        value={toLines(policy.skill_policy.blocked_patterns)}
                        onChange={(event) =>
                          markPolicy({
                            ...policy,
                            skill_policy: {
                              ...policy.skill_policy,
                              blocked_patterns: fromLines(event.target.value),
                            },
                          })
                        }
                      />
                    </div>
                  </CardContent>
                  <CardFooter className="justify-between border-t">
                    <Badge
                      variant={
                        policy.skill_policy.enabled ? "outline" : "secondary"
                      }
                    >
                      {policy.skill_policy.enabled
                        ? `${policy.skill_policy.blocked_patterns.length} 条拦截规则`
                        : "插件已停用"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      仅处理 Skill 调用名称
                    </span>
                  </CardFooter>
                </Card>
              )}

              {!policy.plugins.length && !policy.skill_policy.installed && (
                <Card>
                  <CardContent className="flex min-h-40 flex-col items-center justify-center gap-2 text-center">
                    <Puzzle className="size-6 text-muted-foreground" />
                    <p className="font-medium">还没有安装插件</p>
                    <p className="text-sm text-muted-foreground">
                      添加插件后，这里会出现对应类型的配置模块。
                    </p>
                  </CardContent>
                </Card>
              )}

              <Dialog open={addPluginOpen} onOpenChange={setAddPluginOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={!availablePluginTypes.length}
                  >
                    <Plus />
                    {availablePluginTypes.length
                      ? "添加插件"
                      : "所有可用插件均已添加"}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>添加插件</DialogTitle>
                    <DialogDescription>
                      每种插件只能添加一次，并使用各自专属的配置表单。
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-2">
                    {availablePluginTypes.includes("repository") && (
                      <Button
                        variant="outline"
                        className="h-auto justify-start gap-3 p-4 text-left"
                        onClick={() => addPlugin("repository")}
                      >
                        <GitBranch className="size-5" />
                        <span className="space-y-1">
                          <span className="block font-medium">仓库插件</span>
                          <span className="block text-xs font-normal text-muted-foreground">
                            配置仓库主机、上传类型、目录与字段脱敏
                          </span>
                        </span>
                      </Button>
                    )}
                    {availablePluginTypes.includes("skill_filter") && (
                      <Button
                        variant="outline"
                        className="h-auto justify-start gap-3 p-4 text-left"
                        onClick={() => addPlugin("skill_filter")}
                      >
                        <ListFilter className="size-5" />
                        <span className="space-y-1">
                          <span className="block font-medium">
                            Skill 过滤插件
                          </span>
                          <span className="block text-xs font-normal text-muted-foreground">
                            配置需要拦截的 Skill 名称关键词或正则
                          </span>
                        </span>
                      </Button>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
            </TabsContent>
          </Tabs>
        </main>

        <footer className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleCheck
                className={`size-4 ${dirty ? "text-amber-600" : "text-emerald-600"}`}
              />
              {dirty ? "有未保存的更改" : "配置已同步"}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={runTest} disabled={busy}>
                <FlaskConical />
                验证配置
              </Button>
              <Button variant="outline" onClick={restartFilter} disabled={busy}>
                <RefreshCw className={busy ? "animate-spin" : ""} />
                重启过滤服务
              </Button>
              <Button onClick={saveConfig} disabled={busy || !dirty}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Save />}
                保存更改
              </Button>
            </div>
          </div>
        </footer>
      </div>
      <Toaster position="top-right" richColors closeButton duration={5000} />
    </TooltipProvider>
  )
}

export default App
