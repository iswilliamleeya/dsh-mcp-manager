# dsh-mcp-manager

DeepSeek Harness（DSH）Desktop 的原生 **MCP 管理插件**：在左侧栏「MCP」面板里可视化管理 MCP server，
不用再手写 profile patch。

- **profile 级**：一个宿主进程一份连接，`desktop` profile 内所有会话共享同一套 MCP；
- **独立注册表**：manifest 落在 `$DSH_HOME/mcp-manager.json`，增删改即时挂载/卸载，不改 patch、不热重载插件树；
- **原生 GUI**：原生 React 页面（非 iframe），复用 DSH 的侧栏/弹窗/主题 token；
- **密钥两种存法**：`env:NAME` / `credential:NAME` 引用（推荐），或 0600 manifest 明文；
- 当前版本 **0.3.2**，目标运行时 DSH **0.2.1-rc.2**、Node **>=22**。

## 功能

- **列表**：状态点（已连接 / 已挂载未连接 / 错误 / 停用）、名称、transport、目标（URL 或命令）、工具数、启用开关；
- **添加 MCP**：唯一入口，弹窗内切换「手动配置 / 代码粘贴」；配置区下方是「连接测试」（不落盘）；
  新建默认启用、默认 60000ms 超时；
- **编辑**：修改配置；「工具调用超时」「启用该 server」只在编辑弹窗里可改；
- **连通性测试**：握手 + `tools/list` + 延迟 + 错误分类（timeout / auth / transport / protocol / unknown）；
- **粘贴导入**：兼容 Claude Desktop / Cursor / VS Code 的 `mcpServers` JSON，支持整批导入与逐条测试；
- **宿主已有 MCP 发现**：只读展示 DSH 原生 `@deepseek-ai/dsh-mcp-client` row（`source:'host'`），同名冲突可见；
- **Agent 自管理工具**：8 个 `mcp_manager_*` 工具（见下）。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | Desktop 0.2.1-rc.2，profile 名为 `desktop` |
| Node | >= 22（DSH 宿主内置运行时） |
| 平台 | host 插件本身无平台依赖；`install/verify-plugin.sh` 默认使用 macOS App 内 CLI，其他平台用 `DSH_CLI` 覆盖 |

## 安装

### 方式一：安装脚本（推荐，回滚简单）

```bash
git clone git@github.com:iswilliamleeya/dsh-mcp-manager.git
cd dsh-mcp-manager

# 安装：复制包 + 注册为 profile bundle（默认 desktop profile）
DSH_MCP_MANAGER_ALLOW_REAL=1 bash install/activate.sh

# 卸载：移除 bundle 注册/依赖与遗留 patch 行（MCP 配置保留）
DSH_MCP_MANAGER_ALLOW_REAL=1 bash install/activate.sh --remove
```

脚本做的事：

