/**
 * Render smoke test for dsh-mcp-manager's client page.
 *
 * No React and no browser: React is replaced with a stub whose `createElement`
 * returns plain descriptor objects, and whose hooks return values from a fixed
 * queue for the duration of one render. That is enough to execute every render
 * branch of the page (list, stdio detail, streamable-http detail, add dialog,
 * edit dialog, delete dialog, connectivity-test result) and catch undefined
 * accesses / malformed element trees without a DOM.
 *
 * Run: node test/client/render-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const clientPath = fileURLToPath(new URL('../../lib/client.js', import.meta.url));
const source = readFileSync(clientPath, 'utf8');
let passed = 0;

function ok(name, run) {
  run();
  passed += 1;
  console.log(`ok  ${name}`);
}

async function okAsync(name, run) {
  await run();
  passed += 1;
  console.log(`ok  ${name}`);
}

// --- stubbed React ---------------------------------------------------------
let activeHooks = null;

function makeHooks(queue) {
  let stateIndex = 0;
  let refIndex = 0;
  const refs = [];
  return {
    useState(initial) {
      const index = stateIndex++;
      const given = index < queue.length ? queue[index] : undefined;
      const value = given !== undefined ? given : (typeof initial === 'function' ? initial() : initial);
      return [value, () => {}];
    },
    useRef(initial) {
      const index = refIndex++;
      if (refs[index] === undefined) refs[index] = { current: initial };
      return refs[index];
    },
  };
}

const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });

const fakeReact = {
  createElement,
  useState(initial) {
    if (activeHooks === null) throw new Error('useState called outside a test render');
    return activeHooks.useState(initial);
  },
  useEffect() {
    if (activeHooks === null) throw new Error('useEffect called outside a test render');
    // Effects are not exercised here (no DOM); they only schedule I/O.
  },
  useRef(initial) {
    if (activeHooks === null) throw new Error('useRef called outside a test render');
    return activeHooks.useRef(initial);
  },
};

const fakeUi = new Proxy({}, { get: () => function DummyPrimitive() { return null; } });

function loadClient() {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition; } } },
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });
  assert.ok(captured !== null, 'module loader was not called');
  const exports = captured.factory((id) => {
    if (id === 'react') return fakeReact;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return fakeUi;
    throw new Error(`unexpected require(${JSON.stringify(id)})`);
  });

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
  return { exports, registrations, ctx };
}

/** Render one component with a fixed hook queue. */
function render(component, props, queue = []) {
  activeHooks = makeHooks(queue);
  try {
    return component(props);
  } finally {
    activeHooks = null;
  }
}

// --- element-tree helpers --------------------------------------------------
function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  if (node.type !== undefined) visit(node);
  walk(node.children, visit);
}

function find(node, predicate) {
  let found = null;
  walk(node, (element) => {
    if (found === null && predicate(element)) found = element;
  });
  return found;
}

function findComponent(tree, name) {
  return find(tree, (element) => typeof element.type === 'function' && element.type.name === name);
}

function texts(tree) {
  const out = [];
  walk(tree, (element) => {
    const children = element.children ?? [];
    for (const child of children) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child));
    }
    // Props rendered by small presentational components (StateLabel, InfoRow, Dialog).
    if (typeof element.props?.status?.label === 'string') out.push(element.props.status.label);
    if (typeof element.props?.label === 'string') out.push(element.props.label);
    if (typeof element.props?.value === 'string') out.push(element.props.value);
    if (typeof element.props?.title === 'string') out.push(element.props.title);
    if (typeof element.props?.hint === 'string') out.push(element.props.hint);
  });
  return out.join(' | ');
}

function classes(tree) {
  const out = [];
  walk(tree, (element) => {
    if (typeof element.props?.className === 'string') out.push(element.props.className);
  });
  return out;
}

function countClass(tree, className) {
  let count = 0;
  walk(tree, (element) => {
    const value = element.props?.className;
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) count += 1;
    const dots = element.props?.status?.dot;
    if (typeof dots === 'string' && dots.split(/\s+/).includes(className)) count += 1;
  });
  return count;
}

function tabPanels(tree) {
  const panels = [];
  walk(tree, (element) => {
    const value = element.props?.className;
    if (typeof value === 'string' && value.split(/\s+/).includes('dim-tabPanel')) panels.push(element);
  });
  return panels;
}

function buttonByText(tree, label) {
  return find(tree, (element) => typeof element.type === 'function' && Array.isArray(element.children) && element.children.includes(label));
}

function hasClass(tree, className) {
  return find(tree, (element) => {
    const value = element.props?.className;
    return typeof value === 'string' && value.split(/\s+/).includes(className);
  }) !== null;
}

/**
 * Minimal stateful hook runtime: mount a component, call an onChange handler
 * found in its tree, then mount again with the updated state.
 */
function createPersistentHarness(initialQueue = []) {
  const values = [];
  const pending = [];
  let stateIndex = 0;
  const hooks = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in values)) {
        const given = index < initialQueue.length ? initialQueue[index] : undefined;
        values[index] = given !== undefined ? given : (typeof initial === 'function' ? initial() : initial);
      }
      return [values[index], (next) => { pending.push({ index, next }); }];
    },
    useRef(initial) {
      return { current: initial };
    },
  };
  const applyPending = () => {
    while (pending.length > 0) {
      const update = pending.shift();
      values[update.index] = typeof update.next === 'function' ? update.next(values[update.index]) : update.next;
    }
  };
  return {
    mount(component, props) {
      // Updates queued by event handlers between mounts take effect now.
      applyPending();
      stateIndex = 0;
      activeHooks = hooks;
      let tree;
      try {
        tree = component(props);
      } finally {
        activeHooks = null;
      }
      applyPending();
      return tree;
    },
  };
}

