# dsh-mcp-manager 设计（v0.3.2）

> 状态：已实施并通过隔离 e2e。初版 2026-10-19；2026-10-21 移除工作区作用域与自建加密；
> 2026-10-22 安装改为正式 profile bundle 注册（安装后显性出现在「插件 → 已安装插件」）。
> 面向维护者的实现约定；用户使用说明见 [README.md](README.md)。

## 1. 目标与非目标

**目标**

- 在 DSH Desktop 里用原生 GUI 管理 MCP：增删改、启停、连通性测试、粘贴 `mcpServers` JSON 导入；
- 连接挂在 **profile 级**（一个宿主进程一份），通过 `@deepseek-ai/dsh-mcp-client` 动态挂载，工具以 `mcp__<server>__<tool>` 暴露；
- 注册表独立于 patch 层：增删改不触发插件树热重载；
- 只读展示宿主已配置的原生 MCP，并处理同名冲突；
- 密钥优先引用化（`env:` / `credential:`），允许 0600 明文，**不自建加密**。

**非目标**

- 不做按工作区/会话的能力隔离（已移除，见 §10）；
- 不做密钥静态加密（已移除，见 §10）；
- 不实现 OAuth 流程；不管理 stdio server 的包安装（命令自行负责 `npx`/`uvx`）；
- 不修改其他插件/profile 配置。

## 2. 作用域与生命周期

| 维度 | 语义 |
|---|---|
| 安装 / 连接 / 凭据 | profile 级；Desktop 固定 `desktop` profile |
| 可见性 | 该 profile 内所有会话、所有工作区共享同一套 MCP |
| 挂载时机 | 插件 apply 时挂载启用的 server；manifest 变更后差分 mount/unmount |
| 数据生命周期 | manifest 常驻；卸载插件不删 manifest |
| 安装形态 | **必须是 profile bundle**：由安装脚本/`plugin_manager` 写入 profile `dependencies` 与 `dsh.profile.bundles`，这样才会出现在「插件 → 已安装插件」；仅手改 patch 层的旧方式不会出现在列表 |

## 3. 数据

### 3.1 manifest

默认 `$DSH_HOME/mcp-manager.json`（Config `manifestFile` 可覆盖），JSON v2，原子写、0600。

```json
{
  "version": 2,
  "servers": [
    {
      "serverName": "flomo",
      "transport": "streamable-http",
      "enabled": true,
      "toolCallTimeoutMs": 60000,
      "url": "https://flomoapp.com/mcp",
      "headers": { "Authorization": "credential:FLOMO_TOKEN" }
    },
    {
      "serverName": "fetch",
      "transport": "stdio",
      "enabled": true,
      "toolCallTimeoutMs": 60000,
      "command": "npx",
      "args": ["-y", "mcp-server-fetch"],
      "env": {},
      "cwd": ""
    }
  ]
}
```

- `serverName`：`[A-Za-z0-9_-]{1,32}`，决定工具前缀；
- `transport`：`stdio` | `streamable-http`；
- 新增默认 `enabled: true`、`toolCallTimeoutMs: 60000`；
- 旧版本遗留的 `workspaces`（server 字段）与 `externalScopes`（顶层）在加载时忽略并**一次性原子剥离**。

### 3.2 header/env 值解析

挂载/探测时按顺序解析：

1. `credential:NAME` → `ctx.credentials`（DSH 凭据库 `$DSH_HOME/.credentials.yaml`，0600）；
2. `env:NAME` → 宿主 `process.env`（含 `$DSH_HOME/.env` / 启动环境）；
3. 其它 → 原样作为明文使用。

失败码：`ENV_MISSING`、`CREDENTIAL_MISSING`、`CREDENTIAL_UNAVAILABLE`、`CREDENTIAL_RESOLVE_FAILED`；
失败只写该 server 的 `lastError`，不崩宿主。`state` 原样返回引用字符串，不展开解析后的值。