1. 复制包到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-mcp-manager`；
2. 备份 profile `package.json` 与 `cordis.patch.yml`（时间戳）；
3. 在 `package.json` 写入依赖 `"dsh-mcp-manager": "github:iswilliamleeya/dsh-mcp-manager"`，
   并把 `dsh-mcp-manager` 追加到 `dsh.profile.bundles`；
   **因此安装后它会出现在「插件 → 已安装插件」列表**；
4. 兼容旧安装：删除遗留的手工 `mcp-manager` patch 行；
5. `--remove` 反向清理 bundles/dependency/遗留 patch 行，保留包目录与 MCP manifest。

### 方式二：plugin_manager

用 `plugin_manager` 的 `install_bundle`（target 填本包路径或安装 spec），效果相同：作为正式 bundle 注册。

> 安装/卸载都会让 profile 组合重载，**可能中断正在运行的会话**；安装后刷新页面，必要的话重启 DSH。
> 插件出现在「插件 → 已安装插件」的前提是它被注册进 `dsh.profile.bundles`——安装脚本和
> `plugin_manager` 都会自动完成；手动改 patch 层（旧方式）不会出现在该列表。

### 数据与卸载

- 卸载/重装插件**不会删除** `$DSH_HOME/mcp-manager.json`；
- 只有显式删除该文件才会丢 MCP 配置（隔离实验已验证：卸载插件保留 manifest 重装后 server 自动恢复）；
- 旧版本遗留的 `workspaces` / `externalScopes` 字段会在启动时被忽略并一次性原子剥离。

## 使用

### 添加 MCP

1. 左侧栏「MCP」→ 右上角「添加 MCP」；
2. 弹窗顶部切换模式：

**手动配置**

- 服务器名称（`[A-Za-z0-9_-]{1,32}`，会成为工具前缀 `mcp__<name>__`）；
- 传输方式默认 `streamable-http`，可切 `stdio`；
  - `streamable-http`：URL + 可选请求头；
  - `stdio`：命令、参数（每行一个）、工作目录、环境变量；stdio 会真实执行命令，只添加可信来源；
- 请求头/环境变量默认给一行空白，可增删；值支持 `env:NAME` / `credential:NAME` 引用；
- 配置区下方「连接测试」：测试当前表单，不保存；
- 新建默认 `enabled: true`、`toolCallTimeoutMs: 60000`（不在添加弹窗里配置，编辑时可改）。

**代码粘贴**

```json
{
  "mcpServers": {
    "flomo": {
      "type": "streamable-http",
      "url": "https://flomoapp.com/mcp",
      "headers": {
        "Authorization": "Bearer 粘贴你的Token"
      }
    }
  }
}
```

- 支持 `mcpServers` 包装 / 裸 map / 单个 server；`type` 缺省时按 `command`（stdio）或 `url`（streamable-http）推断；
- `http`、`sse` 按 streamable-http 处理；
- 同名默认跳过（`EXISTS`），勾选「覆盖已存在的 server」可覆盖；
- 「连接测试」对粘贴内容逐条探测（最多前 10 个，其余提示未测试），不落盘；
- 粘贴里的明文 Token 会写入 manifest（0600）；建议在 JSON 里写 `env:NAME` / `credential:NAME`。

### 编辑 / 停用 / 删除

- 详情页：完整配置、env/headers、测试连接、编辑、停用/启用、删除（删除立即卸载）；
- 编辑弹窗：改配置，并且是「工具调用超时」「启用该 server」的唯一入口；
- 已有 header/env 行**留空保存 = 保持原值**，删除该行 = 删除该 entry。

### 密钥与引用

manifest 里 header/env 的值支持三种形态：

| 形式 | 解析 |
|---|---|
| `credential:NAME` | 通过 `ctx.credentials` 从 DSH 凭据库（`$DSH_HOME/.credentials.yaml`，0600）读取 |
| `env:NAME` | 从宿主 `process.env` 读取（`$DSH_HOME/.env` / 启动环境） |
| 其它 | 明文，直接存储在 manifest（0600） |

- 引用在挂载/测试时解析；`state` 里原样返回引用字符串，不展开；
- 解析失败写 `lastError`（`ENV_MISSING` / `CREDENTIAL_*`），不会崩宿主；
- **本插件不做自建加密**：同用户进程（包括 agent 的 shell）能读宿主可读的一切，静态加密只防「配置文件被单独拷走」，
  代价是 provider 依赖/迁移不可逆。需要更强隔离请用独立的 OS 账户/沙箱；设备丢失请用 FileVault。

### 宿主已有的 MCP

插件加载时会遍历宿主已配置的 DSH 原生 MCP（`@deepseek-ai/dsh-mcp-client` loader row），
以「来自 DSH 配置」徽标只读展示：

- 状态、工具数、连通性测试与 manager 自己管理的 server 一致；
- 配置**完全只读**：编辑/启停/删除请去 DSH 的 `cordis.patch.yml`；
- 与 manager 添加的同名 server 冲突时不会重复挂载，列表标记「与宿主配置重名」。

## 数据（manifest）

默认路径 `$DSH_HOME/mcp-manager.json`（插件配置 `manifestFile` 可覆盖），原子写、权限 0600：

```json
{
  "version": 2,
  "servers": [
    {
      "serverName": "fetch",
      "transport": "stdio",
      "enabled": true,
      "toolCallTimeoutMs": 60000,
      "command": "npx",
      "args": ["-y", "mcp-server-fetch"],
      "env": {},
      "cwd": ""
    },
    {
      "serverName": "flomo",
      "transport": "streamable-http",
      "enabled": true,
      "toolCallTimeoutMs": 60000,
      "url": "https://flomoapp.com/mcp",
      "headers": {
        "Authorization": "credential:FLOMO_TOKEN"
      }
    }
  ]
}
```

> 引用是**整值替换**：`credential:FLOMO_TOKEN` 对应的凭据值需要包含完整 header 值（例如 `Bearer xxx`），`env:` 同理。

## RPC（GUI 与宿主）

同源 `POST /mcp-manager/<endpoint>`，经 `connection.admit` 准入（仅 owner），body 上限 2MB；
响应 `{ok:true,value}` / `{ok:false,error:{code,message}}`。完整契约见 [DESIGN.md](DESIGN.md)。

| endpoint | 说明 |
|---|---|
| `state` | `{version, servers, status}`（含宿主发现项与冲突标记） |
| `status` | 仅状态映射，供轮询轻量刷新 |
| `server.add` / `server.update` / `server.remove` / `server.toggle` | 增删改与启停 |
| `server.test` | 测当前表单或已保存配置（只传 `serverName`） |
| `server.import` | 粘贴导入，`{json, replace?, enabled?, toolCallTimeoutMs?}` |
| `server.importTest` | 批量探测粘贴内容，不落盘，最多 10 个 |

## 模型工具

| 工具 | 用途 |
|---|---|
| `mcp_manager_list` | 列出 registry + 状态 |
| `mcp_manager_add` | 新增并立即挂载 |
| `mcp_manager_remove` | 卸载并删除 |
| `mcp_manager_reload` | 就地重建连接（HTTP session 过期时） |
| `mcp_manager_enable` | 启停 |
| `mcp_manager_tools` | 用管理器的独立连接列出某 server 的工具 |
| `mcp_manager_call` | 调用任意 server 的任意工具 |
| `mcp_manager_import` | 从 `@deepseek-ai/dsh-mcp-client` patch row 迁移 |

## 架构

```
lib/index.js        Cordis 入口：Config/apply、工具注册、/mcp-manager RPC、生命周期
lib/manifest.js     manifest 校验/规范化/0600 原子写、旧字段剥离、引用解析、toolCount 归属
lib/mount.js        bridge 差分挂载/卸载、lastError
lib/import.js       粘贴 mcpServers 解析/映射/默认值/批量测试
lib/external.js     宿主原生 dsh-mcp-client row 发现（只读）
lib/probe.js        独立 MCP 客户端连通性测试
lib/rpc.js          RPC 端点校验与分发
lib/patch-import.js 旧 patch row 导入
lib/client.js       浏览器半：原生「MCP」页面
cordis.patch.yml    profile bundle 层（insert mcp-manager 行）
install/            文件级安装/卸载 + 隔离 profile 验证
test/               unit / client / e2e
```

## 测试

```bash
node --test 'test/unit/*.test.mjs'   # 111 pass
bash test/client/run.sh               # 18 static + 23 render smoke
bash test/e2e/import-test-smoke.sh    # 单步示例（需要 DSH CLI）
bash test/e2e/run-all.sh              # 全部隔离 e2e（8 步）
bash install/verify-plugin.sh         # 隔离 DSH_HOME + web 模板启动验证
```

隔离 e2e 全部使用临时 `DSH_HOME`，不碰真实 Desktop profile / `~/.dsh`；`KEEP=1` 可保留证据目录。

## 安全

- `stdio` server 会以你的权限执行你填写的命令——只添加你信任的可执行文件与参数；
- manifest 0600；优先 `env:` / `credential:` 引用，避免明文落盘；
- RPC 仅同源 owner peer，body 上限 2MB；
- 设备级加密请使用 FileVault（本插件不做密钥加密）。

## 已知限制

- `failOnStartupError: false`：初始连接失败的 server 表现为 `mounted: true / toolCount: 0`，UI 显示黄点；
- 不处理 OAuth 流程（远程 MCP 目前用 header / `env:` 承载凭据）；
- 宿主发现依赖 Loader 当前条目；运行中新增宿主行会反映到 `state`，同名冲突在下次 mutation/重启时 reconcile；
- 粘贴测试会真实连接/启动命令；一次最多测试前 10 个。

## 变更记录

- **0.3.2**：UI 对齐 DSH 设计系统——字号收敛到 8 档字阶、圆角全部 token 化、间距统一 `--dim-space-*`、列表改为原生裸行、补齐 `prefers-reduced-motion` 与弹窗焦点管理/`aria-*`。
- **0.3.1**：安装脚本改为正式 profile bundle 注册，安装后出现在「插件 → 已安装插件」列表。
- **0.3.0**：单一「添加 MCP」弹窗（手动/粘贴 tab + 连接测试）、请求头默认一行、两个 tab 自动等高；
  移除按工作区划分作用域；移除自建 key 加密，改为 `env:` / `credential:` 引用 + 0600 明文。

## License

[MIT](LICENSE)
