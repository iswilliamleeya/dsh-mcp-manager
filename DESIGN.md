# dsh-mcp-manager v0.2 — MCP 管理插件设计（GUI + 密钥加密）

> 状态：已实施。日期：2026-10-19（2026-10-21 移除工作区作用域）。
> 相关结论见 `../decisions/decisions-log.md`。

## 1. 目标

在 DSH Desktop 里像「消息」插件一样管理 MCP：

- 左侧栏一个「MCP」面板（`sidebar.panellist` + `main`），原生 React 页面，风格对齐「插件」页；
- 可视化增 / 删 / 改 MCP server（stdio 与 streamable-http），启停；
- 每个 server 一条「连通性测试」：握手 + `tools/list` + 延迟 + 错误分类；
- **连接挂在 profile 级**（一个宿主进程一份，经 `@deepseek-ai/dsh-mcp-client` 动态挂载）；
- server 对 profile 内**所有会话生效**（按工作区划分作用范围的机制已于 2026-10-21 整个移除）；
- header/env 支持 `env:` / `credential:` 引用；支持粘贴 `mcpServers` JSON 导入；只读展示宿主原生 MCP。

## 2. 作用域模型

MCP 的安装、连接、可见性均为 **profile 级**：Desktop 固定 `desktop` profile，即整个桌面实例的所有会话、所有工作区共享同一套 MCP。

> 2026-10-21：按 Workspace 收窄可见性/调用的整套机制（`visibility` restrict + 调用时守卫）已按用户要求移除，不再维护。

## 3. 数据

### manifest（默认 `$DSH_HOME/mcp-manager.json`，0600，原子写）

```json
{
  "version": 2,
  "servers": [
    {
      "serverName": "github",
      "transport": "stdio",
      "enabled": true,
      "toolCallTimeoutMs": 60000,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "env:GITHUB_TOKEN" },
      "cwd": ""
    },
    {
      "serverName": "unifuncs",
      "transport": "streamable-http",
      "enabled": true,
      "toolCallTimeoutMs": 900000,
      "url": "https://mcp.unifuncs.com/mcp",
      "headers": { "Authorization": "env:MCP_UNIFUNCS_API_KEY" }
    }
  ]
}
```

- 值里出现 `env:NAME` 时在 mount / probe 时从宿主环境解析；解析失败 → 该 server 挂载失败并记录 `lastError`，不崩宿主。
- 读 v1 manifest 兼容；旧版本可能残留的 `workspaces` / `externalScopes` 字段在加载时被忽略并**一次性原子重写剥离**（按用户决定，不保留）。

### 3.1 密钥存储（引用式 + 明文）

header/env 的值支持三种形态：

1. `credential:NAME` —— 走 `ctx.credentials.resolve`，密钥存在 DSH 凭据库（`$DSH_HOME/.credentials.yaml`，0600）；
2. `env:NAME` —— 从宿主 `process.env` 读取（`$DSH_HOME/.env` / 启动环境，0600）；
3. 其它 —— 明文，直接存在 manifest（0600）。

- 解析在 mount / probe / 测试时进行；解析失败写 `lastError`（`ENV_MISSING` / `CREDENTIAL_MISSING` / `CREDENTIAL_UNAVAILABLE`），不崩宿主。
- manifest 与 `state` 中，引用字符串原样保存/返回，明文按加密前行为直接展示（GUI 可编辑）。
- 不再有自建加密（`enc:v1`、keychain/electron provider、掩码、迁移、`secrets.encryptExisting`）。理由：同用户进程（含 agent）可直接读取解密密钥，静态加密只防「文件副本泄露」且带来 provider 失败/迁移不可逆等成本；平台自身（DSH credential store、`.env`）也是 0600 明文。

## 4. 运行时

### 4.1 挂载

沿用旧实现：`await ctx.plugin(McpClient, bridgeConfig(spec))`，`failOnStartupError: false`；卸载 `fiber.dispose()`。
启用的 server 在插件 apply 时自动挂载（`autoMount`），manifest 变更后就地 mount/unmount。

### 4.2 可见性（已移除）

> 2026-10-21：按 Workspace 收窄 MCP 可见性/调用的机制（`lib/visibility.js` 的 agent-scope `tools.restrict`
> 与 `lib/guard.js` 的 `tools/pre-execute` 调用时守卫）已整个删除。所有 MCP server 对 profile 内全部会话生效。

### 4.3 连通性测试