编辑语义（`mergeServerValues`）：同名 entry 空值 → 保留旧值；entry 从数组消失 → 删除；新 entry 空值 → `INVALID_INPUT`。

## 4. 运行时

### 4.1 挂载

`await ctx.plugin(McpClient, bridgeConfig(spec))`，`failOnStartupError: false`；`fiber.dispose()` 卸载。
`mounts.sync()` 做差量：新增/变更挂载、删除/停用卸载、失败记 `lastError`。

### 4.2 连通性测试

独立于已挂载 bridge：用 `@modelcontextprotocol/client`（与 bridge 同版本 v2）建 client →
`connect` → `listTools` → 记录协议版本/serverInfo/工具名/耗时 → 关闭。
超时与错误分类：`timeout` / `auth` / `transport` / `protocol` / `unknown`。
stdio 测试会真实启动命令，UI 必须警示。

### 4.3 粘贴导入

`server.import`：解析文本（`mcpServers` 包装 / 裸 map / 单个 server，允许代码围栏与前后说明）→
字段映射（`type`/`transport` 别名、`sse`→streamable-http + warning、无 type 按 command/url 推断、
`url`/`serverUrl`/`endpoint`、`headers`/`env`）→ 应用批量默认 `enabled` / `toolCallTimeoutMs`
（条目自带优先）→ 逐条校验 → 整批一次保存 + 一次 mount sync。

`server.importTest`：同一套解析与默认值，但不落盘、不挂载；对每个 server 用独立连接探测，
最多前 10 个，其余进 `skipped`；单条失败不影响其它条。

### 4.4 宿主原生 MCP 发现

数据源：`ctx.loader.entries()` 中 `options.name` 为 `@deepseek-ai/dsh-mcp-client`（含相对路径/别名兜底）
且 `options.config.serverName` 存在的 entry。

- `active = Boolean(entry.fiber?.uid)`；`disabled = Boolean(entry.options.disabled)`；
- `scope`：剥离 Loader 的 `include:` 组前缀后，仍含 `:` 的判为 `preset`，否则 `profile`；
- `source: 'host'`、`readOnly: true`、`entryId`；headers/env 非字符串值转文本并标 `expression: true`（不求值）；
- 同名先到先得；与 manager 项同名时 mount sync 跳过 manager 项并标 `conflict: 'host'`；
- Loader 不可用时降级为空列表 + 日志一次；`state` 每次 RPC 重新枚举。

### 4.5 模型工具

`mcp_manager_list` / `add` / `remove` / `reload` / `enable` / `tools` / `call` / `import`。
GUI 是主入口；工具保留给 Agent 自管理。`add/list` 不含 workspaces 参数；`import` 用于迁移旧
`@deepseek-ai/dsh-mcp-client` patch row。

## 5. RPC 契约

宿主注册 `webServer` 前缀路由 `/mcp-manager`，`connection.admit(req)` 准入（仅 owner），仅 POST，
body 上限 2MB；响应 `{ok:true,value}` / `{ok:false,error:{code,message}}`。

| endpoint | payload | value |
|---|---|---|
| `state` | — | `{ version, servers: ServerView[], status: Record<serverName, ServerStatus> }` |
| `status` | — | `{ status }` |
| `server.add` | ServerInput | `{ serverName }` |
| `server.update` | ServerInput（serverName 定位） | `{ serverName }` |
| `server.remove` | `{ serverName }` | `{ removed: true }` |
| `server.toggle` | `{ serverName, enabled }` | `{ enabled }` |
| `server.test` | ServerInput，或已保存项的 `{ serverName }` | `{ ok, latencyMs, protocolVersion?, serverInfo?, tools, error? }` |
| `server.import` | `{ json, replace?, enabled?, toolCallTimeoutMs? }` | `{ added: string[], skipped: [{serverName, reason}], warnings: string[] }` |
| `server.importTest` | `{ json, enabled?, toolCallTimeoutMs? }` | `{ results: [{serverName, ok, latencyMs, protocolVersion?, serverInfo?, tools, error?}], parseErrors: [{serverName?, message}], skipped: string[] }` |