// --- fixtures --------------------------------------------------------------


const snapshot = {
  version: 2,
  servers: [
    {
      serverName: 'github', transport: 'stdio', enabled: true, toolCallTimeoutMs: 60000,
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: [{ name: 'GITHUB_TOKEN', value: 'env:GITHUB_TOKEN' }, { name: 'SECRET_TOKEN', value: 'ghp_plain_token' }],
    },
    {
      serverName: 'unifuncs', transport: 'streamable-http', enabled: true, toolCallTimeoutMs: 900000,
      command: '', args: [], env: [], cwd: '', url: 'https://mcp.unifuncs.com/mcp',
      headers: [{ name: 'Authorization', value: 'env:MCP_UNIFUNCS_API_KEY' }, { name: 'X-API-KEY', value: 'plain-api-key' }],
    },
    {
      serverName: 'flaky', transport: 'streamable-http', enabled: true, toolCallTimeoutMs: 60000,
      command: '', args: [], env: [], cwd: '', url: 'https://flaky.example/mcp', headers: [],
    },
    {
      serverName: 'off', transport: 'stdio', enabled: false, toolCallTimeoutMs: 60000,
      command: 'node', args: ['server.js'], env: [], cwd: '', url: '', headers: [],
    },
    {
      serverName: 'hostflomo', transport: 'streamable-http', enabled: true, toolCallTimeoutMs: 60000,
      command: '', args: [], env: [], cwd: '', url: 'https://flomoapp.com/mcp',
      headers: [{ name: 'Authorization', value: 'process.env.FLOMO_TOKEN', expression: true }],
      source: 'host', readOnly: true, entryId: 'dsh-mcp-client:flomo', active: true, disabled: false, scope: 'profile', conflict: '',
    },
    {
      serverName: 'hostold', transport: 'stdio', enabled: true,
      command: 'node', args: ['old.js'], env: [], cwd: '', url: '', headers: [],
      source: 'host', readOnly: true, entryId: 'dsh-mcp-client:old', active: false, disabled: false, scope: 'preset', conflict: '',
      timeoutConfigured: false,
    },
    {
      serverName: 'flomo', transport: 'streamable-http', enabled: true, toolCallTimeoutMs: 60000,
      command: '', args: [], env: [], cwd: '', url: 'https://flomoapp.com/mcp', headers: [],
      source: 'manager', readOnly: true, entryId: 'dsh-mcp-client:flomo', active: true, disabled: false, scope: 'profile', conflict: 'host',
    },
  ],
  status: {
    github: { mounted: true, toolCount: 3, lastError: null },
    unifuncs: { mounted: true, toolCount: 0, lastError: null },
    flaky: { mounted: false, toolCount: 0, lastError: 'connect ECONNREFUSED 127.0.0.1:9' },
    off: { mounted: false, toolCount: 0, lastError: null },
    hostflomo: { mounted: true, toolCount: 2, lastError: null },
    hostold: { mounted: false, toolCount: 0, lastError: null },
    flomo: { mounted: true, toolCount: 1, lastError: null },
  },
};

// Hook queues, in declaration order:
// snapshot, loadError, error, notice, busy, view, selectedName, modal, testState, panelRect
const listQueue = (modal = null) => [snapshot, '', '', '', '', 'list', null, modal, null, null];
const detailQueue = (name) => [snapshot, '', '', '', '', 'detail', name, null, null, null];

const { exports } = loadClient();

assert.equal(typeof exports.apply, 'function');
const registrations2 = [];
const applyCtx = {
  slots: {
    register(descriptor, component) { registrations2.push({ descriptor, component }); return { descriptor }; },
    inject(name, factory) {
      const value = factory();
      if (value !== null && value !== undefined && typeof value.next === 'function') value.next();
    },
  },
  connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
};
await exports.apply(applyCtx);
const main = registrations2.find((entry) => entry.descriptor.name === 'main');
assert.ok(main !== undefined, 'main slot was not registered');
const pageComponent = main.component().type;
assert.equal(typeof pageComponent, 'function');

// --- list page -------------------------------------------------------------
const listTree = render(pageComponent, { rpc: async () => ({}) }, listQueue());
const listText = texts(listTree);

ok('list page renders header, toolbar and every status badge', () => {
  assert.equal(countClass(listTree, 'dim-page'), 1);
  for (const copy of ['MCP', '刷新', '添加 MCP', 'MCP Server', '个 server']) {
    assert.ok(listText.includes(copy), `list page missing: ${copy}`);
  }
  for (const copy of ['已连接', '已挂载未连接', '错误', '停用', '未挂载', '来自 DSH 配置', 'Preset', '与宿主配置重名，未重复挂载', 'DSH 宿主配置 · preset']) {
    assert.ok(listText.includes(copy), `list page missing status copy: ${copy}`);
  }
  assert.equal(countClass(listTree, 'dim-switch'), snapshot.servers.filter((server) => server.readOnly !== true).length, 'only manager rows get an enable switch');
  assert.equal(countClass(listTree, 'dim-dotOk') >= 1, true);
  assert.equal(countClass(listTree, 'dim-dotWarn') >= 1, true);
  assert.equal(countClass(listTree, 'dim-dotErr') >= 1, true);
  assert.ok(listText.includes('connect ECONNREFUSED'), 'lastError must be visible in the row');
  assert.ok(!listText.includes('工作区'), 'list page must not mention workspaces');
});

ok('empty list renders onboarding copy', () => {
  const emptySnapshot = { ...snapshot, servers: [], status: {} };
  const tree = render(pageComponent, { rpc: async () => ({}) }, [emptySnapshot, '', '', '', '', 'list', null, null, null, null]);
  assert.ok(texts(tree).includes('还没有 MCP server'), 'missing empty-state guidance');
});

