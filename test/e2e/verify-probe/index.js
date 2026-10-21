/**
 * dsh-mcp-verify-probe — liveness/teardown probe for install/verify-plugin.sh.
 *
 * It is installed next to dsh-mcp-manager in a throwaway profile and mounted as the
 * last patch row, so the target plugin's apply has completed. It reports, as one
 * `MCP_MANAGER_VERIFY {json}` line:
 *
 *   - whether the target loader entry exists and its fiber is active (apply success);
 *   - the target's registered model-facing tools in the Host-global tool table;
 *   - whether `ctx.loader` exposes the entry (so the check does not depend on the
 *     target plugin's own log wording);
 *   - optionally disposes the target fiber and records whether teardown threw and
 *     whether its tool registrations were unwound.
 *
 * Env:
 *   DSH_VERIFY_TARGET_ID     loader entry id        (default: mcp-manager)
 *   DSH_VERIFY_TARGET_NAME   loader entry name      (default: dsh-mcp-manager)
 *   DSH_VERIFY_TOOL_PREFIX   expected tool prefix   (default: mcp_manager_)
 *   DSH_VERIFY_DISPOSE       "0" to skip disposing  (default: 1)
 *   DSH_VERIFY_OUT           absolute path for the JSON report (optional)
 */
import fs from 'node:fs';
import path from 'node:path';

export const name = 'mcp-verify-probe';
export const inject = ['tools', 'loader', 'clientModules'];

const MARK = 'MCP_MANAGER_VERIFY';
const TARGET_ID = process.env.DSH_VERIFY_TARGET_ID || 'mcp-manager';
const TARGET_NAME = process.env.DSH_VERIFY_TARGET_NAME || 'dsh-mcp-manager';
const TOOL_PREFIX = process.env.DSH_VERIFY_TOOL_PREFIX || 'mcp_manager_';
const SHOULD_DISPOSE = (process.env.DSH_VERIFY_DISPOSE ?? '1') !== '0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function err(e) {
  return { name: e?.name ?? null, message: String(e?.message ?? e) };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function entriesOf(loader) {
  try {
    return [...loader.entries()];
  } catch (e) {
    return { error: err(e) };
  }
}

function findTarget(entries) {
  if (!Array.isArray(entries)) return undefined;
  return entries.find((entry) => entry?.options?.id === TARGET_ID)
    ?? entries.find((entry) => entry?.options?.name === TARGET_NAME);
}

function toolNames(ctx) {
  return ctx.tools.schemas().map((schema) => schema.name);
}