类型：

```ts
ServerView = {
  serverName, transport, enabled, toolCallTimeoutMs,
  url?, headers?: [{name,value}]?, command?, args?: string[], env?: [{name,value}]?, cwd?,
  source: 'manager' | 'host',
  readOnly?, entryId?, active?, disabled?, scope?: 'profile' | 'preset', conflict?: 'host'
}
ServerStatus = { mounted: boolean, toolCount: number, lastError: string | null, conflict?: 'host' }
ServerInput = ServerView 去掉 source/readOnly/entryId/active/disabled/scope/conflict
```

错误码：`INVALID_INPUT`、`FORBIDDEN`、`UNKNOWN_ENDPOINT`、`UNKNOWN_SERVER`、`DUPLICATE_SERVER`、
`EXISTS_HOST_CONFIG`、`EXTERNAL_READONLY`、`ENV_MISSING`、`CREDENTIAL_MISSING`、
`CREDENTIAL_UNAVAILABLE`、`CREDENTIAL_RESOLVE_FAILED`、`MCP_MANAGER_ERROR`。

## 6. UI（`lib/client.js`）

- 面板：`sidebar.panellist`（id `mcp-manager`，order 6，label「MCP」，plug 图标）+ `main`（key `mcp-manager`）；
- 列表页：页头（标题 / 一行统计 / 工具条「刷新 · 添加 MCP」）+ 列表行（状态点、名称、transport、目标、工具数、
  manager 项启用开关；host 项「来自 DSH 配置」徽标，冲突项 warn 徽标）；
- 详情：配置、env/headers、连接测试、编辑、停用/启用、删除；host 项隐藏编辑/启停/删除并提示去 `cordis.patch.yml`；
- 「添加 MCP」弹窗：
  - add 模式顶部 tab「手动配置 / 代码粘贴」；edit 模式标题「编辑 <name>」且只有手动配置；
  - 手动：名称、transport（默认 streamable-http）、URL 或命令/参数/工作目录、请求头/环境变量（默认一行空白）；
  - 粘贴：一行说明 + 8 行等宽 textarea（缩进示例）+ 覆盖 checkbox；
  - 配置区与「连接测试」之间一条分割线；连接测试按钮 + 结果区（手动走 `server.test`，粘贴走 `server.importTest`）；
  - add 模式不提供启用/超时（默认 true / 60000）；edit 模式提供这两项（唯一入口）；
  - 底部按钮统一「取消」+「添加 MCP」（edit 为「保存修改」）；
- 等高机制：add 模式两个 tab 的配置面板同时渲染，`display:grid; grid-template-rows:1fr`，
  两个面板 `grid-area:1/1` 同格叠放；非激活面板 `visibility:hidden`（保留占位、不可聚焦），
  行高 = 两者自然高度最大值 → 切换 tab 高度零跳动、无内部滚动；
- 规范：间距走 `--dim-space-*`（4/8/12/16/24/32/48，字段间 `--dim-space-field:14px`，与 im 同名同值）；
  文字层级走 DSH 8 档字阶（`xl-24` 页头、`l-20` 详情标题、`m-18` 弹窗标题、`xs-strong-13` 行主文案、
  `xs-13` 控件、`xxs-12` 辅助与 meta、`xxxs-11` tag），字号与行高成对；圆角只用 `--dsw-radius-*`，
  `50%`/`999px` 配 `corner-shape:round`；列表为原生裸行（无外框无分隔线，-8px 出血 + `radius-xl` + 整行 hover）；
  阴影只用 `--dsw-elevation-*`；只用 `--dsw-alias-*` token，深浅色一致，并有 `prefers-reduced-motion` 降级。