// --- stdio / http detail ---------------------------------------------------
const stdioDetail = render(pageComponent, { rpc: async () => ({}) }, detailQueue('github'));
const stdioText = texts(stdioDetail);

ok('stdio detail renders read-only fields and actions', () => {
  assert.equal(countClass(stdioDetail, 'dim-detail'), 1);
  for (const copy of ['github', 'npx -y @modelcontextprotocol/server-github', '工具调用超时', '60000 ms', '环境变量', 'GITHUB_TOKEN', 'env:GITHUB_TOKEN', '编辑', '停用', '删除', '连通性测试', '测试连接']) {
    assert.ok(stdioText.includes(copy), `stdio detail missing: ${copy}`);
  }
  assert.ok(hasClass(stdioDetail, 'dim-detailIcon'), 'detail header plug icon missing');
  assert.ok(!stdioText.includes('工作区'), 'stdio detail must not mention workspaces');
});

const httpDetail = render(pageComponent, { rpc: async () => ({}) }, detailQueue('unifuncs'));
const httpText = texts(httpDetail);

ok('streamable-http detail renders real header values', () => {
  for (const copy of ['unifuncs', 'https://mcp.unifuncs.com/mcp', '请求头', 'Authorization', 'env:MCP_UNIFUNCS_API_KEY', 'X-API-KEY', 'plain-api-key', '900000 ms']) {
    assert.ok(httpText.includes(copy), `http detail missing: ${copy}`);
  }
  assert.ok(!httpText.includes('工作区'), 'http detail must not mention workspaces');
});

// --- add / edit / delete dialogs -------------------------------------------
const addTree = render(pageComponent, { rpc: async () => ({}) }, listQueue({ kind: 'form', mode: 'add', server: null }));
const addDialog = findComponent(addTree, 'ServerDialog');
ok('add dialog defaults to streamable-http with tabs, divider and 连接测试 only', () => {
  assert.ok(addDialog !== null, 'add dialog not mounted');
  const dialog = render(addDialog.type, addDialog.props, [undefined, '', false]);
  const dialogText = texts(dialog);
  for (const copy of ['添加 MCP', '手动配置', '代码粘贴', '服务器名称', '传输方式', 'MCP 地址', '请求头', '连接测试', '测试连接', '取消', '添加 MCP']) {
    assert.ok(dialogText.includes(copy), `add dialog missing: ${copy}`);
  }
  assert.ok(!dialogText.includes('参数（每行一个）') && !dialogText.includes('stdio 会执行你填写的命令'), 'stdio fields must not render for the default transport');
  assert.ok(!dialogText.includes('工具调用超时（毫秒）'), 'add mode must not show the timeout setting');
  assert.ok(!dialogText.includes('启用该 server'), 'add mode must not show the enabled toggle');
  assert.ok(hasClass(dialog, 'dim-formDivider'), 'form divider missing');
  assert.equal(countClass(dialog, 'dim-tabActive'), 1, 'exactly one active tab');
  assert.ok(!dialogText.includes('工作区'), 'add dialog must not mention workspaces');
  const transportSelect = find(dialog, (element) => element.type === 'select');
  assert.equal(transportSelect.props.value, 'streamable-http', 'add mode must default to streamable-http');
  const kv = findComponent(dialog, 'KvEditor');
  const kvTree = render(kv.type, kv.props);
  assert.ok(hasClass(kvTree, 'dim-fieldHead'), 'KvEditor header row missing');
  assert.ok(buttonByText(kvTree, '添加一行') !== null, 'KvEditor add button must sit on the label row');
  assert.equal(kv.props.hint, undefined, 'headers editor must not render a hint');
  assert.equal(kv.props.rows.length, 1, 'new server headers must default to one blank row');
  assert.equal(kv.props.rows[0].name, '');
  assert.equal(kv.props.rows[0].value, '');
  assert.ok(hasClass(dialog, 'dim-dialogForm'), 'manual tab must use the shared dialog class');
  assert.ok(hasClass(dialog, 'dim-formBody'), 'manual tab must render the shared form body');
  assert.ok(hasClass(dialog, 'dim-tabStack'), 'manual tab must render the grid tab stack');
  const manualPanels = tabPanels(dialog);
  assert.equal(manualPanels.length, 2, 'manual and paste panels must both be in the tree');
  assert.equal(manualPanels.filter((panel) => String(panel.props.className).includes('dim-tabPanelHidden')).length, 1, 'exactly one panel is hidden');
  const pasteDialog = render(addDialog.type, addDialog.props, [undefined, '', false, 'paste', '', false, '', null, false, null, null]);
  assert.ok(hasClass(pasteDialog, 'dim-dialogForm'), 'paste tab must use the same shared dialog class');
  assert.ok(hasClass(pasteDialog, 'dim-formBody'), 'paste tab must render the same form body');

  const stdioFlow = render(addDialog.type, addDialog.props, [{ ...addDialog.props.server, transport: 'stdio' }, '', false]);
  const stdioText = texts(stdioFlow);
  assert.ok(stdioText.includes('命令') && stdioText.includes('参数（每行一个）') && stdioText.includes('环境变量'), 'stdio fields must render when selected');
});