export async function apply(ctx) {
  const out = process.env.DSH_VERIFY_OUT || '';
  const report = {
    probe: 'mcp-manager-verify',
    pid: process.pid,
    node: process.version,
    dshHome: process.env.DSH_HOME ?? null,
    at: new Date().toISOString(),
    target: { id: TARGET_ID, name: TARGET_NAME, toolPrefix: TOOL_PREFIX },
  };
  const flush = () => {
    try {
      if (out) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      }
    } catch (e) {
      console.error('[verify-probe] report write failed:', e);
    }
  };
  const emit = () => {
    flush();
    console.log(`${MARK} ${JSON.stringify(report)}`);
  };

  try {
    // Wait briefly for the loader to settle in case the target row is a sibling
    // that the loader has not finished mounting yet.
    let entries = entriesOf(ctx.loader);
    let target = findTarget(entries);
    for (let attempt = 0; attempt < 40 && (!target || !target.fiber?.uid); attempt += 1) {
      await sleep(50);
      entries = entriesOf(ctx.loader);
      target = findTarget(entries);
    }

    report.loaderAvailable = !Array.isArray(entries) ? false : true;
    report.loaderError = Array.isArray(entries) ? null : entries.error ?? null;
    report.entryCount = Array.isArray(entries) ? entries.length : null;
    report.entries = Array.isArray(entries)
      ? entries.map((entry) => ({
        id: entry?.options?.id ?? null,
        name: entry?.options?.name ?? null,
        active: Boolean(entry?.fiber?.uid),
      }))
      : null;
    report.targetEntryFound = target !== undefined;
    report.targetActive = Boolean(target?.fiber?.uid);

    // Loader startup is not a single serial barrier: bundle rows may still be
    // registering tools after the last patch row's apply. Poll briefly for the
    // target's model-facing tools instead of sampling one instant.
    let before = toolNames(ctx);
    const toolWaitStart = Date.now();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (before.some((name) => name.startsWith(TOOL_PREFIX))) break;
      await sleep(100);
      before = toolNames(ctx);
    }
    report.toolWaitMs = Date.now() - toolWaitStart;
    report.globalToolCount = before.length;
    report.globalTools = before;
    report.targetTools = before.filter((n) => n.startsWith(TOOL_PREFIX));
    report.targetToolCount = report.targetTools.length;

    // Client half discovery: does the Host's boot graph contain this package's
    // `dsh.client` bundle, i.e. would a real browser load lib/client.js? This is
    // what decides whether copying a package into profile/node_modules is a valid
    // install path (vs. needing a profile bundles selection).
    const readClientGraph = () => {
      const graph = ctx.clientModules.graph();
      const ids = (graph?.entries ?? []).map((entry) => entry.id);
      return {
        rev: graph?.rev ?? null,
        release: graph?.release ?? null,
        entryCount: ids.length,
        targetEntry: (graph?.entries ?? []).find((entry) => entry.id === TARGET_NAME) ?? null,
        targetIdPresent: ids.includes(TARGET_NAME),
        ids,
      };
    };
    let clientGraph = null;
    let clientGraphError = null;
    const graphWaitStart = Date.now();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        clientGraph = readClientGraph();
        if (clientGraph.targetIdPresent) break;
      } catch (e) {
        clientGraphError = err(e);
        break;
      }
      await sleep(100);
    }
    report.clientGraphWaitMs = Date.now() - graphWaitStart;
    report.clientGraphError = clientGraphError;
    report.clientGraph = clientGraph
      ? {
        rev: clientGraph.rev,
        release: clientGraph.release,
        entryCount: clientGraph.entryCount,
        targetIdPresent: clientGraph.targetIdPresent,
        targetEntry: clientGraph.targetEntry,
        targetIndex: clientGraph.ids.indexOf(TARGET_NAME),
      }
      : null;
    report.clientEntryPresent = clientGraph?.targetIdPresent === true;
    try {
      report.clientBundlePath = ctx.clientModules.clientPath(TARGET_NAME) ?? null;
    } catch (e) {
      report.clientBundlePathError = err(e);
    }

    try {
      const dshHome = process.env.DSH_HOME;
      report.dshHomeFiles = dshHome
        ? fs.readdirSync(dshHome).filter((f) => fs.statSync(path.join(dshHome, f)).isFile())
        : null;
    } catch (e) {
      report.dshHomeFilesError = err(e);
    }

    if (SHOULD_DISPOSE && target?.fiber) {
      const t0 = Date.now();
      try {
        await withTimeout(Promise.resolve(target.fiber.dispose()), 20_000, 'target.fiber.dispose');
        report.targetDisposeOk = true;
      } catch (e) {
        report.targetDisposeOk = false;
        report.targetDisposeError = err(e);
      }
      report.targetDisposeMs = Date.now() - t0;
      await sleep(100);
      try {
        const after = toolNames(ctx);
        report.globalToolsAfterDispose = after;
        report.targetToolsAfterDispose = after.filter((n) => n.startsWith(TOOL_PREFIX));
        report.targetToolsUnwound = report.targetToolsAfterDispose.length === 0;
        report.otherToolsSurvived = after.some((n) => !n.startsWith(TOOL_PREFIX)) || after.length > 0;
      } catch (e) {
        report.afterDisposeToolsError = err(e);
      }
      try {
        const entryAfter = findTarget(entriesOf(ctx.loader));
        report.targetEntryAfterDispose = entryAfter
          ? { active: Boolean(entryAfter.fiber?.uid), disabled: Boolean(entryAfter.options?.disabled) }
          : null;
      } catch (e) {
        report.entryAfterDisposeError = err(e);
      }
    } else {
      report.targetDisposeOk = null;
    }

    report.complete = true;
  } catch (e) {
    report.fatal = err(e);
    report.complete = false;
  } finally {
    emit();
  }
}