独立于已挂载 bridge：用 `@modelcontextprotocol/client`（与 bridge 同版本 v2）直接建 client（stdio 或 streamable-http），
`connect` → `listTools` → 记录协议版本、serverInfo、工具名、耗时，关闭连接。
超时（默认 60s，可传 `timeoutMs`）/ 错误分类：`timeout` / `auth`（401/403）/ `transport` / `protocol` / `unknown`。
stdio 测试会真实启动命令——UI 必须提示「等价于本机执行命令」。

### 4.4 模型侧工具

保留旧 `mcp_manager_*` 工具（list/add/remove/reload/enable/tools/call/import）。GUI 是主入口，工具保留给 Agent 自管理。

### 4.5 外部（宿主配置）MCP 发现

插件加载时遍历宿主已有的 DSH 原生 MCP 配置，并在面板中展示（只读）：

- 数据源：`ctx.loader.entries()` 中 `options.name` 为 `@deepseek-ai/dsh-mcp-client`（或包含该包名）
  且 `options.config.serverName` 存在的 entry；`entry.fiber?.uid` 判断是否 active；
  `options.disabled` 判断是否停用；id 含 `:` 的嵌套 entry 标 `scope: 'preset'`，否则 `'profile'`。
- `state.servers` 合并两类：manager 项 `source:'manager'`；外部项 `source:'host'`、`readOnly:true`、
  `entryId`、`active`、`scope`。
- 外部项完全只读：`server.update`/`remove`/`toggle` → `EXTERNAL_READONLY`；同名 `add` → `EXISTS_HOST_CONFIG`。
  改配置/删除请去 DSH 的 `cordis.patch.yml`。
- manager manifest 与外部同名时，mount sync 跳过并标 `conflict:'host'`（bridge 同 serverName 重复挂载会失败）。
- `loader` 服务不可用时降级为空外部列表并日志一次；`state` RPC 每次重新枚举（GUI 5s 轮询）。

## 5. RPC 契约

宿主注册 `webServer` 前缀路由 `/mcp-manager`，经 `connection.admit(req)` 准入（复制 `dsh-im-manager/src/host/manager-rpc.js` 的模式）。
客户端 `connection.rpc.call('/mcp-manager', endpoint, payload)`。
响应统一 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。

| endpoint | payload | value |
|---|---|---|
| `state` | — | `{ version, servers: (ServerView & { source: 'manager' \| 'host' })[], status: Record<serverName, ServerStatus> }`；外部项另带 `readOnly/entryId/active/scope`，冲突 manager 项带 `conflict:'host'` |
| `server.add` | ServerInput | `{ serverName }` |
| `server.update` | ServerInput（serverName 定位） | `{ serverName }` |
| `server.remove` | `{ serverName }` | `{ removed: true }` |
| `server.toggle` | `{ serverName, enabled }` | `{ enabled }` |
| `server.test` | ServerInput（可不落盘） | `{ ok, latencyMs, protocolVersion?, serverInfo?, tools: [{name, description?}], error?: { code, message } }` |
| `server.import` | `{ json: string, replace?: boolean, toolCallTimeoutMs?: number, enabled?: boolean }` | `{ added: string[], skipped: [{ serverName, reason }], warnings: string[] }` |
| `server.importTest` | `{ json: string, toolCallTimeoutMs?: number, enabled?: boolean }` | `{ results: [{ serverName, ok, latencyMs, protocolVersion?, serverInfo?, tools, error? }], parseErrors: [{ serverName?, message }], skipped: string[] }`（最多测前 10 个） |
| `status` | — | `{ status }` |

### 5.1 粘贴导入（mcpServers 兼容）

`server.import` 接受常见 MCP 客户端（Claude Desktop / Cursor / VS Code）的粘贴格式：

```json
{ "mcpServers": { "flomo": { "type": "streamable-http", "url": "https://flomoapp.com/mcp", "headers": { "Authorization": "Bearer 粘贴你的Token" } } } }
```

- 接受 `mcpServers` 包装、裸 `{ name: {...} }` map、单个 server 对象；
- 允许前后有说明文字或 ```` ```json ```` 代码围栏（提取第一个平衡的 `{...}`）；
- `type`/`transport`：`streamable-http` / `http` / `streamableHttp` → streamable-http，`stdio` → stdio，`sse` → streamable-http 并给 warning；
- 无 type 时按 `command`（stdio）或 `url`（streamable-http）推断；兼容 `url` / `serverUrl` / `endpoint`、`args`、`env`、`cwd`；
- 逐条校验并新增；已存在且 `replace !== true` 记 `skipped(reason=EXISTS)`；单条失败不影响其它条；
- 明文 Token 允许（生态惯例），UI 显著提示「可直接用 `env:VAR` 代替」；
- 额外可选字段 `toolCallTimeoutMs?: number` 与 `enabled?: boolean`：作为整批**默认值**，条目自带时以条目为准。

类型：

```ts
ServerView = { serverName, transport, enabled, toolCallTimeoutMs, url?, headers?: [{name,value}]?,
               command?, args?: string[], env?: [{name,value}]?, cwd? }