## 7. 文件布局

```
dsh-mcp-manager/
  package.json          # 0.3.2，MIT，dsh.bundle / dsh.client
  cordis.patch.yml      # profile bundle 层（insert mcp-manager 行）
  lib/index.js          # Cordis 入口：Config/apply、模型工具、/mcp-manager RPC、生命周期
  lib/manifest.js       # manifest 校验/规范化/原子 0600、旧字段剥离、引用解析、toolCount 归属
  lib/mount.js          # bridge 差分挂载/卸载、lastError
  lib/probe.js          # 独立 MCP 客户端连通性测试
  lib/import.js         # 粘贴解析/映射/批量默认/批量测试
  lib/external.js       # 宿主原生 row 发现（只读、scope/conflict）
  lib/rpc.js            # RPC 端点校验/分发
  lib/patch-import.js   # 旧 patch row 迁移
  lib/client.js         # 浏览器半（原生页面）
  install/              # activate.sh（文件级安装/卸载）、verify-plugin.sh（隔离验证）
  test/unit/            # 纯逻辑单测（fake 依赖）
  test/client/          # 静态检查 + stub-React 渲染 smoke
  test/e2e/             # 隔离 DSH_HOME 的端到端脚本 + fixtures
```

## 8. 验证

1. **host 单测** `node --test 'test/unit/*.test.mjs'`：manifest 校验/旧字段剥离、引用解析、blank-keep、
   mount 差分、probe 分类、RPC 分发、external 发现/冲突、import/importTest。
2. **client** `bash test/client/run.sh`：`node --check`、注册/契约静态断言、stub-React 渲染分支。
3. **隔离 e2e** `bash test/e2e/run-all.sh`（临时 `DSH_HOME` + `--from-default-profile web`）：
   install 契约（28 断言：复制、bundle 注册、备份、幂等、旧 patch 迁移、`--remove`、真实 home 守卫）、
   启动/工具注册/dispose、RPC 导入、importTest、原生 row 发现、clean reinstall、references。
4. **启动验证** `bash install/verify-plugin.sh`：真实 CLI 下 bundle 注册进 profile、loader entry active、
   8 个模型工具、client 半被发现、dispose 干净；probe 通过 `pluginManager.listBundles()` 断言
   `installed:true / enabled:true / source`（即「已安装插件」页的数据源）。

## 9. 安全边界

- stdio server 以用户权限执行命令，等价本机执行；
- manifest 0600；`env:` / `credential:` 引用避免明文落盘；明文仍是明确允许的选择；
- 不自建加密：同用户进程（包括 agent）可读宿主可读内容，插件级加密不构成边界，且带来 provider/迁移成本；
- RPC 仅同源 owner，body 2MB；插件不写 profile 文件（安装脚本除外）。

## 10. 已移除的设计（历史）

- **2026-10-21：按 Workspace 划分可见性/调用**。曾用 `agent.ctx.tools.restrict` + `tools/pre-execute` 守卫
  按工作区收窄；后因 manager 工具/资源工具等多路径绕过、且维护成本高，整套移除。
  现在 MCP 对 profile 内所有会话生效。
- **2026-10-21：自建 key 加密**。曾用 `enc:v1:` + Electron safeStorage / macOS Keychain 主密钥；
  实测同用户进程可直接读出主密钥，对 agent 不构成边界，只防文件副本泄露，且引入 provider 失败与迁移不可逆，
  改为 `env:` / `credential:` 引用 + 0600 明文。

## 11. 已知限制

- `failOnStartupError: false`：初始连接失败的 server 显示 `mounted: true / toolCount: 0`（黄点）；
- 宿主发现依赖 Loader 当前条目；运行中新增宿主行会反映在 `state`，同名冲突在下次 mutation/重启时 reconcile；
- 不处理 OAuth；不管理 stdio server 的包安装；粘贴测试一次最多前 10 个。
