/**
 * Static + registration checks for dsh-mcp-manager's client half.
 *
 * The real page runs inside DSH Desktop's browser runtime (React + primitives),
 * which is not available under Node. This script therefore:
 *   1. runs `node --check` on lib/client.js (it is a plain script, no import/export);
 *   2. asserts the page is wired to the sidebar/main slots and to every
 *      `/mcp-manager` RPC endpoint from DESIGN.md §5;
 *   3. asserts there is no JSX, no ESM syntax, and that the CSS is token-based;
 *   4. loads the module through a stubbed `window.__ModuleLoader__` and runs
 *      `apply(ctx)` against a fake slot registry to verify the actual
 *      registrations (id/order/label/key) and component wiring.
 *
 * Run: node test/client/check-client.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const clientPath = fileURLToPath(new URL('../../lib/client.js', import.meta.url));
const source = readFileSync(clientPath, 'utf8');
let passed = 0;

async function check(name, run) {
  await run();
  passed += 1;
  console.log(`ok  ${name}`);
}

// 1. syntax -----------------------------------------------------------------
await check('node --check lib/client.js', () => {
  execFileSync(process.execPath, ['--check', clientPath], { stdio: 'pipe' });
});

// 2. loader / module shape ---------------------------------------------------
await check('loader id and factory shape', () => {
  assert.ok(source.includes('window.__ModuleLoader__.load({'), 'missing __ModuleLoader__.load call');
  assert.ok(source.includes("id: 'dsh-mcp-manager'"), 'missing module id dsh-mcp-manager');
  assert.match(source, /factory:\s*\(require\)\s*=>\s*\{/, 'missing factory(require)');
  assert.ok(source.includes("require('react')"), 'missing react require');
  assert.ok(source.includes("require('@deepseek-ai/dsh-client-ui-primitives')"), 'missing primitives require');
  assert.ok(source.includes('exports.apply = apply;'), 'missing exports.apply');
  assert.ok(source.includes('exports.inject = inject;'), 'missing exports.inject');
});

await check('no JSX, no ESM import/export, no React.createElement', () => {
  assert.doesNotMatch(source, /<\/[a-z][^>]*>/i, 'found closing JSX tag');
  assert.doesNotMatch(source, /<[A-Z][A-Za-z0-9]*[\s/>]/, 'found JSX component tag');
  assert.doesNotMatch(source, /<[a-z][a-z0-9-]*\s+[a-z-]+=/, 'found JSX element with attribute');
  assert.doesNotMatch(source, /^\s*import\s/m, 'found ESM import');
  assert.doesNotMatch(source, /^\s*export\s/m, 'found ESM export');
  assert.doesNotMatch(source, /React\.createElement/, 'use h(), not React.createElement');
  assert.ok(source.includes('const h = react.createElement;'), 'missing h() binding');
});

// 3. slots / panel registration ---------------------------------------------
await check('panel id, sidebar slot, order and label', () => {
  assert.ok(source.includes("const PANEL_ID = 'mcp-manager'"), 'PANEL_ID must be mcp-manager');
  assert.ok(source.includes("ctx.slots.inject('sidebar.panellist'"), 'missing sidebar.panellist inject');
  assert.match(source, /name: 'sidebar\.panellist', id: PANEL_ID, order: 6, label: \(\) => 'MCP'/, 'panellist descriptor mismatch');
  assert.ok(source.includes("ctx.slots.inject('main'"), 'missing main inject');
  assert.match(source, /name: 'main', key: PANEL_ID/, 'main descriptor mismatch');
  assert.ok(source.includes("const inject = ['slots', 'connection'];"), 'client inject list mismatch');
});

// 4. RPC contract (DESIGN.md §5) --------------------------------------------
await check('RPC route and every endpoint used', () => {
  assert.ok(source.includes("const RPC_ROUTE = '/mcp-manager'"), 'missing /mcp-manager RPC route');
  assert.ok(source.includes('connection.rpc.call(RPC_ROUTE, endpoint, payload)'), 'must call connection.rpc.call');
  assert.ok(source.includes('result.ok !== true'), 'must handle { ok: false, error } envelopes');
  assert.ok(source.includes("rpc('state')"), 'state endpoint not called');
  assert.ok(source.includes("editing ? 'server.update' : 'server.add'"), 'server.add/server.update not called');
  assert.ok(source.includes("rpc('server.remove'"), 'server.remove endpoint not called');
  assert.ok(source.includes("rpc('server.toggle'"), 'server.toggle endpoint not called');
  assert.ok(source.includes("rpc('server.test'"), 'server.test endpoint not called');
  assert.ok(source.includes("rpc('server.import'"), 'server.import endpoint not called');
  assert.ok(source.includes("rpc('server.importTest'"), 'server.importTest endpoint not called');
  assert.ok(source.includes("rpc('status')"), 'status endpoint not called');
  for (const endpoint of ['state', 'server.add', 'server.update', 'server.remove', 'server.toggle', 'server.test', 'server.import', 'server.importTest', 'status']) {
    assert.ok(source.includes(`'${endpoint}'`), `endpoint string missing: ${endpoint}`);
  }
});

await check('single add dialog: tabs, 连接测试 section, add-mode defaults and both tests', () => {
  for (const copy of [
    '添加 MCP',
    '手动配置',
    '代码粘贴',
    '连接测试',
    '测试连接',
    '测试当前表单，不保存。',
    '逐个测试，不保存；stdio 会真实启动命令。',
    'mcpServers',
    'Bearer 粘贴你的Token',
    '裸 map',
    'sse 按 streamable-http',
    '明文会写入 0600 manifest',
    '已导入：',
    '跳过',
    '警告：',
    '请先粘贴 JSON 配置',
    '覆盖已存在的 server',
    'EXISTS',
  ]) {
    assert.ok(source.includes(copy), `missing add-dialog copy: ${copy}`);
  }
  assert.ok(source.includes("title: editing ? `编辑 ${server?.serverName ?? ''}` : '添加 MCP'"), 'dialog title must be 添加 MCP');
  assert.ok(source.includes('function ServerDialog'), 'ServerDialog component missing');
  assert.ok(!source.includes('function ImportDialog'), 'ImportDialog must be folded into ServerDialog');
  assert.ok(source.includes('function ImportResultView'), 'ImportResultView component missing');
  assert.ok(source.includes('function ImportTestResult'), 'ImportTestResult component missing');
  assert.ok(source.includes("className: 'dim-tabs'"), 'tab bar missing');
  assert.ok(source.includes('dim-tabActive'), 'active tab styling missing');
  assert.ok(source.includes("className: 'dim-formDivider'"), 'form divider missing');
  assert.ok(source.includes('.dim-formDivider{border-top:.5px solid var(--dsw-alias-border-l2)'), 'divider must use the border token');
  assert.ok(!source.includes('position:sticky'), 'dialog footer must not be sticky (natural height)');
  assert.ok(source.includes('IMPORT_EXAMPLE'), 'sample placeholder constant missing');
  for (const line of ['\n  "mcpServers": {', '\n    "flomo": {', '\n      "type": "streamable-http",', '\n        "Authorization": "Bearer 粘贴你的Token"']) {
    assert.ok(source.includes(line), `placeholder must use 2-space JSON indentation: ${line}`);
  }
  assert.ok(source.includes('normalizeImportResult'), 'import result normalization missing');

  // add mode omits enabled/timeout (host defaults), edit mode keeps them.
  assert.ok(source.includes('delete payload.enabled'), 'add mode must omit enabled');
  assert.ok(source.includes('delete payload.toolCallTimeoutMs'), 'add mode must omit toolCallTimeoutMs');
  assert.ok(!source.includes('pasteEnabled'), 'paste mode must not have an enabled control');
  assert.ok(!source.includes('pasteTimeout'), 'paste mode must not have a timeout control');
  assert.ok(source.includes("transport: server === null || server === undefined"), 'add mode transport default missing');
  assert.ok(source.includes("'streamable-http'"), 'default transport must be streamable-http');
  assert.ok(!/label: '请求头',[\s\S]*?valuePlaceholder: 'env:MCP_API_KEY',\s*hint:/.test(source), 'headers editor must not render a hint');

  // payload contracts
  assert.ok(source.includes("const payload = { json, replace: options.replace === true };"), 'server.import payload must only carry json/replace');
  assert.ok(source.includes("rpc('server.importTest', { json })"), 'server.importTest payload must only carry json');
  assert.ok(!source.includes('enabled: options.enabled !== false'), 'import payload must not carry enabled');
  assert.ok(!source.includes('payload.toolCallTimeoutMs = Math.floor(timeout)'), 'import payload must not carry toolCallTimeoutMs');
  assert.ok(source.includes("importing ? '添加中…' : '添加 MCP'"), 'paste footer button must say 添加 MCP');
  assert.ok(source.includes('无法解析') || source.includes('parseErrors'), 'parseErrors must be consumed');
  assert.ok(source.includes('一次最多测试前 10 个 server'), 'importTest skipped cap hint missing');
  assert.ok(source.includes("disabled: manualTest?.loading === true"), 'manual test button must be disabled while testing');
  assert.ok(source.includes("disabled: importTest?.loading === true"), 'import test button must be disabled while testing');
  assert.ok(source.includes("reason === 'EXISTS'"), 'EXISTS skipped reasons must be mapped to friendly copy');
  assert.ok(source.includes('function skippedReasonText'), 'skipped reason rendering must de-duplicate the serverName prefix');
  const emptyGate = source.indexOf("if (text.trim() === '')");
  assert.ok(emptyGate !== -1, 'empty/whitespace paste must be blocked locally');
  assert.ok(emptyGate < source.indexOf('await onImport'), 'empty paste must be rejected before the RPC call');
});

await check('toolbar has only 刷新 + 添加 MCP; tabs live inside the dialog', () => {
  const toolbar = source.slice(source.indexOf('const pageHead = h('), source.indexOf("if (view === 'detail'"));
  assert.match(toolbar, /icon: h\(IconRefreshOutlineRegular, \{ size: 13 \}\)[\s\S]*?'刷新'\)/, '刷新 button missing');
  assert.match(toolbar, /icon: h\(IconPlusOutlineRegular, \{ size: 13 \}\)[\s\S]*?'添加 MCP'\)/, 'single 添加 MCP button missing');
  assert.ok(!toolbar.includes('手动配置'), 'manual-config toolbar button must be gone');
  assert.ok(!toolbar.includes('代码粘贴'), 'paste-code toolbar button must be gone');
  assert.ok(source.includes('还没有 MCP server。点右上角「添加 MCP」'), 'empty-state guidance must use 添加 MCP');
  assert.ok(source.includes("setTab('paste')") && source.includes("setTab('manual')"), 'tab switching handlers missing');
  assert.ok(source.includes('...manualConfig)') && source.includes('...pasteConfig'), 'both panels must always be rendered');
  assert.ok(source.includes("dim-tabPanel${activeTab === 'manual' ? '' : ' dim-tabPanelHidden'}"), 'manual panel hidden class toggle missing');
  assert.ok(source.includes("dim-tabPanel${activeTab === 'paste' ? '' : ' dim-tabPanelHidden'}"), 'paste panel hidden class toggle missing');
});

await check('host-config rows: source/readOnly/conflict and readonly detail', () => {
  for (const marker of [
    "source === 'host'",
    'readOnly: raw.readOnly === true || source === \'host\'',
    'entryId',
    'active: raw.active !== false',
    "scope: raw.scope === 'preset'",
    "conflict: raw.conflict === 'host'",
  ]) {
    assert.ok(source.includes(marker), `missing host-config marker: ${marker}`);
  }
  for (const copy of [
    '来自 DSH 配置',
    '此 MCP 来自 DSH 宿主配置',
    'cordis.patch.yml',
    '与 DSH 宿主配置重名',
    '未重复挂载',
    'DSH 宿主已配置同名 MCP',
    '无需重复添加',
  ]) {
    assert.ok(source.includes(copy), `missing host-config copy: ${copy}`);
  }
  assert.ok(source.includes("rpc('server.test', { serverName: server.serverName })"), 'test connection must use the saved config by serverName');
  assert.ok(source.includes("status.lastError !== '' && server.conflict !== 'host'"), 'conflict status marker must not render as a red error');
  assert.ok(source.includes("expression: entry.expression === true"), 'host env/header expression markers must be preserved');
  assert.ok(source.includes("'表达式，未求值'"), 'un-evaluated host expressions need their own label');
  assert.ok(source.includes("timeoutConfigured"), 'host rows without toolCallTimeoutMs must fall back to 宿主默认');
  assert.ok(source.includes("scope === 'preset' ? h(Tag, null, 'Preset')"), 'preset-scoped host rows need a Preset badge');
  assert.ok(source.includes("reason === 'EXISTS_HOST_CONFIG'"), 'import skipped reason EXISTS_HOST_CONFIG must be mapped to friendly copy');
  assert.ok(source.includes("cause.code === 'EXISTS_HOST_CONFIG'"), 'EXISTS_HOST_CONFIG must be mapped to friendly copy');
  assert.ok(source.includes("server.source === 'host' ? h(Tag, null, '来自 DSH 配置') : null"), 'host rows must render the source badge');
  assert.ok(source.includes("server.conflict === 'host' ? h(Tag, { tone: 'warn' }, '与宿主配置重名，未重复挂载') : null"), 'conflict rows must render the warn badge');
  assert.ok(source.includes("server.readOnly\n              ? null\n              : h('button', {"), 'readonly rows must not render the enable switch');
});

await check('plaintext header/env values: encryption UI is gone, references stay editable', () => {
  for (const marker of ['encryption', 'encrypt', 'secret', '已加密', 'ENCRYPTION_UNAVAILABLE', 'DECRYPT_FAILED', 'encryptExisting', 'normalizeEncryption']) {
    assert.ok(!source.includes(marker), `encryption remnant still present: ${marker}`);
  }
  for (const copy of [
    '支持 env:NAME / credential:NAME；明文会写入 0600 manifest',
    '已有行留空保持原值，删除行即删除',
    '新增的${entryLabel}',
    '需要填写值（可用 env:NAME / credential:NAME 引用）',
  ]) {
    assert.ok(source.includes(copy), `missing plaintext copy: ${copy}`);
  }
  assert.ok(source.includes('function referenceErrorText'), 'reference error mapper missing');
  for (const code of ['CREDENTIAL_MISSING', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_RESOLVE_FAILED', 'ENV_MISSING']) {
    assert.ok(source.includes(code), `reference error code missing: ${code}`);
  }
  assert.ok(source.includes('entry.value'), 'detail must render the real header/env value');
  assert.ok(!source.includes('secret:true'), 'secret markers must no longer be consumed');
});

await check('dialog copy is concise and the layout uses the unified scale', () => {
  for (const oldCopy of ['MCP server 挂在宿主进程上', '粘贴 Claude/Cursor 风格的 MCP 配置', 'plaintextHint', '已挂载的连接会先卸载', '深度研究类 server 可调大']) {
    assert.ok(!source.includes(oldCopy), `old verbose copy still present: ${oldCopy}`);
  }
  for (const copy of [
    '粘贴 mcpServers JSON，可先测试再导入。',
    '保存后会重新挂载该 server。',
    '会成为工具名前缀 mcp__name__；字母、数字、_、-，1–32 字符。',
    'stdio 会执行你填写的命令，请只添加可信来源。',
    '留空继承宿主工作目录。',
    '支持 mcpServers / 裸 map / 单个 server；http、sse 按 streamable-http 处理；缺省按 command/url 推断。',
    '同名默认跳过（EXISTS）；勾选后覆盖已有配置。',
    '默认 60000；长任务可调大。',
    '测试当前表单，不保存。',
    '逐个测试，不保存；stdio 会真实启动命令。',
  ]) {
    assert.ok(source.includes(copy), `missing concise copy: ${copy}`);
  }
  assert.equal((source.match(/明文会写入 0600 manifest/g) ?? []).length, 1, 'plaintext hint must only live in the KvEditor hint');
  assert.ok(!source.includes('单次粘贴上限约 2MB'), 'paste tab must not show the plaintext/2MB line');
  assert.ok(source.includes("h('p', { key: 'pasteIntro', className: 'dim-fieldHint' }, '粘贴 mcpServers JSON，可先测试再导入。支持 mcpServers"), 'paste intro must be a single paragraph');
  for (const cls of ['.dim-dialogBody', '.dim-formBody', '.dim-tabStack', '.dim-tabPanel', '.dim-tabPanelHidden', '.dim-dialogSettings', '.dim-serverFooter', '.dim-fieldHead']) {
    assert.ok(source.includes(cls + '{'), `missing layout class: ${cls}`);
  }
  assert.ok(source.includes('className: \'dim-fieldHead\'') || source.includes('className: "dim-fieldHead"'), 'KvEditor header row missing');
  assert.ok(source.includes("'添加一行'"), 'KvEditor add button missing');
  assert.ok(source.includes('form.headers.length > 0 ? form.headers : [{ name: \'\', value: \'\' }]'), 'headers must default to one blank row');
  assert.ok(source.includes('.dim-tabStack{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:1fr}'), 'tab stack must be a 1fr grid');
  assert.ok(source.includes('.dim-tabPanel{grid-area:1/1;'), 'both panels must share the same grid cell');
  assert.ok(source.includes('.dim-tabPanelHidden{visibility:hidden;pointer-events:none}'), 'inactive panel must be hidden but occupy space');
  assert.ok(!source.includes('min-height:430px'), 'equal height must come from the grid, not a guessed min-height');
  assert.ok(!source.includes('height:clamp(460px'), 'dialog must not have a fixed height');
  assert.ok(!source.includes('position:sticky'), 'footer must remain in natural flow');
  assert.ok(!source.includes('.dim-dialogForm .dim-dialogBody'), 'dialog body must not scroll internally');
  assert.ok(source.includes("className: 'dim-dialogForm'"), 'ServerDialog must keep the shared dialog class');
  assert.ok(source.includes('dim-tabPanelHidden'), 'inactive panel class must be applied');
  assert.ok(source.includes("row.name.trim() !== ''"), 'cleanEntries must drop blank header/env rows');
  assert.ok(source.includes('rows: 3'), 'manual args textarea must be 3 rows');
  assert.ok(source.includes('rows: 8'), 'paste textarea must be 8 rows');
  assert.ok(source.includes('.dim-importTextarea{') && source.includes('overflow-y:auto'), 'paste textarea must scroll internally');
  assert.ok(source.includes('.dim-pasteReplace{display:flex;flex-direction:column;gap:var(--dim-space-1)}'), 'replace checkbox + hint must be a compact group');
  assert.ok(source.includes("className: 'dim-pasteReplace'"), 'replace group element missing');
  assert.ok(source.includes('--dim-space-4'), 'spacing token missing');
  assert.ok(source.includes('--dim-space-field'), 'field spacing token missing');
  assert.ok(source.includes('font-size:13px;font-weight:500;line-height:20px'), 'list title must be 13/20');
  assert.ok(source.includes('.dim-field{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:18px'), 'field label must be 13/18');
  assert.ok(source.includes('.dim-detailSections{flex-direction:column;gap:var(--dim-space-6)'), 'detail sections must use 24px gaps');
  assert.ok(source.includes('.dim-dialog{') && source.includes('gap:12px'), 'dialog head gap must be 12px');
});

await check('icons: plug MCP icon and single add button', () => {
  for (const path of ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z']) {
    assert.ok(source.includes(path), `plug icon path missing: ${path}`);
  }
  assert.ok(source.includes('h(McpIcon, { size: 22 })'), 'list row must reuse McpIcon');
  assert.ok(source.includes("h('span', { className: 'dim-detailIcon' }, h(McpIcon, { size: 18 }))"), 'detail header icon must reuse McpIcon');
  assert.match(source, /ctx\.slots\.register\(\{ name: 'sidebar\.panellist'[\s\S]*?\}, McpIcon\)/, 'sidebar entry must reuse McpIcon');
  assert.ok(source.includes('placeholder: String(DEFAULT_TIMEOUT_MS)'), 'timeout placeholders must be 60000');
});

await check('workspace scope UI is fully removed', () => {
  for (const marker of ['orkspace', '工作区', 'allWorkspaces', 'selectedWorkspaceIds', 'staleWorkspaces', 'externalScopes', 'workspaces.refresh', 'WorkspacePicker', 'HostWorkspaceDialog']) {
    assert.ok(!source.includes(marker), `workspace scope remnant still present: ${marker}`);
  }
});

// 5. required UI behaviour ---------------------------------------------------
await check('polling ~5s, paused while a dialog is open', () => {
  assert.match(source, /POLL_INTERVAL_MS = 5000/, 'poll interval should be 5000ms');
  assert.match(source, /if \(!modalRef\.current\) void loadState\(\{ silent: true \}\)/, 'poll must pause when modal is open');
});

await check('Chinese page copy and status vocabulary', () => {
  for (const copy of ['MCP', '刷新', '添加 MCP', '手动配置', '代码粘贴', '连接测试', '测试连接', '编辑', '启用', '停用', '删除', '已连接', '已挂载未连接', '错误', '还没有 MCP server']) {
    assert.ok(source.includes(copy), `missing Chinese copy: ${copy}`);
  }
  assert.match(source, /label: \(\) => 'MCP'/, 'sidebar label must be MCP');
});

await check('dialog fields: name, transport, url/command, env/headers, timeout, enabled', () => {
  for (const copy of [
    '服务器名称',
    '传输方式',
    'MCP 地址',
    '命令',
    '参数（每行一个）',
    '工作目录（可选）',
    '环境变量',
    '请求头',
    '工具调用超时（毫秒）',
    '启用该 server',
    'stdio 会执行你填写的命令',
    'env:NAME',
    '明文会写入 0600 manifest',
  ]) {
    assert.ok(source.includes(copy), `missing dialog copy: ${copy}`);
  }
  assert.ok(source.includes("id: 'stdio'"), 'missing stdio transport');
  assert.ok(source.includes("id: 'streamable-http'"), 'missing streamable-http transport');
  assert.ok(source.includes("type: 'checkbox'"), 'missing checkbox controls');
});

await check('test result area shows latency/protocol/tools and error class', () => {
  for (const marker of ['latencyMs', 'protocolVersion', 'serverInfo', 'tools', 'ERROR_LABELS', 'timeout', 'auth', 'transport', 'protocol', 'unknown']) {
    assert.ok(source.includes(marker), `missing test-result data: ${marker}`);
  }
  assert.ok(source.includes("h('details'"), 'tool names should be expandable');
});

await check('CSS is token-based (dark mode)', () => {
  const tokens = source.match(/--dsw-alias-[a-z0-9-]+/g) ?? [];
  assert.ok(tokens.length >= 20, `expected many --dsw-alias-* tokens, got ${tokens.length}`);
  for (const token of ['--dsw-alias-label-primary', '--dsw-alias-bg-layer-2', '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary', '--dsw-radius-xl', '--dsw-font-mono']) {
    assert.ok(source.includes(token), `missing CSS token: ${token}`);
  }
  assert.ok(source.includes('dim-page'), 'missing dim-page layout');
  assert.ok(source.includes('dim-overlay'), 'missing dialog overlay');
});

// 6. load the module and run apply() against a fake slot registry ------------
await check('apply() registers sidebar.panellist + main through the real loader contract', async () => {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition; } } },
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });
  assert.ok(captured !== null, 'window.__ModuleLoader__.load was not called');
  assert.equal(captured.id, 'dsh-mcp-manager');

  const createElement = (type, props, ...children) => ({ type, props: props ?? null, children });
  const fakeReact = {
    createElement,
    useState() { throw new Error('useState must not run outside the browser runtime'); },
    useEffect() { throw new Error('useEffect must not run outside the browser runtime'); },
    useRef() { throw new Error('useRef must not run outside the browser runtime'); },
  };
  const fakeUi = new Proxy({}, { get: () => function DummyPrimitive() { return null; } });
  const fakeRequire = (id) => {
    if (id === 'react') return fakeReact;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return fakeUi;
    throw new Error(`unexpected require(${JSON.stringify(id)})`);
  };

  const exports = captured.factory(fakeRequire);
  assert.equal(Object.prototype.toString.call(exports), '[object Module]');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(Array.from(exports.inject), ['slots', 'connection']);

  const registrations = [];
  const ctx = {
    slots: {
      register(descriptor, component) {
        registrations.push({ descriptor, component });
        return { descriptor };
      },
      inject(name, factory) {
        const value = factory();
        if (value !== null && value !== undefined && typeof value.next === 'function') value.next();
      },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  };
  await exports.apply(ctx);
  assert.equal(registrations.length, 2, `expected 2 slot registrations, got ${registrations.length}`);

  const panel = registrations.find((entry) => entry.descriptor.name === 'sidebar.panellist');
  assert.ok(panel !== undefined, 'sidebar.panellist was not registered');
  assert.equal(panel.descriptor.id, 'mcp-manager');
  assert.equal(panel.descriptor.order, 6);
  assert.equal(typeof panel.descriptor.label, 'function');
  assert.equal(panel.descriptor.label(), 'MCP');
  assert.equal(typeof panel.component, 'function', 'panel icon component missing');

  const main = registrations.find((entry) => entry.descriptor.name === 'main');
  assert.ok(main !== undefined, 'main was not registered');
  assert.equal(main.descriptor.key, 'mcp-manager');
  assert.equal(typeof main.component, 'function', 'main page component missing');
  const page = main.component();
  assert.equal(typeof page.type, 'function', 'main component must render a page component');
  assert.equal(typeof page.props.rpc, 'function', 'main page must receive the rpc helper');
});

console.log(`\nALL CLIENT CHECKS PASSED (${passed})`);