ok('edit dialog renders http fields with real values and disables serverName', () => {
  const editTree = render(pageComponent, { rpc: async () => ({}) }, listQueue({ kind: 'form', mode: 'edit', server: snapshot.servers[1] }));
  const editDialog = findComponent(editTree, 'ServerDialog');
  assert.ok(editDialog !== null, 'edit dialog not mounted');
  const dialog = render(editDialog.type, editDialog.props, [undefined, '', false]);
  const dialogText = texts(dialog);
  for (const copy of ['编辑 unifuncs', 'MCP 地址', '请求头', '保存修改', '连接测试', '工具调用超时（毫秒）', '启用该 server']) {
    assert.ok(dialogText.includes(copy), `edit dialog missing: ${copy}`);
  }
  assert.ok(dialogText.includes('测试当前表单，不保存。'), 'edit test hint missing');
  assert.ok(!dialogText.includes('工作区'), 'edit dialog must not mention workspaces');
  assert.ok(!dialogText.includes('代码粘贴'), 'edit mode must not render the paste tab');
  assert.ok(!dialogText.includes('手动配置'), 'edit mode must not render the tab bar');
  const headersEditor = findComponent(dialog, 'KvEditor');
  assert.ok(headersEditor !== null, 'headers key/value editor missing');
  assert.equal(headersEditor.props.rows[0].name, 'Authorization');
  assert.equal(headersEditor.props.rows[0].value, 'env:MCP_UNIFUNCS_API_KEY');
  assert.equal(headersEditor.props.rows[1].value, 'plain-api-key');
  const headersTree = render(headersEditor.type, headersEditor.props);
  assert.ok(find(headersTree, (element) => element.props?.placeholder === 'env:MCP_API_KEY') !== null, 'headers env:NAME hint missing');
  assert.ok(find(headersTree, (element) => element.props?.value === 'plain-api-key') !== null, 'plaintext header value must be editable');
  const nameInput = find(dialog, (element) => element.props?.value === 'unifuncs');
  assert.ok(nameInput !== null, 'serverName input missing');
  assert.equal(nameInput.props.disabled, true, 'serverName must be read-only while editing');

  const flakyTree = render(pageComponent, { rpc: async () => ({}) }, listQueue({ kind: 'form', mode: 'edit', server: snapshot.servers[2] }));
  const flakyDialogElement = findComponent(flakyTree, 'ServerDialog');
  const flakyDialog = render(flakyDialogElement.type, flakyDialogElement.props, [undefined, '', false]);
  const flakyHeaders = findComponent(flakyDialog, 'KvEditor');
  assert.equal(flakyHeaders.props.rows.length, 1, 'edit with no headers must render one blank row');
  assert.equal(flakyHeaders.props.rows[0].name, '');
});

ok('delete dialog requires confirmation and shows the target server', () => {
  const removeTree = render(pageComponent, { rpc: async () => ({}) }, listQueue({ kind: 'remove', server: snapshot.servers[0] }));
  const removeDialog = findComponent(removeTree, 'RemoveDialog');
  assert.ok(removeDialog !== null, 'remove dialog not mounted');
  const dialog = render(removeDialog.type, removeDialog.props, ['', false]);
  const dialogText = texts(dialog);
  for (const copy of ['删除 MCP server', 'github', '不可撤销', '取消', '删除']) {
    assert.ok(dialogText.includes(copy), `delete dialog missing: ${copy}`);
  }
});

// --- host-configured (read-only) rows --------------------------------------
const hostDetail = render(pageComponent, { rpc: async () => ({}) }, detailQueue('hostflomo'));

ok('host-config detail is read-only and keeps test connection', () => {
  const text = texts(hostDetail);
  for (const copy of ['hostflomo', '来自 DSH 配置', '来自 DSH 宿主配置', 'dsh-mcp-client:flomo', 'cordis.patch.yml', '测试连接', 'DSH 宿主配置（profile）', 'process.env.FLOMO_TOKEN', '表达式，未求值']) {
    assert.ok(text.includes(copy), `host detail missing: ${copy}`);
  }
  assert.ok(!text.includes('工作区'), 'host detail must not mention workspaces');
  assert.equal(buttonByText(hostDetail, '编辑'), null, 'readonly detail must hide 编辑');
  assert.equal(buttonByText(hostDetail, '停用'), null, 'readonly detail must hide 停用');
  assert.equal(buttonByText(hostDetail, '删除'), null, 'readonly detail must hide 删除');
  assert.ok(buttonByText(hostDetail, '测试连接') !== null, 'readonly detail must keep 测试连接');
  assert.equal(buttonByText(hostDetail, '编辑生效工作区'), null, 'workspace editing button must be gone');

  const presetDetail = render(pageComponent, { rpc: async () => ({}) }, detailQueue('hostold'));
  const presetText = texts(presetDetail);
  assert.ok(presetText.includes('Preset'), 'preset-scoped host row must show a Preset badge');
  assert.ok(presetText.includes('未挂载'), 'inactive host row must show 未挂载');
  assert.ok(presetText.includes('宿主默认'), 'host row without toolCallTimeoutMs must show 宿主默认, not 60000');
});

ok('manager row conflicting with a host config shows a warn badge and explanation', () => {
  const conflictDetail = render(pageComponent, { rpc: async () => ({}) }, detailQueue('flomo'));
  const text = texts(conflictDetail);
  assert.ok(text.includes('与 DSH 宿主配置重名'), 'conflict detail explanation missing');
  assert.ok(text.includes('cordis.patch.yml'), 'conflict detail must point at cordis.patch.yml');
  assert.ok(text.includes('manager 项未重复挂载'), 'conflict detail must explain the manager row is not mounted');
  assert.ok(!text.includes('工作区'), 'conflict detail must not mention workspaces');
  assert.equal(buttonByText(conflictDetail, '编辑'), null, 'conflict row is read-only because the host row runs');

  const hostOnly = { ...snapshot, servers: snapshot.servers.filter((server) => server.readOnly === true) };
  const tree = render(pageComponent, { rpc: async () => ({}) }, [hostOnly, '', '', '', '', 'list', null, null, null, null]);
  assert.ok(texts(tree).includes('来自 DSH 配置'), 'host-only list must render host rows');
  assert.ok(!texts(tree).includes('还没有 MCP server'), 'host-only list must not show the empty state');
});

