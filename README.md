# dsh-mcp-manager

DSH Desktop 的 **MCP 管理插件**：在左侧栏「MCP」页面里可视化增删改 MCP server、做连通性测试、
粘贴 `mcpServers` JSON 导入；header/env 支持 `env:` / `credential:` 引用。

- 连接挂在 **profile 级**（一个宿主进程一份，经 `@deepseek-ai/dsh-mcp-client` 动态挂载）；
- server 对 profile 内**所有会话/所有工作区生效**（按工作区划分作用范围的机制已于 2026-10-21 移除）；
- 不靠改 patch 文件加 server：manifest 独立持久化，改完即时挂载/卸载，不热重载插件树。

设计细节与契约见 [DESIGN.md](DESIGN.md)。

## 界面

「消息」旁边一个「MCP」入口（`sidebar.panellist` + `main`，原生 React，不嵌 iframe）。包含：

- 列表：状态点（已连接 / 已挂载未连接 / 错误 / 停用）、名称、transport、目标（URL 或命令）、工具数、启用开关；
- 详情：完整配置、env/headers、连通性测试（延迟 / 协议 / 工具列表）、编辑、停用、删除；
- 添加弹窗：唯一的「添加 MCP」入口，弹窗内切换「手动配置 / 代码粘贴」；配置区下方是「连接测试」（不落盘），
  新建默认启用、默认 60000ms 超时（超时/启用只在编辑弹窗里可改）。

仓库：<https://github.com/iswilliamleeya/dsh-mcp-manager>

## 安装

从 GitHub 获取后，两种等价方式：