ServerStatus = { mounted: boolean, toolCount: number, lastError: string | null }
ServerInput = 去掉派生字段的 ServerView（headers/env 接受对象或 entry 数组）
```

## 6. UI（lib/client.js）

- 面板 id `mcp-manager`；`sidebar.panellist` order 6，label「MCP」；`main` key `mcp-manager`。
- 页面结构（对齐「消息」页 `dim-page`）：
  - 页头：标题「MCP」+ 说明 + 工具条（刷新、添加 MCP）；
  - 面板图标：插头（plug）SVG，侧栏入口/列表行/详情卡共用；
  - 列表：状态点（已连接绿 / 已挂载未连接黄 / 错误红 / 停用灰）、名称、transport 徽标、目标（url 或命令）、工具数；外部项带「来自 DSH 配置」徽标，冲突项带 warn 徽标；
  - 详情：只读字段 + 操作（测试连接、编辑、停用/启用、删除）；外部项隐藏编辑/启停/删除，改为「请到 cordis.patch.yml 修改」提示；
  - 「添加 MCP」弹窗：顶部 tab 切换「手动配置 / 代码粘贴」；编辑已有 server 时标题「编辑 <name>」且只有手动配置；
    - 手动配置：serverName、transport 选择、url 或 command/args/cwd、headers/env 键值编辑器；
    - 代码粘贴：`mcpServers` JSON + 覆盖开关（见 §5.1）；
    - 配置区与「其他设置」之间一条分割线；其他设置 = 工具调用超时、启用开关、连接测试（手动走 `server.test`，粘贴走 `server.importTest`，结果按 server 展示，不落盘）；
  - 测试结果区：成功（延迟、协议、工具数、工具名可展开）/ 失败（错误分类与消息）。
- 轮询 `state`（约 5s，弹窗打开时暂停）；刷新按钮即时拉取。
- 纯手写 `lib/client.js`（`window.__ModuleLoader__.load` + `h()`，无 JSX、无外部依赖）；复用 `@deepseek-ai/dsh-client-ui-primitives` 与 `--dsw-alias-*` token；深色模式必须正常。

## 7. 文件布局与职责

```
dsh-mcp-manager/
  package.json            # Lead
  cordis.patch.yml        # Lead（bundle 层，insert mcp-manager 行）
  DESIGN.md               # Lead
  lib/index.js            # host 插件入口（扩展旧实现）      host-core
  lib/manifest.js         # manifest v2 读写/规范化          host-core
  lib/mount.js            # bridge 挂载/卸载/状态            host-core
  lib/probe.js            # 连通性测试                       host-core
  lib/rpc.js              # /mcp-manager RPC 分发            host-core
  lib/client.js           # 客户端页面                       client-ui
  test/unit/**            # 单测                             host-core
  test/client/**          # client 语法/静态检查             client-ui
  test/e2e/**             # 隔离 profile 验证                verify
  install/**              # 真机安装/回滚 + 隔离验证脚本      verify
```

## 8. 验证

1. 单测（`node --test`）：manifest 规范化/旧字段剥离、密钥 codec、前缀归属/toolCount、probe 错误分类、RPC 分发（fake manager）。
2. 隔离 profile（真实 CLI + web 模板）：启动本插件，断言 apply 成功、RPC 端点形状、旧 manifest 字段被剥离、密钥不可用路径不落明文、无 dispose 报错。
3. e2e：安装/卸载契约、粘贴导入、原生 row 发现、clean reinstall、密钥加密、启动验证。
4. 真机：`plugin_manager install_bundle`（绝对包路径）→ 重启 Desktop → 添加一个测试 server（如 `npx -y mcp-server-fetch` 或 unifuncs）→ 测试连接 → 新会话验证工具可见。

## 9. 安全

- manifest 0600；密钥优先 `env:NAME`，UI 注明「直接填写会明文落盘」。
- stdio = 执行用户命名的命令，UI 必须警示。
- RPC 仅同源 + `connection.admit`；不做跨 profile 写。
- 不写 profile 文件、不动 `~/.dsh/profiles/**`（安装由用户批准后单独执行）。