await okAsync('add dialog maps EXISTS_HOST_CONFIG to friendly copy', async () => {
  const addModalTree = render(pageComponent, { rpc: async () => ({}) }, listQueue({ kind: 'form', mode: 'add', server: null }));
  const addDialogElement = findComponent(addModalTree, 'ServerDialog');
  assert.ok(addDialogElement !== null, 'add dialog not mounted');
  const failingProps = {
    ...addDialogElement.props,
    onSubmit: async () => {
      const error = new Error('host config already exists');
      error.code = 'EXISTS_HOST_CONFIG';
      throw error;
    },
  };
  const form = {
    serverName: 'flomo', transport: 'stdio', url: '', command: 'npx', argsText: '', cwd: '',
    env: [], headers: [], toolCallTimeoutMs: '60000', enabled: true,
  };
  const instance = createPersistentHarness([form, '', false]);
  let tree = instance.mount(addDialogElement.type, failingProps);
  const submit = buttonByText(tree, '添加 MCP');
  assert.ok(submit !== null, 'add submit button missing');
  submit.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  tree = instance.mount(addDialogElement.type, failingProps);
  const text = texts(tree);
  for (const copy of ['DSH 宿主已配置同名 MCP', '无需重复添加', '可在列表里直接查看宿主配置']) {
    assert.ok(text.includes(copy), `EXISTS_HOST_CONFIG message missing: ${copy}`);
  }
});

// --- plaintext / reference header/env values -------------------------------
ok('details show real values, env references and un-evaluated expressions', () => {
  const page = render(pageComponent, { rpc: async () => ({}) }, listQueue());
  const pageText = texts(page);
  assert.ok(!pageText.includes('加密'), 'page must not mention encryption');
  const stdio = texts(stdioDetail);
  for (const copy of ['GITHUB_TOKEN', 'env:GITHUB_TOKEN', 'SECRET_TOKEN', 'ghp_plain_token']) {
    assert.ok(stdio.includes(copy), `stdio detail missing real value: ${copy}`);
  }
  const http = texts(httpDetail);
  for (const copy of ['Authorization', 'env:MCP_UNIFUNCS_API_KEY', 'X-API-KEY', 'plain-api-key']) {
    assert.ok(http.includes(copy), `http detail missing real value: ${copy}`);
  }
  const host = texts(hostDetail);
  assert.ok(host.includes('process.env.FLOMO_TOKEN'), 'host expression value must be shown');
  assert.ok(host.includes('表达式，未求值'), 'host expression tag missing');
});

ok('edit form shows real values and only the stdio env editor keeps its hint', () => {
  const editTree = render(pageComponent, { rpc: async () => ({}) }, listQueue({ kind: 'form', mode: 'edit', server: snapshot.servers[1] }));
  const editDialog = findComponent(editTree, 'ServerDialog');
  const dialog = render(editDialog.type, editDialog.props, [undefined, '', false]);
  const dialogText = texts(dialog);
  assert.ok(!dialogText.includes('加密'), 'edit dialog must not mention encryption');
  assert.ok(!dialogText.includes('支持 env:NAME / credential:NAME'), 'request headers must not repeat the hint');

  const stdioTree = render(pageComponent, { rpc: async () => ({}) }, listQueue({ kind: 'form', mode: 'edit', server: snapshot.servers[0] }));
  const stdioDialogElement = findComponent(stdioTree, 'ServerDialog');
  const stdioDialog = render(stdioDialogElement.type, stdioDialogElement.props, [undefined, '', false]);
  const envEditor = findComponent(stdioDialog, 'KvEditor');
  assert.ok(String(envEditor.props.hint).includes('支持 env:NAME / credential:NAME'), 'stdio env editor must keep its hint');
});

await okAsync('edit form sends real values, blank keeps the stored value, and new blank rows are blocked', async () => {
  const rpcCalls = [];
  const captureRpc = async (endpoint, payload) => {
    rpcCalls.push({ endpoint, payload });
    return {};
  };
  const page = render(pageComponent, { rpc: captureRpc }, listQueue({ kind: 'form', mode: 'edit', server: snapshot.servers[1] }));
  const dialogElement = findComponent(page, 'ServerDialog');
  const instance = createPersistentHarness([undefined, '', false]);
  const tree = instance.mount(dialogElement.type, dialogElement.props);
  const save = buttonByText(tree, '保存修改');
  assert.ok(save !== null, 'save button missing');
  save.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const call = rpcCalls.find((entry) => entry.endpoint === 'server.update');
  assert.ok(call !== undefined, 'server.update RPC not called');
  const headers = Array.from(call.payload.headers ?? []).map((entry) => ({ name: String(entry.name), value: String(entry.value) }));
  assert.deepEqual(headers, [
    { name: 'Authorization', value: 'env:MCP_UNIFUNCS_API_KEY' },
    { name: 'X-API-KEY', value: 'plain-api-key' },
  ]);
  assert.equal(call.payload.enabled, true, 'edit payload keeps enabled');
  assert.equal(call.payload.toolCallTimeoutMs, 900000, 'edit payload keeps toolCallTimeoutMs');

  // Blank on an existing row is sent as '' (host keeps the stored value).
  rpcCalls.length = 0;
  const blankForm = {
    serverName: 'unifuncs', transport: 'streamable-http', url: 'https://mcp.unifuncs.com/mcp',
    command: '', argsText: '', cwd: '', env: [], toolCallTimeoutMs: '900000', enabled: true,
    headers: [{ name: 'Authorization', value: 'env:MCP_UNIFUNCS_API_KEY', existing: true }, { name: 'X-API-KEY', value: '', existing: true }],
  };
  const blankInstance = createPersistentHarness([blankForm, '', false]);
  let blankTree = blankInstance.mount(dialogElement.type, dialogElement.props);
  buttonByText(blankTree, '保存修改').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const blankCall = rpcCalls.find((entry) => entry.endpoint === 'server.update');
  assert.ok(blankCall !== undefined, 'blank-keep update not sent');
  assert.deepEqual(Array.from(blankCall.payload.headers ?? []).map((entry) => ({ name: String(entry.name), value: String(entry.value) })), [
    { name: 'Authorization', value: 'env:MCP_UNIFUNCS_API_KEY' },
    { name: 'X-API-KEY', value: '' },
  ]);

  // A brand-new blank row is rejected locally (host would return INVALID_INPUT).
  const newForm = {
    serverName: 'unifuncs', transport: 'streamable-http', url: 'https://mcp.unifuncs.com/mcp',
    command: '', argsText: '', cwd: '', env: [], toolCallTimeoutMs: '900000', enabled: true,
    headers: [{ name: 'NEW-KEY', value: '' }],
  };
  const newInstance = createPersistentHarness([newForm, '', false]);
  let newTree = newInstance.mount(dialogElement.type, dialogElement.props);
  buttonByText(newTree, '保存修改').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  newTree = newInstance.mount(dialogElement.type, dialogElement.props);
  assert.ok(texts(newTree).includes('需要填写值'), 'new blank header row must be rejected locally');
});

