import { useCallback, useEffect, useMemo, useState } from "react"
import JsonView from "@uiw/react-json-view"
import { lightTheme } from "@uiw/react-json-view/light"
import {
  Activity,
  Bot,
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
  ShieldAlert,
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
  priority: number
  match: {
    all_repositories: boolean
    hosts: string[]
    repositories: string[]
    directories: string[]
    branches: string[]
  }
  fixed_project_directory: string
  allow: Record<EventKey, boolean>
  fields: Record<FieldKey, boolean>
}

type SensitiveDataPolicy = {
  installed: boolean
  enabled: boolean
  action: "redact" | "block"
  event_types: Record<EventKey, boolean>
  built_in_rules: Record<"api_key" | "private_key" | "credential" | "email" | "phone", boolean>
  custom_patterns: string[]
}

type AgentModelPolicy = {
  installed: boolean
  enabled: boolean
  mode: "audit" | "block"
  allowed_agents: string[]
  allowed_models: string[]
  blocked_patterns: string[]
}

type PolicyConfig = {
  version: 1 | 2
  git_ai_enabled: boolean
  default_allow_unmatched: boolean
  skill_policy: {
    installed: boolean
    enabled: boolean
    blocked_patterns: string[]
  }
  plugins: RepositoryPlugin[]
  plugin_order: string[]
  sensitive_data_policy: SensitiveDataPolicy
  agent_model_policy: AgentModelPolicy
}

type RuntimeStatus = {
  ok: boolean
  gitAiEnabled?: boolean
  gitAiStatus?: "enabled" | "paused"
  gitAiVersion?: string
  distribution?: "custom-metrics" | "upstream-oss"
  granularFilterActive?: boolean
  capabilities?: {
    nativeConfig: boolean
    granularUploadFilter: boolean
  }
  filter?: {
    ok?: boolean
    error?: string
  }
}

type ConfigResponse = {
  gitAi: Partial<GitAiConfig>
  policy: PolicyConfig
  runtime?: RuntimeStatus
}

type FilterAuditEvent = {
  timestamp: string
  eventType: string
  reason: string
  plugin: string | null
  repositories: string[]
  skills: string[]
}

type FilterAuditResponse = {
  since: string
  events: FilterAuditEvent[]
}

type FilterAuditSummary = {
  name: string
  count: number
  timestamp: string
  reason: string
}

const REPOSITORY_MATCH_FIELDS = [
  "hosts",
  "repositories",
  "directories",
  "branches",
] as const

type RepositoryMatchField = (typeof REPOSITORY_MATCH_FIELDS)[number]

const AGENT_MODEL_TEXT_FIELDS = [
  "allowed_agents",
  "allowed_models",
  "blocked_patterns",
] as const

type AgentModelTextField = (typeof AGENT_MODEL_TEXT_FIELDS)[number]

const EMPTY_GIT_AI: GitAiConfig = {
  git_path: "/usr/bin/git",
  exclude_repositories: [],
  exclude_prompts_in_repositories: [],
  disable_auto_updates: false,
  disable_version_checks: false,
  telemetry_oss: "on",
}

const EMPTY_EVENT_SWITCHES = Object.fromEntries(
  Object.keys(EVENT_LABELS).map((key) => [key, true]),
) as Record<EventKey, boolean>

const DEFAULT_SENSITIVE_POLICY: SensitiveDataPolicy = {
  installed: false,
  enabled: false,
  action: "redact",
  event_types: EMPTY_EVENT_SWITCHES,
  built_in_rules: {
    api_key: true,
    private_key: true,
    credential: true,
    email: false,
    phone: false,
  },
  custom_patterns: [],
}

const DEFAULT_AGENT_MODEL_POLICY: AgentModelPolicy = {
  installed: false,
  enabled: false,
  mode: "audit",
  allowed_agents: [],
  allowed_models: [],
  blocked_patterns: [],
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

function repositoryMatchTextKey(pluginId: string, field: RepositoryMatchField) {
  return `${pluginId}:${field}`
}

function toRepositoryMatchTexts(plugins: RepositoryPlugin[]) {
  return Object.fromEntries(
    plugins.flatMap((plugin) =>
      REPOSITORY_MATCH_FIELDS.map((field) => [
        repositoryMatchTextKey(plugin.id, field),
        toLines(plugin.match[field]),
      ]),
    ),
  ) as Record<string, string>
}

function toAgentModelTexts(policy: AgentModelPolicy) {
  return Object.fromEntries(
    AGENT_MODEL_TEXT_FIELDS.map((field) => [field, toLines(policy[field])]),
  ) as Record<AgentModelTextField, string>
}

function summarizeFilterAuditEvents(
  events: FilterAuditEvent[],
  field: "repositories" | "skills",
) {
  const summaries = new Map<string, FilterAuditSummary>()
  for (const event of events) {
    for (const name of event[field]) {
      const current = summaries.get(name)
      if (!current) {
        summaries.set(name, {
          name,
          count: 1,
          timestamp: event.timestamp,
          reason: event.reason,
        })
      } else {
        current.count += 1
        if (event.timestamp > current.timestamp) {
          current.timestamp = event.timestamp
          current.reason = event.reason
        }
      }
    }
  }
  return [...summaries.values()].sort(
    (left, right) =>
      right.timestamp.localeCompare(left.timestamp) || right.count - left.count,
  )
}

function formatAuditTime(value: string) {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return "时间未知"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time)
}