1. **文件级**（已在本机验证 client 半可被发现，回滚简单）：

   ```bash
   bash install/activate.sh                 # 默认 desktop profile
   bash install/activate.sh --remove        # 回滚
   ```

   复制包到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-mcp-manager`，把本包的
   `cordis.patch.yml` insert row 追加到 profile patch 层（带时间戳备份、重复守卫）。

2. **profile bundle**：`plugin_manager` `install_bundle`，target 用本包的绝对路径。

> 两种方式都会让 patch watcher 重载组合，**可能中断正在运行的会话**；安装后重启 DSH，
> 新开一个会话验收。脚本默认拒绝写真实 `~/.dsh`，需显式 `DSH_MCP_MANAGER_ALLOW_REAL=1`。

**卸载与数据**：`--remove` 只删 patch 行（package 留着），MCP 配置不受影响；卸载/重装插件
**不会删除** `$DSH_HOME/mcp-manager.json`。只有显式删除这个文件才会丢配置——隔离实验已验证：
卸载（删 row/node_modules）后重装会自动恢复全部 server；连 manifest 一起删则列表归零。
「来自 DSH 配置」的自动发现只针对 DSH 原生 `@deepseek-ai/dsh-mcp-client` row，救不了被删的 manifest。

## 使用

1. 左侧栏点「MCP」→ 右上角「添加 MCP」；
2. 弹窗顶部切换「手动配置 / 代码粘贴」：
   - 手动配置：填 `serverName`（`[A-Za-z0-9_-]{1,32}`，决定工具前缀 `mcp__<name>__`）和 transport；
     - `streamable-http`：URL + 可选 headers（如 `Authorization: env:MCP_TOKEN`）；
     - `stdio`：命令 + 参数（如 `npx -y mcp-server-fetch`）——**等价于在本机执行该命令**；
   - 代码粘贴：粘贴常见 MCP 客户端的 `mcpServers` 配置：

     ```json
     { "mcpServers": { "flomo": { "type": "streamable-http", "url": "https://flomoapp.com/mcp", "headers": { "Authorization": "Bearer 粘贴你的Token" } } } }
     ```

     支持 `mcpServers` 包装 / 裸 map / 单个 server；`sse` 按 streamable-http 处理；
     直接粘贴的 Token 会明文落盘，想要更安全可写 `env:VAR` 并从宿主环境读取；
3. 配置区下方分割线后的「其他设置」：工具调用超时、启用开关、连接测试
   （手动模式测当前表单；粘贴模式按 server 逐条测，不落盘）；
4. 保存后，在新会话里使用 `mcp__<serverName>__<tool>`（已有会话按 `tools/change` 下一次 step 生效）。

## 宿主已有的 MCP（自动发现）

插件加载时会遍历宿主已经配置的 DSH 原生 MCP（`@deepseek-ai/dsh-mcp-client` loader row），
把它们一起列在面板里，徽标「来自 DSH 配置」：

- 状态、工具数、连通性测试与 manager 自己管理的 server 一致；
- 配置**只读**：修改/删除请到 DSH 的 `cordis.patch.yml`（桌面 profile 是
  `~/.dsh/profiles/desktop/cordis.patch.yml`，home 级是 `~/.dsh/cordis.patch.yml`）；
- 完全只读，不能编辑/启停/删除，也不参与作用域配置；
- 与 manager 自己添加的 server 同名时不会重复挂载，列表会标记冲突。

## Manifest

默认 `$DSH_HOME/mcp-manager.json`（0600，原子写；插件配置 `manifestFile` 可覆盖）。

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

- `env:NAME` 在挂载/测试时从宿主环境解析；失败只记 `lastError`，不会崩宿主。
- 值可以写 `env:NAME`（宿主环境）或 `credential:NAME`（DSH 凭据库）；直接写明文会存进 manifest（0600）。
- 旧版本 manifest 里可能残留的 `workspaces` / `externalScopes` 会在启动时被忽略并一次性重写剥离（按用户决定不保留）。

## 模型工具（Agent 自管理入口）

`mcp_manager_list` / `add` / `remove` / `reload` / `enable` / `tools` / `call` / `import`。
GUI 是主入口；这些工具保留给 Agent 自动化。

## 架构

```
lib/index.js        Cordis 入口：Config/apply，工具注册，/mcp-manager RPC，生命周期
lib/manifest.js     manifest v2 校验/规范化/0600 原子写/旧字段剥离/toolCount 归属
lib/mount.js        bridge 差分挂载/卸载，lastError
lib/import.js       粘贴 mcpServers JSON 解析/映射
lib/external.js     宿主原生 dsh-mcp-client row 发现（只读）
lib/probe.js        独立 MCP 客户端连通性测试（不改动已挂载连接）
lib/rpc.js          RPC 端点分发
lib/client.js       浏览器半：原生「MCP」页面
cordis.patch.yml    profile bundle 层（insert mcp-manager 行）
install/            文件级安装/卸载 + 隔离 profile 验证脚本
test/               unit / client / e2e
```

## 测试

```bash
node --test 'test/unit/*.test.mjs'      # 111 pass
bash test/client/run.sh                  # 18 static + 23 render smoke
bash test/e2e/run-all.sh                 # 8 组隔离 profile e2e（含安装/启动/导入/发现/清理/引用）
bash install/verify-plugin.sh            # 隔离 DSH_HOME + web 模板启动验证
```

## 安全

- `stdio` server 会以你的权限执行你填写的命令——只添加你信任的 server。
- **header/env 密钥**：优先用 `env:NAME`（宿主环境 / `$DSH_HOME/.env`）或 `credential:NAME`（DSH 凭据库）引用，manifest 里不落明文；直接写明文也可以，但会存进 `mcp-manager.json`（0600）。
- 不再有自建加密：同用户进程（包括 agent 自己的 shell）本来就能读到宿主可读的一切，静态加密只防「配置文件被单独拷走」，代价是 provider 依赖/迁移不可逆；设备丢失请用 FileVault。
- manifest 0600；RPC 只接受同源 owner peer，body 上限 2MB。
- 插件不写 profile 文件（安装脚本除外），删除 server 只动自己的 manifest。

## 已知限制

- 隔离环境无法验证真实第三方 MCP server 的 `server.test` 与成功挂载后的工具计数（需真机首测）。
- `failOnStartupError: false`：初始连接失败的 server 表现为 `mounted=true / toolCount=0`，UI 显示黄点。
- 不处理 OAuth 流程（HTTP server 目前用 header/`env:` 承载凭据）。
