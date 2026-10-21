# test/e2e — 隔离 profile 端到端验证

这里的所有脚本都**不碰真实 Desktop profile / `~/.dsh`**：每个脚本自己 `mktemp` 一个
`DSH_HOME`，用 `--from-default-profile web --dump-config` 物化临时 profile，用完删除
（`KEEP=1` 可保留）。

## 入口

```bash
bash test/e2e/run-all.sh          # 全部步骤
KEEP=1 bash test/e2e/run-all.sh   # 保留临时目录，便于看 boot.log / JSON 报告
SKIP_UNIT=1 bash test/e2e/run-all.sh
```

单步：

| 脚本 | 断言 |
|---|---|
| `install-scripts.sh` | `install/activate.sh`：复制包、追加唯一 row、重复安装幂等、`--remove` 删除 row/备份/恢复 `[]` 占位、二次 remove no-op、拒绝写真实 `~/.dsh` |
| `../install/verify-plugin.sh` | 真实 CLI 隔离启动本插件：loader entry 存在且 active、注册 8 个 `mcp_manager_*` 工具、`fiber.dispose()` 无异常且注销工具、**client 半可被发现**（`ctx.clientModules.graph()` 含 `dsh-mcp-manager` row + 服务端 index 的 `__DSH_BOOT__` 含 `dsh-mcp-manager/client.js`）、日志无 loader/module/TypeError 错误 |
| `clean-reinstall-smoke.sh` | 卸载/删数据/重装 A/B/C/D 实验（并从带 workspaces/externalScopes 的**旧 manifest** 启动：state 不暴露这些字段、manifest 被剥离、server 仍正常挂载）：A 装插件+`server.add` 两条（echo-on 启用、echo-off 停用）→ state 2 条；B 卸载插件保留 `$DSH_HOME/mcp-manager.json` 重装 → 新进程 state 仍 2 条且 echo-on 重新挂载（manifest 是宿主级注册表）；C 连 manifest 一起删再装 → state 0 条；D 插一条原生 `@deepseek-ai/dsh-mcp-client` row → state 出现 `source:'host'` 1 条（发现只认宿主原生配置） |
| `native-discovery-smoke.sh` | 隔离 web profile 同时挂一条原生 `@deepseek-ai/dsh-mcp-client` row（`native-echo` → `test/e2e/fixtures/live-echo-server.mjs`）和本插件：state 发现 `source:'host'`/readOnly/entryId/active/scope/toolCount；外部项不可编辑（`server.update`/remove/toggle → `EXTERNAL_READONLY`，add 同名 → `EXISTS_HOST_CONFIG`）；第二次启动预置同名 manager 项验证 `conflict:'host'` 且不重复挂载 |
| `references-smoke.sh` | 移除自建加密后的 `env:`/`credential:` 引用契约：预置 5 个 server（env 引用/credential 引用/明文/缺失 env/缺失 credential）；state 返回引用字符串与明文原值、无 `secret` 掩码、无 `encryption` 字段、不泄露解析后的值；引用 server 挂载成功（mount 时解析），缺失引用 unmounted + lastError 分类；`server.test` 对引用成功/缺失分类；明文 header add 成功且 state 可见；manifest 无 `enc:v1:`、`secrets.encryptExisting` → UNKNOWN_ENDPOINT |
| `import-test-smoke.sh` | 隔离 web profile 真 HTTP：`server.importTest` 坏 JSON（INVALID_INPUT/parseErrors）、本地 live-echo + 不可达端点混合（分条 ok/latencyMs/tools[echo]/error，互不影响）、12 条只测前 10 条其余进 `skipped`、不落盘；`server.import` 的 `enabled` 默认（payload false → 落盘 false 未挂载、条目自带 enabled 优先、payload true 生效、非布尔 → INVALID_INPUT）；两个接口响应均不含明文 secret |
| `rpc-import-smoke.sh` | 隔离 web profile 真 HTTP RPC：token→cookie，`POST /mcp-manager/server.import`（flomo 样本）断言 `{added:[flomo],skipped:[],warnings:[]}`、manifest 保留 `headers.Authorization`/transport/0600、重复导入 `reason=EXISTS`、enabled 且不可达 server 导入仍 ok 且宿主存活、GET→405、未认证→401 |

## verify-probe

`verify-probe/` 是给 `install/verify-plugin.sh` 用的 liveness 探针（包名
`dsh-mcp-verify-probe`），作为 profile patch 的最后一行挂载。它通过
`ctx.loader.entries()` 定位 `mcp-manager` entry，读取全局工具表，然后
`entry.fiber.dispose()`，最后输出一行：

```
MCP_MANAGER_VERIFY { json }
```

因此验证**不依赖插件自身的日志措辞**，host 实现改日志不会让验证失效。

它同时做 client 半发现断言：`ctx.clientModules.graph()` 的 entries 里必须有
`{ id: 'dsh-mcp-manager', url: 'plugins/??dsh-mcp-manager/client.js&rev=…',
inject: ['@deepseek-ai/dsh-client-connection'] }`，且 `ctx.clientModules.clientPath()`
解析到 `.../node_modules/dsh-mcp-manager/lib/client.js`。`verify-plugin.sh` 还会用启动日志里的
token URL `curl` 服务端 index，断言注入的 `__DSH_BOOT__` 含 `dsh-mcp-manager/client.js`。
结论：**复制包进 `profile/node_modules` + 追加 loader row 已足够让 GUI 发现 client 半**，
不需要在 profile `package.json` 的 `dsh.profile.bundles` 里追加选择（client-modules 扫描
已启用的 loader entry，再按包的 `dsh.client` 声明解析 `./client` 导出）。

可配置项：`DSH_VERIFY_TARGET_ID` / `DSH_VERIFY_TARGET_NAME` / `DSH_VERIFY_TOOL_PREFIX` /
`DSH_VERIFY_DISPOSE=0` / `DSH_VERIFY_OUT`（apply 时写入 JSON 文件，供脚本断言）。

## 环境事实（2026-10-20，DSH 0.2.1-rc.2）

- 隔离 web profile 启动后**不会**因 stdin EOF 自行退出；脚本用 SIGTERM 收尾（exit 0）。
  真正的 dispose 正确性由 verify-probe 主动 `fiber.dispose()` 断言，不依赖进程退出路径。
- loader 启动不是单一串行屏障：bundle row 的 tool 注册可能晚于最后一个 patch row 的
  apply，所以 verify-probe 会轮询最多 15s 等 `mcp_manager_*` 出现。
- web app 监听端口用 `--port 0` 避免和真实实例/并行脚本抢 3080。