// --- paste tab (inside the unified add dialog) -----------------------------
// Hook order: form, error, saving, tab, text, replace, pasteError, pasteResult,
// importing, manualTest, importTest.
const pasteDefaults = [undefined, '', false, 'paste', '', false, '', null, false, null, null];

await okAsync('paste tab maps reference errors (CREDENTIAL_MISSING) to friendly copy', async () => {
  const dialogTree = render(pageComponent, { rpc: async () => ({}) }, listQueue({ kind: 'form', mode: 'add', server: null }));
  const dialogElement = findComponent(dialogTree, 'ServerDialog');
  const failingProps = {
    ...dialogElement.props,
    onImport: async () => {
      const error = new Error('credential missing');
      error.code = 'CREDENTIAL_MISSING';
      throw error;
    },
  };
  const instance = createPersistentHarness([...pasteDefaults.slice(0, 4), '{}', ...pasteDefaults.slice(5)]);
  let tree = instance.mount(dialogElement.type, failingProps);
  const submit = buttonByText(tree, '添加 MCP');
  assert.ok(submit !== null, 'import submit button missing');
  submit.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  tree = instance.mount(dialogElement.type, failingProps);
  assert.ok(texts(tree).includes('credential 引用缺少对应凭据；请检查宿主的凭据配置。'), 'CREDENTIAL_MISSING error copy missing');
});

ok('paste tab renders one intro line, textarea, replace checkbox and 连接测试', () => {
  const dialog = render(addDialog.type, addDialog.props, pasteDefaults);
  const dialogText = texts(dialog);
  for (const copy of ['添加 MCP', '手动配置', '代码粘贴', 'mcpServers', '裸 map', 'sse 按 streamable-http', '覆盖已存在的 server', '连接测试', '测试连接', '取消', '添加 MCP']) {
    assert.ok(dialogText.includes(copy), `paste tab missing: ${copy}`);
  }
  const pastePanels = tabPanels(dialog);
  assert.equal(pastePanels.length, 2, 'paste tab must keep both panels mounted');
  const hiddenPanels = pastePanels.filter((panel) => String(panel.props.className).includes('dim-tabPanelHidden'));
  assert.equal(hiddenPanels.length, 1, 'inactive manual panel must be hidden');
  assert.ok(texts(hiddenPanels[0]).includes('服务器名称'), 'hidden manual panel keeps its state/fields');
  const textarea = find(dialog, (element) => element.type === 'textarea');
  assert.ok(textarea !== null, 'paste textarea missing');
  assert.equal(textarea.props.rows, 8);
  const placeholder = String(textarea.props.placeholder ?? '');
  assert.ok(placeholder.includes('mcpServers') && placeholder.includes('Bearer 粘贴你的Token'), 'paste sample placeholder missing');
  for (const line of ['\n  "mcpServers": {', '\n    "flomo": {', '\n      "type": "streamable-http",', '\n        "Authorization": "Bearer 粘贴你的Token"']) {
    assert.ok(placeholder.includes(line), `placeholder must keep 2-space JSON indentation: ${line}`);
  }
  assert.ok(!dialogText.includes('明文会写入 0600 manifest'), 'paste tab must not repeat the plaintext hint');
  assert.ok(!dialogText.includes('单次粘贴上限'), 'paste tab must not show the 2MB hint');
  const replaceGroup = find(dialog, (element) => element.props?.className === 'dim-pasteReplace');
  assert.ok(replaceGroup !== null, 'replace checkbox + hint must be grouped');
  assert.ok(texts(replaceGroup).includes('覆盖已存在的 server'));
  assert.ok(texts(replaceGroup).includes('同名默认跳过（EXISTS）'));
  assert.ok(dialogText.includes('粘贴 mcpServers JSON，可先测试再导入。支持 mcpServers / 裸 map / 单个 server'), 'paste intro must be one paragraph');
  assert.ok(!dialogText.includes('工具调用超时（毫秒）'), 'paste tab must not show a timeout control');
  assert.ok(!dialogText.includes('启用导入的 server'), 'paste tab must not show an enabled control');
  assert.ok(hasClass(dialog, 'dim-formDivider'), 'paste tab needs the form divider');
});