function formatFilterReason(reason: string) {
  if (reason === "skill_pattern") return "命中 Skill 规则"
  if (reason === "default_deny") return "未匹配仓库默认拦截"
  if (reason === "git_ai_paused") return "Git AI 已暂停"
  if (reason === "sensitive_content") return "命中敏感内容规则"
  if (reason === "agent_model_policy") return "命中 Agent / 模型规则"
  if (reason.startsWith("plugin:")) return "命中仓库插件策略"
  return reason || "已拦截"
}

function repositoryPluginOrderKey(pluginId: string) {
  return `repository:${pluginId}`
}

function normalizePluginOrder(
  order: string[] | undefined,
  policy: Pick<
    PolicyConfig,
    "plugins" | "skill_policy" | "sensitive_data_policy" | "agent_model_policy"
  >,
) {
  const expected = [
    ...policy.plugins.map((plugin) => repositoryPluginOrderKey(plugin.id)),
    ...(policy.skill_policy.installed ? ["skill_filter"] : []),
    ...(policy.sensitive_data_policy.installed ? ["sensitive_data"] : []),
    ...(policy.agent_model_policy.installed ? ["agent_model"] : []),
  ]
  const expectedKeys = new Set(expected)
  const result: string[] = []
  for (const key of order ?? []) {
    if (expectedKeys.has(key) && !result.includes(key)) {
      result.push(key)
    }
  }
  return [...result, ...expected.filter((key) => !result.includes(key))]
}

function normalizePolicy(value: PolicyConfig): PolicyConfig {
  const legacySkillPolicy = value.skill_policy as PolicyConfig["skill_policy"] & {
    fixed_project_directory?: string
  }
  const normalized: PolicyConfig = {
    ...value,
    version: 2,
    git_ai_enabled: value.git_ai_enabled ?? true,
    skill_policy: {
      installed: value.skill_policy.installed ?? true,
      enabled: value.skill_policy.enabled,
      blocked_patterns: value.skill_policy.blocked_patterns,
    },
    plugins: value.plugins.map((plugin) => ({
      ...plugin,
      priority: plugin.priority ?? 100,
      match: {
        all_repositories: plugin.match?.all_repositories ?? false,
        hosts: plugin.match?.hosts ?? [],
        repositories: plugin.match?.repositories ?? [],
        directories: plugin.match?.directories ?? [],
        branches: plugin.match?.branches ?? [],
      },
      fixed_project_directory:
        plugin.fixed_project_directory ??
        (plugin.id === "github"
          ? legacySkillPolicy.fixed_project_directory ?? ""
          : ""),
    })),
    sensitive_data_policy: {
      ...DEFAULT_SENSITIVE_POLICY,
      ...value.sensitive_data_policy,
      event_types: {
        ...EMPTY_EVENT_SWITCHES,
        ...value.sensitive_data_policy?.event_types,
      },
      built_in_rules: {
        ...DEFAULT_SENSITIVE_POLICY.built_in_rules,
        ...value.sensitive_data_policy?.built_in_rules,
      },
      custom_patterns: value.sensitive_data_policy?.custom_patterns ?? [],
    },
    agent_model_policy: {
      ...DEFAULT_AGENT_MODEL_POLICY,
      ...value.agent_model_policy,
      allowed_agents: value.agent_model_policy?.allowed_agents ?? [],
      allowed_models: value.agent_model_policy?.allowed_models ?? [],
        blocked_patterns: value.agent_model_policy?.blocked_patterns ?? [],
      },
    plugin_order: [],
  }
  normalized.plugin_order = normalizePluginOrder(value.plugin_order, normalized)
  return normalized
}