ok('paste tab defaults reset when the dialog is remounted', () => {
  const mutated = render(addDialog.type, addDialog.props, [undefined, '', false, 'paste', 'pasted', true, '', null, false, null, null]);
  assert.equal(find(mutated, (element) => element.type === 'textarea').props.value, 'pasted');

  const fresh = render(addDialog.type, addDialog.props, pasteDefaults);
  assert.equal(find(fresh, (element) => element.type === 'textarea').props.value, '');
});

ok('paste import result shows added list, skipped reasons and warnings', () => {
  const result = {
    added: ['flomo'],
    skipped: [
      { serverName: 'github', reason: 'EXISTS' },
      { serverName: 'bad', reason: 'url 不是合法地址' },
      { serverName: 'flomo', reason: 'EXISTS_HOST_CONFIG' },
    ],
    warnings: ['legacy: type "sse" 已按 streamable-http 处理（旧版 SSE 端点通常兼容）'],
  };
  const dialog = render(addDialog.type, addDialog.props, [undefined, '', false, 'paste', '', false, '', result, false, null, null]);
  const view = findComponent(dialog, 'ImportResultView');
  assert.ok(view !== null, 'ImportResultView missing');
  const resultText = texts(render(view.type, view.props));
  for (const copy of ['已导入 1 个', '已导入：flomo', '跳过 3 个', 'github：已存在', '覆盖已存在的 server', 'bad：url 不是合法地址', 'flomo：与宿主配置同名', '已跳过', '警告：', 'streamable-http']) {
    assert.ok(resultText.includes(copy), `import result missing: ${copy}`);
  }
});

ok('paste importTest result renders per-server results, parseErrors and skipped cap', () => {
  const importTestState = {
    loading: false,
    error: '',
    result: {
      results: [
        { serverName: 'flomo', ok: true, latencyMs: 42, protocolVersion: '2024-11-05', serverInfo: { name: 'flomo', version: '1.0' }, tools: [{ name: 'memo_search', description: '搜索笔记' }] },
        { serverName: 'dead', ok: false, latencyMs: 0, tools: [], error: { code: 'transport', message: 'connect ECONNREFUSED' } },
      ],
      parseErrors: [{ serverName: 'bad', message: 'url 不是合法地址' }],
      skipped: ['s10', 's11'],
    },
  };
  const dialog = render(addDialog.type, addDialog.props, [undefined, '', false, 'paste', '{}', false, '', null, false, null, importTestState]);
  const view = findComponent(dialog, 'ImportTestResult');
  assert.ok(view !== null, 'ImportTestResult missing');
  const viewTree = render(view.type, view.props);
  const text = texts(viewTree);
  for (const copy of ['2 个 server 已测试', '解析错误 1 条', 'bad：url 不是合法地址', 'flomo', '连接成功', 'dead', '传输错误', '一次最多测试前 10 个 server，未测试：s10、s11']) {
    assert.ok(text.includes(copy), `importTest result missing: ${copy}`);
  }
  const perServer = [];
  walk(viewTree, (element) => {
    if (typeof element.type === 'function' && element.type.name === 'TestResult') perServer.push(element);
  });
  assert.equal(perServer.length, 2, 'one probe result per tested server');
  const successText = texts(render(perServer[0].type, perServer[0].props));
  for (const copy of ['连接成功', '42 ms', '2024-11-05', '1 个工具', '工具列表（1）', 'memo_search', '搜索笔记']) {
    assert.ok(successText.includes(copy), `per-server test result missing: ${copy}`);
  }
  const failureText = texts(render(perServer[1].type, perServer[1].props));
  for (const copy of ['传输错误', 'connect ECONNREFUSED']) {
    assert.ok(failureText.includes(copy), `per-server failure result missing: ${copy}`);
  }
});

ok('paste tab surfaces errors and disables buttons while running', () => {
  const errorDialog = render(addDialog.type, addDialog.props, [undefined, '', false, 'paste', '', false, '无法从文本中提取有效的 JSON 对象', null, false, null, null]);
  assert.ok(texts(errorDialog).includes('无法从文本中提取有效的 JSON 对象'));

  const importingDialog = render(addDialog.type, addDialog.props, [undefined, '', false, 'paste', '{}', false, '', null, true, null, null]);
  assert.ok(texts(importingDialog).includes('添加中…'));
  assert.ok(find(importingDialog, (element) => element.props?.disabled === true) !== null, 'import button must be disabled while importing');
});

await okAsync('paste save and importTest send the documented payloads', async () => {
  const rpcCalls = [];
  const captureRpc = async (endpoint, payload) => {
    rpcCalls.push({ endpoint, payload });
    if (endpoint === 'server.import') return { added: ['flomo'], skipped: [], warnings: [] };
    if (endpoint === 'server.importTest') return { results: [], parseErrors: [], skipped: [] };
    return { version: 2, servers: [], status: {} };
  };
  const page = render(pageComponent, { rpc: captureRpc }, listQueue({ kind: 'form', mode: 'add', server: null }));
  const dialogElement = findComponent(page, 'ServerDialog');
  const json = '{"mcpServers":{"flomo":{"url":"https://flomoapp.com/mcp"}}}';

  const saveInstance = createPersistentHarness([...pasteDefaults.slice(0, 4), json, ...pasteDefaults.slice(5)]);
  let tree = saveInstance.mount(dialogElement.type, dialogElement.props);
  buttonByText(tree, '添加 MCP').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const importCall = rpcCalls.find((entry) => entry.endpoint === 'server.import');
  assert.ok(importCall !== undefined, 'server.import not called');
  assert.deepEqual(Object.keys(importCall.payload).sort(), ['json', 'replace'], 'server.import payload must only be {json, replace}');
  assert.equal(importCall.payload.json, json);
  assert.equal(importCall.payload.replace, false);

  rpcCalls.length = 0;
  const testInstance = createPersistentHarness([...pasteDefaults.slice(0, 4), json, false, '', null, false, null, null]);
  tree = testInstance.mount(dialogElement.type, dialogElement.props);
  buttonByText(tree, '测试连接').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const testCall = rpcCalls.find((entry) => entry.endpoint === 'server.importTest');
  assert.ok(testCall !== undefined, 'server.importTest not called');
  assert.deepEqual(Object.keys(testCall.payload), ['json'], 'server.importTest payload must only be {json}');
  assert.equal(testCall.payload.json, json);
});

await okAsync('add mode save omits enabled and toolCallTimeoutMs', async () => {
  const rpcCalls = [];
  const captureRpc = async (endpoint, payload) => {
    rpcCalls.push({ endpoint, payload });
    return { version: 2, servers: [], status: {} };
  };
  const page = render(pageComponent, { rpc: captureRpc }, listQueue({ kind: 'form', mode: 'add', server: null }));
  const dialogElement = findComponent(page, 'ServerDialog');
  const form = {
    serverName: 'flomo', transport: 'streamable-http', url: 'https://flomoapp.com/mcp',
    command: '', argsText: '', cwd: '', env: [], headers: [], toolCallTimeoutMs: '60000', enabled: true,
  };
  const instance = createPersistentHarness([form, '', false]);
  const tree = instance.mount(dialogElement.type, dialogElement.props);
  buttonByText(tree, '添加 MCP').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const call = rpcCalls.find((entry) => entry.endpoint === 'server.add');
  assert.ok(call !== undefined, 'server.add not called');
  assert.equal(call.payload.serverName, 'flomo');
  assert.equal(call.payload.transport, 'streamable-http');
  assert.equal('enabled' in call.payload, false, 'add payload must omit enabled');
  assert.equal('toolCallTimeoutMs' in call.payload, false, 'add payload must omit toolCallTimeoutMs');
  assert.ok(Array.isArray(call.payload.headers), 'http add payload must include headers');
  assert.equal(call.payload.headers.length, 0, 'blank default header row must not enter the payload');
});

await okAsync('manual test button calls server.test with the current form values', async () => {
  const rpcCalls = [];
  const captureRpc = async (endpoint, payload) => {
    rpcCalls.push({ endpoint, payload });
    if (endpoint === 'server.test') return { ok: true, latencyMs: 12, protocolVersion: '2024-11-05', tools: [] };
    return { version: 2, servers: [], status: {} };
  };
  const page = render(pageComponent, { rpc: captureRpc }, listQueue({ kind: 'form', mode: 'add', server: null }));
  const dialogElement = findComponent(page, 'ServerDialog');
  const form = {
    serverName: 'github', transport: 'stdio', url: '', command: 'npx', argsText: '', cwd: '',
    env: [], headers: [], toolCallTimeoutMs: '60000', enabled: true,
  };
  const instance = createPersistentHarness([form, '', false]);
  const tree = instance.mount(dialogElement.type, dialogElement.props);
  buttonByText(tree, '测试连接').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const call = rpcCalls.find((entry) => entry.endpoint === 'server.test');
  assert.ok(call !== undefined, 'server.test not called');
  assert.equal(call.payload.serverName, 'github');
  assert.equal(call.payload.transport, 'stdio');
  assert.equal(call.payload.command, 'npx');
});

// --- connectivity-test result branches -------------------------------------
const testResultElement = find(stdioDetail, (element) => typeof element.type === 'function' && element.type.name === 'TestResult');
assert.ok(testResultElement !== null, 'TestResult was not rendered in the detail page');

ok('test result: pending, success with expandable tools, failure classes', () => {
  const pending = render(testResultElement.type, { testState: null });
  assert.ok(texts(pending).includes('尚未测试'), 'pending copy missing');

  const loading = render(testResultElement.type, { testState: { serverName: 'github', loading: true, result: null, error: '' } });
  assert.ok(texts(loading).includes('正在连接'), 'loading copy missing');

  const successState = {
    serverName: 'github', loading: false, error: '',
    result: {
      ok: true, latencyMs: 42, protocolVersion: '2024-11-05',
      serverInfo: { name: 'demo-server', version: '1.2.3' },
      tools: [{ name: 'tool_a', description: '第一个工具' }, { name: 'tool_b' }],
    },
  };
  const success = render(testResultElement.type, { testState: successState });
  const successText = texts(success);
  for (const copy of ['连接成功', '42 ms', '2024-11-05', '2 个工具', 'demo-server v1.2.3', '工具列表（2）', 'tool_a', '第一个工具', 'tool_b']) {
    assert.ok(successText.includes(copy), `success result missing: ${copy}`);
  }
  assert.ok(find(success, (element) => element.type === 'details') !== null, 'tools must be behind a details element');

  const failureState = {
    serverName: 'github', loading: false, error: '',
    result: { ok: false, error: { code: 'timeout', message: 'timed out after 60000ms' } },
  };
  const failureText = texts(render(testResultElement.type, { testState: failureState }));
  for (const copy of ['超时', 'timeout', 'timed out after 60000ms']) {
    assert.ok(failureText.includes(copy), `failure result missing: ${copy}`);
  }

  const rpcFailureText = texts(render(testResultElement.type, {
    testState: { serverName: 'github', loading: false, result: null, error: 'RPC route not ready' },
  }));
  for (const copy of ['测试失败', 'RPC route not ready']) {
    assert.ok(rpcFailureText.includes(copy), `rpc failure result missing: ${copy}`);
  }
});

console.log(`\nALL RENDER SMOKE CHECKS PASSED (${passed})`);