function nextRepositoryPluginId(plugins: RepositoryPlugin[]) {
  let sequence = 1
  while (plugins.some((plugin) => plugin.id === `repository-${sequence}`)) {
    sequence += 1
  }
  return `repository-${sequence}`
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
  const [excludeRepositoriesText, setExcludeRepositoriesText] = useState("")
  const [excludePromptsText, setExcludePromptsText] = useState("")
  const [skillBlockedPatternsText, setSkillBlockedPatternsText] = useState("")
  const [repositoryMatchTexts, setRepositoryMatchTexts] = useState<
    Record<string, string>
  >({})
  const [sensitivePatternsText, setSensitivePatternsText] = useState("")
  const [agentModelTexts, setAgentModelTexts] = useState<
    Record<AgentModelTextField, string>
  >(() => toAgentModelTexts(DEFAULT_AGENT_MODEL_POLICY))
  const [policy, setPolicy] = useState<PolicyConfig | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus>({ ok: false })
  const [filterEvents, setFilterEvents] = useState<FilterAuditEvent[]>([])
  const [filterEventsLoading, setFilterEventsLoading] = useState(false)
  const [filterEventsError, setFilterEventsError] = useState("")
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [addPluginOpen, setAddPluginOpen] = useState(false)
  const [viewingConfig, setViewingConfig] = useState(false)
  const [configViewer, setConfigViewer] = useState<{
    title: string
    description: string
    content: Record<string, unknown>
  } | null>(null)

  const loadConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/config", { cache: "no-store" })
      const payload = await readResponse<ConfigResponse>(response)
      const nextGitAi = { ...EMPTY_GIT_AI, ...payload.gitAi }
      setGitAi(nextGitAi)
      setExcludeRepositoriesText(toLines(nextGitAi.exclude_repositories))
      setExcludePromptsText(
        toLines(nextGitAi.exclude_prompts_in_repositories),
      )
      const nextPolicy = normalizePolicy(payload.policy)
      setSkillBlockedPatternsText(
        toLines(nextPolicy.skill_policy.blocked_patterns),
      )
      setRepositoryMatchTexts(toRepositoryMatchTexts(nextPolicy.plugins))
      setSensitivePatternsText(
        toLines(nextPolicy.sensitive_data_policy.custom_patterns),
      )
      setAgentModelTexts(toAgentModelTexts(nextPolicy.agent_model_policy))
      setPolicy(nextPolicy)
      setRuntime(payload.runtime ?? { ok: false })
      setDirty(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取配置失败")
    }
  }, [])

  const loadFilterEvents = useCallback(async () => {
    setFilterEventsLoading(true)
    try {
      const response = await fetch("/api/filter-events", { cache: "no-store" })
      const payload = await readResponse<FilterAuditResponse>(response)
      setFilterEvents(Array.isArray(payload.events) ? payload.events : [])
      setFilterEventsError("")
    } catch (error) {
      setFilterEventsError(
        error instanceof Error ? error.message : "读取过滤记录失败",
      )
    } finally {
      setFilterEventsLoading(false)
    }
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadConfig())
    return () => window.cancelAnimationFrame(frame)
  }, [loadConfig])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadFilterEvents())
    const interval = window.setInterval(() => void loadFilterEvents(), 30_000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(interval)
    }
  }, [loadFilterEvents])

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
    (policy?.plugins.length ?? 0) +
    (policy?.skill_policy.installed ? 1 : 0) +
    (policy?.sensitive_data_policy.installed ? 1 : 0) +
    (policy?.agent_model_policy.installed ? 1 : 0)
  const enabledModuleCount =
    (policy?.plugins.filter((plugin) => plugin.enabled).length ?? 0) +
    (policy?.skill_policy.installed && policy.skill_policy.enabled ? 1 : 0) +
    (policy?.sensitive_data_policy.installed && policy.sensitive_data_policy.enabled ? 1 : 0) +
    (policy?.agent_model_policy.installed && policy.agent_model_policy.enabled ? 1 : 0)
  const pluginOrderIndexes = useMemo(
    () => new Map(policy?.plugin_order.map((key, index) => [key, index])),
    [policy?.plugin_order],
  )
  const filteredRepositories = useMemo(
    () => summarizeFilterAuditEvents(filterEvents, "repositories"),
    [filterEvents],
  )
  const filteredSkills = useMemo(
    () => summarizeFilterAuditEvents(filterEvents, "skills"),
    [filterEvents],
  )
  const filterAuditSections = useMemo(
    () => [
      {
        title: "仓库",
        items: filteredRepositories,
        emptyMessage: "尚未拦截包含仓库信息的上报",
      },
      {
        title: "Skills",
        items: filteredSkills,
        emptyMessage: "尚未拦截 Skill 调用",
      },
    ],
    [filteredRepositories, filteredSkills],
  )
  const savedGitAiEnabled = runtime.gitAiEnabled ?? policy?.git_ai_enabled ?? true
  const hasPendingGitAiStatus = policy?.git_ai_enabled !== savedGitAiEnabled
  const filterServiceOnline = runtime.filter?.ok === true
  const availablePluginTypes = useMemo(() => {
    const available: Array<
      "repository" | "skill_filter" | "sensitive_data" | "agent_model"
    > = []
    if (policy) available.push("repository")
    if (!policy?.skill_policy.installed) available.push("skill_filter")
    if (!policy?.sensitive_data_policy.installed) available.push("sensitive_data")
    if (!policy?.agent_model_policy.installed) available.push("agent_model")
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

  const updatePluginMatchText = (
    pluginId: string,
    field: RepositoryMatchField,
    value: string,
  ) => {
    setRepositoryMatchTexts((current) => ({
      ...current,
      [repositoryMatchTextKey(pluginId, field)]: value,
    }))
    updatePlugin(pluginId, (current) => ({
      ...current,
      match: {
        ...current.match,
        [field]: fromLines(value),
      },
    }))
  }

  const addPlugin = (
    type:
      | "repository"
      | "skill_filter"
      | "sensitive_data"
      | "agent_model",
  ) => {
    if (!policy) return
    if (type === "repository") {
      const pluginId = nextRepositoryPluginId(policy.plugins)
      setRepositoryMatchTexts((current) => ({
        ...current,
        [repositoryMatchTextKey(pluginId, "hosts")]: "example.com",
        [repositoryMatchTextKey(pluginId, "repositories")]: "",
        [repositoryMatchTextKey(pluginId, "directories")]: "",
        [repositoryMatchTextKey(pluginId, "branches")]: "",
      }))
      markPolicy({
        ...policy,
        plugins: [
          ...policy.plugins,
          {
            id: pluginId,
            name: `仓库插件 ${policy.plugins.length + 1}`,
            enabled: true,
            priority: 100,
            match: {
              all_repositories: false,
              hosts: ["example.com"],
              repositories: [],
              directories: [],
              branches: [],
            },
            fixed_project_directory: "",
            allow: Object.fromEntries(
              Object.keys(EVENT_LABELS).map((key) => [key, false]),
            ) as Record<EventKey, boolean>,
            fields: Object.fromEntries(
              Object.keys(FIELD_LABELS).map((key) => [key, false]),
            ) as Record<FieldKey, boolean>,
          },
        ],
        plugin_order: [
          ...policy.plugin_order,
          repositoryPluginOrderKey(pluginId),
        ],
      })
    } else if (type === "skill_filter") {
      markPolicy({
        ...policy,
        skill_policy: {
          ...policy.skill_policy,
          installed: true,
          enabled: true,
        },
        plugin_order: [...policy.plugin_order, "skill_filter"],
      })
    } else if (type === "sensitive_data") {
      markPolicy({
        ...policy,
        sensitive_data_policy: {
          ...DEFAULT_SENSITIVE_POLICY,
          installed: true,
          enabled: true,
        },
        plugin_order: [...policy.plugin_order, "sensitive_data"],
      })
    } else if (type === "agent_model") {
      markPolicy({
        ...policy,
        agent_model_policy: {
          ...DEFAULT_AGENT_MODEL_POLICY,
          installed: true,
          enabled: true,
        },
        plugin_order: [...policy.plugin_order, "agent_model"],
      })
    }
    setAddPluginOpen(false)
  }

  const deletePlugin = (pluginId: string) => {
    if (!policy) return
    setRepositoryMatchTexts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !key.startsWith(`${pluginId}:`)),
      ),
    )
    markPolicy({
      ...policy,
      plugins: policy.plugins.filter((plugin) => plugin.id !== pluginId),
      plugin_order: policy.plugin_order.filter(
        (key) => key !== repositoryPluginOrderKey(pluginId),
      ),
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
      plugin_order: policy.plugin_order.filter((key) => key !== "skill_filter"),
    })
  }

  const uninstallPolicyPlugin = (
    target: "sensitive_data_policy" | "agent_model_policy",
  ) => {
    if (!policy) return
    markPolicy({
      ...policy,
      [target]: {
        ...policy[target],
        installed: false,
        enabled: false,
      },
      plugin_order: policy.plugin_order.filter(
        (key) =>
          key !==
          (target === "sensitive_data_policy" ? "sensitive_data" : "agent_model"),
      ),
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
      const nextGitAi = { ...EMPTY_GIT_AI, ...payload.gitAi }
      setGitAi(nextGitAi)
      setExcludeRepositoriesText(toLines(nextGitAi.exclude_repositories))
      setExcludePromptsText(
        toLines(nextGitAi.exclude_prompts_in_repositories),
      )
      const nextPolicy = normalizePolicy(payload.policy)
      setSkillBlockedPatternsText(
        toLines(nextPolicy.skill_policy.blocked_patterns),
      )
      setRepositoryMatchTexts(toRepositoryMatchTexts(nextPolicy.plugins))
      setSensitivePatternsText(
        toLines(nextPolicy.sensitive_data_policy.custom_patterns),
      )
      setAgentModelTexts(toAgentModelTexts(nextPolicy.agent_model_policy))
      setPolicy(nextPolicy)
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

  const viewPersistedConfig = async (target: "gitAi" | "policy") => {
    setViewingConfig(true)
    try {
      const response = await fetch("/api/config", { cache: "no-store" })
      const payload = await readResponse<ConfigResponse>(response)
      setConfigViewer(
        target === "gitAi"
          ? {
              title: "当前 Git AI 原生配置",
              description:
                "读取 ~/.git-ai/config.json 中由本页面管理的已保存字段，未保存更改和敏感未知字段不会显示。",
              content: payload.gitAi,
            }
          : {
              title: "当前插件策略配置",
              description:
                "读取 ~/.git-ai/filter_plugins.json 中已写入磁盘的完整插件策略，未保存更改不会显示。",
              content: payload.policy,
            },
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取当前配置失败")
    } finally {
      setViewingConfig(false)
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
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-semibold">Git AI 配置中心</h1>
                  {runtime.gitAiVersion && (
                    <Badge variant="outline" className="font-mono text-xs font-normal">
                      v{runtime.gitAiVersion}
                    </Badge>
                  )}
                </div>
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
            </Badge>
          </div>
        </header>

        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
            <Card size="sm">
              <CardHeader>
                <CardDescription>当前 Git AI 状态</CardDescription>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity
                    className={`size-4 ${
                      savedGitAiEnabled ? "text-emerald-600" : "text-amber-600"
                    }`}
                  />
                  {hasPendingGitAiStatus
                    ? policy.git_ai_enabled
                      ? "开启（待保存）"
                      : "暂停（待保存）"
                    : savedGitAiEnabled
                      ? "已开启"
                      : "已暂停"}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>过滤服务状态</CardDescription>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity
                    className={`size-4 ${
                      filterServiceOnline ? "text-emerald-600" : "text-destructive"
                    }`}
                  />
                  {filterServiceOnline ? "已在线" : "已离线"}
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
                <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <CardTitle>Git AI 原生设置</CardTitle>
                    <CardDescription>
                      写入 ~/.git-ai/config.json，未知字段会原样保留。
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void viewPersistedConfig("gitAi")}
                    disabled={viewingConfig}
                  >
                    {viewingConfig ? "读取中..." : "查看配置"}
                  </Button>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    <SettingSwitch
                      id="git-ai-enabled"
                      title="Git AI"
                      description={
                        policy.git_ai_enabled
                          ? "已开启：按当前插件策略处理并转发 Git AI 上报"
                          : "已暂停：全部 Git AI 上报会在本机拦截，恢复后继续按原策略处理"
                      }
                      checked={policy.git_ai_enabled}
                      onCheckedChange={(checked) =>
                        markPolicy({ ...policy, git_ai_enabled: checked })
                      }
                    />
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
                        value={excludeRepositoriesText}
                        onChange={(event) => {
                          const value = event.target.value
                          setExcludeRepositoriesText(value)
                          markGitAi({
                            ...gitAi,
                            exclude_repositories: fromLines(value),
                          })
                        }}
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
                        value={excludePromptsText}
                        onChange={(event) => {
                          const value = event.target.value
                          setExcludePromptsText(value)
                          markGitAi({
                            ...gitAi,
                            exclude_prompts_in_repositories: fromLines(value),
                          })
                        }}
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
                        ? "检测到官方上游版：原生设置生效，但官方版没有 custom_metrics 扩展点，下面的仓库和 Skill 细粒度上报规则不会接管 /worker/metrics/upload。仓库插件可以添加多个，主机规则重叠时按列表顺序使用第一个命中插件。"
                        : "检测到 custom_metrics 定制版：仓库、Skill、数据类型和字段规则会在请求离开本机前执行。仓库插件可以添加多个，主机规则重叠时按列表顺序使用第一个命中插件。"}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void viewPersistedConfig("policy")}
                      disabled={viewingConfig}
                    >
                      {viewingConfig ? "读取中..." : "查看配置"}
                    </Button>
                    <Badge
                      variant={
                        runtime.granularFilterActive ? "secondary" : "outline"
                      }
                    >
                      {runtime.granularFilterActive
                        ? "细粒度过滤已接管"
                        : "仅原生配置兼容"}
                    </Badge>
                  </div>
                </CardHeader>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader className="gap-4 border-b bg-muted/30 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-2">
                    <Badge variant="secondary">
                      <Activity />
                      过滤观察
                    </Badge>
                    <div>
                      <CardTitle>最近 24 小时的拦截记录</CardTitle>
                      <CardDescription>
                        已拦截 {filterEvents.length} 次上报，按仓库和 Skill 汇总。
                      </CardDescription>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadFilterEvents()}
                    disabled={filterEventsLoading}
                  >
                    <RefreshCw
                      className={filterEventsLoading ? "animate-spin" : undefined}
                    />
                    刷新记录
                  </Button>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                  {filterEventsError ? (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                      无法读取过滤记录：{filterEventsError}
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {filterAuditSections.map(({ title, items, emptyMessage }) => (
                        <section
                          key={title}
                          className="overflow-hidden rounded-lg border bg-background"
                        >
                          <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-3">
                            <h3 className="text-sm font-medium">{title}</h3>
                            <Badge variant="outline">{items.length} 项</Badge>
                          </div>
                          {items.length ? (
                            <ul className="divide-y">
                              {items.map((item) => (
                                <li
                                  key={item.name}
                                  className="flex items-start justify-between gap-3 px-4 py-3"
                                >
                                  <div className="min-w-0 space-y-1">
                                    <p className="truncate font-mono text-xs font-medium">
                                      {item.name}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {formatFilterReason(item.reason)} · 最近 {formatAuditTime(item.timestamp)}
                                    </p>
                                  </div>
                                  <Badge variant="secondary" className="shrink-0">
                                    {item.count} 次
                                  </Badge>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                              {emptyMessage}
                            </p>
                          )}
                        </section>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    记录仅保存在本机 24 小时，包含时间、仓库或 Skill 标识及拦截原因，不保存上报正文。
                  </p>
                </CardContent>
              </Card>

              <div className="flex flex-col gap-4">
              {policy.plugins.map((plugin) => (
                <Card
                  key={plugin.id}
                  style={{
                    order: pluginOrderIndexes.get(repositoryPluginOrderKey(plugin.id)),
                  }}
                >
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
                      <div className="space-y-4">
                        <SettingSwitch
                          id={`global-${plugin.id}`}
                          title="全部仓库（全局规则）"
                          description="全局规则始终排在所有特定仓库规则之后，适合作为默认策略。"
                          checked={plugin.match.all_repositories}
                          onCheckedChange={(checked) =>
                            updatePlugin(plugin.id, (current) => ({
                              ...current,
                              match: {
                                ...current.match,
                                all_repositories: checked,
                              },
                            }))
                          }
                        />
                        <div className="space-y-2">
                          <Label htmlFor={`priority-${plugin.id}`}>特定规则优先级</Label>
                          <p className="text-sm text-muted-foreground">
                            数值越大越优先；同优先级按插件列表顺序匹配。
                          </p>
                          <Input
                            id={`priority-${plugin.id}`}
                            type="number"
                            min="0"
                            max="1000"
                            value={plugin.priority}
                            onChange={(event) => {
                              const value = Number.parseInt(event.target.value, 10)
                              updatePlugin(plugin.id, (current) => ({
                                ...current,
                                priority: Number.isFinite(value)
                                  ? Math.min(1000, Math.max(0, value))
                                  : 0,
                              }))
                            }}
                          />
                        </div>
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

                    {!plugin.match.all_repositories && (
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor={`hosts-${plugin.id}`}>匹配仓库主机</Label>
                          <p className="text-sm text-muted-foreground">
                            每行一条，可用 `github.com` 或 `*github.com*`。
                          </p>
                          <Textarea
                            id={`hosts-${plugin.id}`}
                            className="min-h-28 font-mono text-xs"
                            value={
                              repositoryMatchTexts[
                                repositoryMatchTextKey(plugin.id, "hosts")
                              ] ?? toLines(plugin.match.hosts)
                            }
                            onChange={(event) =>
                              updatePluginMatchText(
                                plugin.id,
                                "hosts",
                                event.target.value,
                              )
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`repositories-${plugin.id}`}>匹配仓库</Label>
                          <p className="text-sm text-muted-foreground">
                            每行一条，可填 owner/repo、远程地址或通配符。
                          </p>
                          <Textarea
                            id={`repositories-${plugin.id}`}
                            className="min-h-28 font-mono text-xs"
                            value={
                              repositoryMatchTexts[
                                repositoryMatchTextKey(plugin.id, "repositories")
                              ] ?? toLines(plugin.match.repositories)
                            }
                            onChange={(event) =>
                              updatePluginMatchText(
                                plugin.id,
                                "repositories",
                                event.target.value,
                              )
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`directories-${plugin.id}`}>匹配项目目录</Label>
                          <p className="text-sm text-muted-foreground">
                            多条件会同时生效；可用 `/work/*` 缩小范围。
                          </p>
                          <Textarea
                            id={`directories-${plugin.id}`}
                            className="min-h-28 font-mono text-xs"
                            value={
                              repositoryMatchTexts[
                                repositoryMatchTextKey(plugin.id, "directories")
                              ] ?? toLines(plugin.match.directories)
                            }
                            onChange={(event) =>
                              updatePluginMatchText(
                                plugin.id,
                                "directories",
                                event.target.value,
                              )
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`branches-${plugin.id}`}>匹配分支</Label>
                          <p className="text-sm text-muted-foreground">
                            每行一条，例如 main、release/* 或 feature/*。
                          </p>
                          <Textarea
                            id={`branches-${plugin.id}`}
                            className="min-h-28 font-mono text-xs"
                            value={
                              repositoryMatchTexts[
                                repositoryMatchTextKey(plugin.id, "branches")
                              ] ?? toLines(plugin.match.branches)
                            }
                            onChange={(event) =>
                              updatePluginMatchText(
                                plugin.id,
                                "branches",
                                event.target.value,
                              )
                            }
                          />
                        </div>
                      </div>
                    )}

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
                      {plugin.match.all_repositories
                        ? "全局默认策略"
                        : `特定规则 · 优先级 ${plugin.priority}`}
                    </span>
                  </CardFooter>
                </Card>
              ))}

              {policy.skill_policy.installed && (
                <Card style={{ order: pluginOrderIndexes.get("skill_filter") }}>
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
                        value={skillBlockedPatternsText}
                        onChange={(event) => {
                          const nextText = event.target.value
                          setSkillBlockedPatternsText(nextText)
                          markPolicy({
                            ...policy,
                            skill_policy: {
                              ...policy.skill_policy,
                              blocked_patterns: fromLines(nextText),
                            },
                          })
                        }}
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

              {policy.sensitive_data_policy.installed && (
                <Card style={{ order: pluginOrderIndexes.get("sensitive_data") }}>
                  <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-2">
                      <Badge variant="secondary">
                        <ShieldAlert />
                        敏感内容脱敏插件
                      </Badge>
                      <CardTitle>请求内容二次保护</CardTitle>
                      <CardDescription>
                        在请求离开本机前检测文本。不会保存命中的原始内容。
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="sensitive-enabled">启用</Label>
                      <Switch
                        id="sensitive-enabled"
                        checked={policy.sensitive_data_policy.enabled}
                        onCheckedChange={(checked) =>
                          markPolicy({
                            ...policy,
                            sensitive_data_policy: {
                              ...policy.sensitive_data_policy,
                              enabled: checked,
                            },
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="删除敏感内容脱敏插件"
                        onClick={() => uninstallPolicyPlugin("sensitive_data_policy")}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="sensitive-action">命中后的动作</Label>
                        <select
                          id="sensitive-action"
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                          value={policy.sensitive_data_policy.action}
                          onChange={(event) =>
                            markPolicy({
                              ...policy,
                              sensitive_data_policy: {
                                ...policy.sensitive_data_policy,
                                action: event.target.value as "redact" | "block",
                              },
                            })
                          }
                        >
                          <option value="redact">脱敏后继续上报</option>
                          <option value="block">直接阻止上报</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="sensitive-patterns">自定义正则</Label>
                        <Textarea
                          id="sensitive-patterns"
                          className="min-h-24 font-mono text-xs"
                          placeholder="每行一个正则"
                          value={sensitivePatternsText}
                          onChange={(event) => {
                            const value = event.target.value
                            setSensitivePatternsText(value)
                            markPolicy({
                              ...policy,
                              sensitive_data_policy: {
                                ...policy.sensitive_data_policy,
                                custom_patterns: fromLines(value),
                              },
                            })
                          }}
                        />
                      </div>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <h3 className="text-sm font-medium">内置识别规则</h3>
                        <p className="text-sm text-muted-foreground">
                          默认启用密钥、私钥和凭据；邮箱与手机号由你决定是否纳入。
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        {(
                          [
                            ["api_key", "API Key"],
                            ["private_key", "私钥"],
                            ["credential", "密码 / 凭据"],
                            ["email", "邮箱"],
                            ["phone", "手机号"],
                          ] as const
                        ).map(([key, label]) => (
                          <PermissionSwitch
                            key={key}
                            id={`sensitive-${key}`}
                            label={label}
                            checked={policy.sensitive_data_policy.built_in_rules[key]}
                            onCheckedChange={(checked) =>
                              markPolicy({
                                ...policy,
                                sensitive_data_policy: {
                                  ...policy.sensitive_data_policy,
                                  built_in_rules: {
                                    ...policy.sensitive_data_policy.built_in_rules,
                                    [key]: checked,
                                  },
                                },
                              })
                            }
                          />
                        ))}
                      </div>
                    </div>
                    <div className="space-y-3">
                      <h3 className="text-sm font-medium">作用数据类型</h3>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {(Object.keys(EVENT_LABELS) as EventKey[]).map((key) => (
                          <PermissionSwitch
                            key={key}
                            id={`sensitive-event-${key}`}
                            label={EVENT_LABELS[key]}
                            checked={policy.sensitive_data_policy.event_types[key]}
                            onCheckedChange={(checked) =>
                              markPolicy({
                                ...policy,
                                sensitive_data_policy: {
                                  ...policy.sensitive_data_policy,
                                  event_types: {
                                    ...policy.sensitive_data_policy.event_types,
                                    [key]: checked,
                                  },
                                },
                              })
                            }
                          />
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {policy.agent_model_policy.installed && (
                <Card style={{ order: pluginOrderIndexes.get("agent_model") }}>
                  <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-2">
                      <Badge variant="secondary">
                        <Bot />
                        Agent / 模型治理插件
                      </Badge>
                      <CardTitle>允许名单与阻止规则</CardTitle>
                      <CardDescription>
                        允许名单支持通配符；审计模式只记录本地统计，阻止模式会拦截不合规上报。
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="agent-model-enabled">启用</Label>
                      <Switch
                        id="agent-model-enabled"
                        checked={policy.agent_model_policy.enabled}
                        onCheckedChange={(checked) =>
                          markPolicy({
                            ...policy,
                            agent_model_policy: {
                              ...policy.agent_model_policy,
                              enabled: checked,
                            },
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="删除 Agent / 模型治理插件"
                        onClick={() => uninstallPolicyPlugin("agent_model_policy")}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="max-w-md space-y-2">
                      <Label htmlFor="agent-model-mode">治理模式</Label>
                      <select
                        id="agent-model-mode"
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                        value={policy.agent_model_policy.mode}
                        onChange={(event) =>
                          markPolicy({
                            ...policy,
                            agent_model_policy: {
                              ...policy.agent_model_policy,
                              mode: event.target.value as "audit" | "block",
                            },
                          })
                        }
                      >
                        <option value="audit">仅审计，不阻止</option>
                        <option value="block">命中规则时阻止</option>
                      </select>
                    </div>
                    <div className="grid gap-4 md:grid-cols-3">
                      {(
                        [
                          ["allowed_agents", "允许的 Agent", "例如 codex、claude*"],
                          ["allowed_models", "允许的模型", "例如 gpt-5*、claude-sonnet-*"],
                          ["blocked_patterns", "阻止正则", "每行一个，不区分大小写"],
                        ] as const
                      ).map(([key, label, placeholder]) => (
                        <div key={key} className="space-y-2">
                          <Label htmlFor={`agent-model-${key}`}>{label}</Label>
                          <Textarea
                            id={`agent-model-${key}`}
                            className="min-h-40 font-mono text-xs"
                            placeholder={placeholder}
                            value={agentModelTexts[key]}
                            onChange={(event) => {
                              const value = event.target.value
                              setAgentModelTexts((current) => ({
                                ...current,
                                [key]: value,
                              }))
                              markPolicy({
                                ...policy,
                                agent_model_policy: {
                                  ...policy.agent_model_policy,
                                  [key]: fromLines(value),
                                },
                              })
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {!policy.plugins.length &&
                !policy.skill_policy.installed &&
                !policy.sensitive_data_policy.installed &&
                !policy.agent_model_policy.installed && (
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
              </div>

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
                      仓库插件可以添加多个；其余插件使用独立配置表单且每种只能添加一次。新插件会追加到当前列表最后。
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
                    {availablePluginTypes.includes("sensitive_data") && (
                      <Button
                        variant="outline"
                        className="h-auto justify-start gap-3 p-4 text-left"
                        onClick={() => addPlugin("sensitive_data")}
                      >
                        <ShieldAlert className="size-5" />
                        <span className="space-y-1">
                          <span className="block font-medium">敏感内容脱敏</span>
                          <span className="block text-xs font-normal text-muted-foreground">
                            检测密钥、私钥、凭据等文本，可脱敏或阻止上报
                          </span>
                        </span>
                      </Button>
                    )}
                    {availablePluginTypes.includes("agent_model") && (
                      <Button
                        variant="outline"
                        className="h-auto justify-start gap-3 p-4 text-left"
                        onClick={() => addPlugin("agent_model")}
                      >
                        <Bot className="size-5" />
                        <span className="space-y-1">
                          <span className="block font-medium">Agent / 模型治理</span>
                          <span className="block text-xs font-normal text-muted-foreground">
                            设置 Agent、模型允许名单与阻止规则
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

        <Dialog
          open={Boolean(configViewer)}
          onOpenChange={(open) => {
            if (!open) setConfigViewer(null)
          }}
        >
          <DialogContent className="w-[96vw] max-w-6xl sm:max-w-6xl">
            <DialogHeader>
              <DialogTitle>{configViewer?.title}</DialogTitle>
              <DialogDescription>{configViewer?.description}</DialogDescription>
            </DialogHeader>
            <div className="max-h-[70svh] overflow-auto rounded-lg border bg-muted/50 p-4">
              {configViewer && (
                <JsonView
                  value={configViewer.content}
                  collapsed={false}
                  displayDataTypes={false}
                  enableClipboard={false}
                  shortenTextAfterLength={0}
                  style={lightTheme}
                />
              )}
            </div>
          </DialogContent>
        </Dialog>

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
