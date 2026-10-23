/**
 * Browser half of dsh-mcp-manager — native page styled after the built-in
 * Plugins page (same typography, list rows, toolbar and dark-mode tokens).
 *
 * Data/actions use the host-registered same-origin RPC route `/mcp-manager`.
 * Plain ES module (no JSX): the factory receives `require` and builds views
 * with `react.createElement`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const ui = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = react.createElement;
    const { useState, useEffect, useRef } = react;
    const {
      Button,
      Input,
      IconPlusOutlineRegular,
      IconRefreshOutlineRegular,
      IconChevronRightOutlineRegular,
      IconChevronLeftOutlineMedium,
      IconTrashOutlineRegular,
    } = ui;

    const PANEL_ID = 'mcp-manager';
    const RPC_ROUTE = '/mcp-manager';
    const POLL_INTERVAL_MS = 5000;
    const DEFAULT_TIMEOUT_MS = 60000;
    const KV_REFERENCE_HINT = '支持 env:NAME / credential:NAME；明文会写入 0600 manifest；已有行留空保持原值，删除行即删除。';
    const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
    // Exact Claude/Cursor-style sample the user pastes in the wild.
    const IMPORT_EXAMPLE = `{
  "mcpServers": {
    "flomo": {
      "type": "streamable-http",
      "url": "https://flomoapp.com/mcp",
      "headers": {
        "Authorization": "Bearer 粘贴你的Token"
      }
    }
  }
}`;

    const TRANSPORTS = [
      { id: 'stdio', label: 'stdio（本地命令）' },
      { id: 'streamable-http', label: 'streamable-http（HTTP 地址）' },
    ];

    const ERROR_LABELS = {
      timeout: '超时',
      auth: '认证失败',
      transport: '传输错误',
      protocol: '协议错误',
      spawn: '命令启动失败',
      invalid: '配置无效',
      unknown: '未知错误',
    };

    const CSS = `
.dim-page{--dim-space-1:4px;--dim-space-2:8px;--dim-space-3:12px;--dim-space-4:16px;--dim-space-6:24px;--dim-space-8:32px;--dim-space-12:48px;--dim-space-field:14px;box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;align-items:center;gap:var(--dim-space-6);padding:0 clamp(24px,4vw,48px) var(--dim-space-12);overflow:auto;font:var(--dsw-font-s-14)}
.dim-page>*{width:100%;max-width:960px}
.dim-pageHead{box-sizing:border-box;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:var(--dim-space-4);padding-top:var(--dim-space-6)}
[data-platform=darwin] .dim-pageHead,[data-windows-titlebar] .dim-pageHead{padding-top:calc(var(--dim-space-6) + var(--dsh-frame-top-clearance,0px))}
.dim-heading{min-width:0;max-width:100%}
.dim-title{margin:0;font:var(--dsw-font-xl-24);color:var(--dsw-alias-label-primary)}
.dim-intro{color:var(--dsw-alias-label-tertiary);align-items:center;gap:var(--dim-space-1);margin:var(--dim-space-1) 0 0;font:var(--dsw-font-xxs-12);display:flex;flex-wrap:wrap}
.dim-toolbar{white-space:nowrap;flex:none;justify-content:flex-end;align-items:center;gap:var(--dim-space-2);display:flex;flex-wrap:wrap}
.dim-group{flex-direction:column;gap:var(--dim-space-2);display:flex}
.dim-groupHead{align-items:center;gap:var(--dim-space-2);display:flex}
.dim-groupTitle{flex:1;margin:0;font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-secondary)}
.dim-groupCount{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.dim-cards{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}
.dim-card{margin:0 calc(var(--dim-space-2)*-1);border-radius:var(--dsw-radius-xl);min-width:0;transition:background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dim-cardHead{align-items:center;gap:var(--dim-space-3);padding:var(--dim-space-2);display:flex;width:100%;min-width:0;border-radius:var(--dsw-radius-xl)}
.dim-cardOpen{appearance:none;flex:1;min-width:0;align-items:center;gap:var(--dim-space-3);padding:0;display:flex;background:transparent;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dim-cardOpen:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xl)}
.dim-cardIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);width:48px;height:48px;color:var(--dsw-alias-label-secondary);flex:none;justify-content:center;align-items:center;display:inline-flex}
.dim-cardMain{flex-direction:column;flex:1;gap:var(--dim-space-1);min-width:0;display:flex}
.dim-titleRow{flex-wrap:wrap;align-items:center;gap:var(--dim-space-2);min-width:0;display:flex}
.dim-cardTitle{text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary);overflow:hidden}
.dim-cardDesc{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-12)}
.dim-cardMeta{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dim-cardEnd{z-index:1;flex:none;align-items:center;gap:var(--dim-space-2);display:inline-flex;position:relative}
.dim-state{color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;align-items:center;gap:var(--dim-space-1);font:var(--dsw-font-xxs-12);display:inline-flex}
.dim-chevron{color:var(--dsw-alias-label-tertiary);flex:none}
.dim-tag{height:20px;padding:0 var(--dim-space-2);font:var(--dsw-font-xxxs-11);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center}
.dim-tagOk{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 65%,var(--dsw-alias-label-primary))}
.dim-tagWarn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 60%,var(--dsw-alias-label-primary))}
.dim-tagErr{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 70%,var(--dsw-alias-label-primary))}
.dim-empty{color:var(--dsw-alias-label-tertiary);margin:0;padding:var(--dim-space-2) 0;text-align:center;font:var(--dsw-font-xs-13)}
.dim-failure{color:var(--dsw-alias-state-error-primary);align-items:center;gap:var(--dim-space-2);display:flex;font:var(--dsw-font-xs-13);overflow-wrap:anywhere}
.dim-detail{flex-direction:column;display:flex;width:100%}
.dim-detailTop{padding-top:var(--dim-space-6);display:flex;flex-direction:column}
[data-platform=darwin] .dim-detailTop,[data-windows-titlebar] .dim-detailTop{padding-top:calc(var(--dim-space-6) + var(--dsh-frame-top-clearance,0px))}
.dim-crumb{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);cursor:pointer;background:0 0;border:0;align-items:center;gap:var(--dim-space-1);padding:0;display:inline-flex}
.dim-crumb:hover{color:var(--dsw-alias-label-primary)}
.dim-crumb:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.dim-detailHead{justify-content:space-between;align-items:center;gap:var(--dim-space-3);margin:var(--dim-space-8) 0 0;display:flex;flex-wrap:wrap}
.dim-detailHeadMain{align-items:center;gap:var(--dim-space-3);display:flex;min-width:0}
.dim-detailIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);width:40px;height:40px;color:var(--dsw-alias-label-secondary);flex:none;justify-content:center;align-items:center;display:inline-flex}
.dim-detailMain{flex-direction:column;gap:var(--dim-space-2);min-width:0;margin-top:var(--dim-space-4);display:flex}
.dim-detailTitle{margin:0;font:var(--dsw-font-l-20);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dim-detailDesc{color:var(--dsw-alias-label-secondary);margin:0;font:var(--dsw-font-xs-13);overflow-wrap:anywhere}
.dim-detailMeta{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;margin:0;font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default)}
.dim-detailSections{flex-direction:column;gap:var(--dim-space-6);margin-top:var(--dim-space-6);display:flex}
.dim-section{flex-direction:column;gap:var(--dim-space-3);display:flex}
.dim-sectionHead{align-items:baseline;gap:var(--dim-space-3);display:flex;justify-content:space-between}
.dim-sectionTitle{margin:0;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}
.dim-sectionCount{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.dim-sectionHint{color:var(--dsw-alias-label-tertiary);margin:0;font:var(--dsw-font-xxs-12)}
.dim-rows{flex-direction:column;margin:0;padding:0;list-style:none;display:flex}
.dim-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:var(--dim-space-3) 0;display:flex;align-items:center;gap:var(--dim-space-3)}
.dim-row:last-child{border-bottom:0}
.dim-rowIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);width:40px;height:40px;color:var(--dsw-alias-label-secondary);flex:none;justify-content:center;align-items:center;display:inline-flex;font:var(--dsw-font-xs-13)}
.dim-rowMain{flex-direction:column;flex:1;gap:var(--dim-space-1);min-width:0;display:flex}
.dim-rowId{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font:var(--dsw-font-xs-strong-13)}
.dim-rowDesc{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default)}
.dim-rowEnd{z-index:1;flex:none;align-items:center;gap:var(--dim-space-2);display:inline-flex;position:relative}
.dim-dot{width:8px;height:8px;border-radius:50%;corner-shape:round;display:inline-block;flex:none;background:var(--dsw-alias-label-tertiary)}
.dim-dotOk{background:var(--dsw-alias-state-success-primary)}
.dim-dotWarn{background:var(--dsw-alias-state-warn-primary)}
.dim-dotErr{background:var(--dsw-alias-state-error-primary)}
.dim-log{box-sizing:border-box;width:100%;max-height:240px;overflow:auto;margin:0;padding:var(--dim-space-2) var(--dim-space-3);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default);white-space:pre-wrap;word-break:break-word}
.dim-danger{color:var(--dsw-alias-state-error-primary)}
.dim-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-3);display:flex;align-items:center;justify-content:center;z-index:3000;padding:var(--dim-space-6)}
.dim-dialog{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);padding:var(--dim-space-6);width:min(560px,100%);max-height:90vh;overflow:auto;display:flex;flex-direction:column;gap:var(--dim-space-3);box-shadow:var(--dsw-elevation-prominent)}
.dim-dialog:focus{outline:none}
.dim-dialogWide{width:min(680px,100%)}
.dim-dialogHead{display:flex;align-items:center;justify-content:space-between;gap:var(--dim-space-3)}
.dim-dialogTitle{margin:0;font:var(--dsw-font-m-18);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dim-dialogBody{display:flex;flex-direction:column;gap:var(--dim-space-4);min-width:0}
.dim-formBody{display:flex;flex-direction:column;gap:var(--dim-space-4)}
.dim-tabStack{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:1fr}
.dim-tabPanel{grid-area:1/1;min-width:0;display:flex;flex-direction:column;gap:var(--dim-space-field)}
.dim-tabPanelHidden{visibility:hidden;pointer-events:none}
.dim-dialogSettings{display:flex;flex-direction:column;gap:var(--dim-space-3);min-width:0}
.dim-serverFooter{display:flex;justify-content:flex-end;gap:var(--dim-space-2);flex-wrap:wrap;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:var(--dim-space-3)}
.dim-footer{display:flex;justify-content:flex-end;gap:var(--dim-space-2);flex-wrap:wrap}
.dim-field{display:flex;flex-direction:column;gap:var(--dim-space-2);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);min-width:0}
.dim-field > .dim-fieldHint{margin-top:calc(var(--dim-space-1) * -1)}
.dim-fieldHead{display:flex;align-items:center;justify-content:space-between;gap:var(--dim-space-2)}
.dim-fieldHint{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.dim-select{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);height:34px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);padding:0 var(--dim-space-field);transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-field .dim-select{width:100%}
.dim-select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.dim-notice{border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);padding:var(--dim-space-2) var(--dim-space-3);display:flex;align-items:center;gap:var(--dim-space-2);font:var(--dsw-font-xs-13)}
.dim-notice span{flex:1;min-width:0;overflow-wrap:anywhere}
.dim-noticeWarn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-layer-2))}
.dim-switch{box-sizing:border-box;position:relative;flex:none;width:32px;height:18px;border-radius:999px;corner-shape:round;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);cursor:pointer;padding:0;transition:background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-switch::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out),background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dim-switch[aria-checked=true]::after{transform:translateX(14px)}
.dim-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dim-switch:disabled{opacity:.5;cursor:default}
.dim-mono{font-family:var(--dsh-font-family-code-default)}
.dim-infoRow{justify-content:space-between;align-items:flex-start;gap:var(--dim-space-4)}
.dim-infoLabel{color:var(--dsw-alias-label-secondary);flex:none;min-width:96px;font:var(--dsw-font-xxs-12)}
.dim-infoValue{color:var(--dsw-alias-label-primary);text-align:right;overflow-wrap:anywhere;font:var(--dsw-font-xs-13);min-width:0}
.dim-kv{display:flex;flex-direction:column;gap:var(--dim-space-2)}
.dim-kvRow{display:flex;align-items:center;gap:var(--dim-space-2);min-width:0}
.dim-kvRow>*{min-width:0}
.dim-kvRow>*:first-child{flex:0 0 34%}
.dim-kvRow>*:nth-child(2){flex:1}
.dim-kvRow>*:last-child{flex:none}
.dim-textarea{box-sizing:border-box;width:100%;min-height:72px;resize:vertical;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);font-family:var(--dsh-font-family-code-default);padding:var(--dim-space-2) var(--dim-space-field);transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.dim-importTextarea{min-height:160px;white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:auto;font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default)}
.dim-argsTextarea{min-height:64px;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-xs-13);font-family:var(--dsh-font-family-code-default)}
.dim-importList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--dim-space-1);font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dim-tabs{display:flex;gap:var(--dim-space-1);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:var(--dim-space-1);align-self:flex-start}
.dim-tab{background:transparent;border:0;border-radius:var(--dsw-radius-sm);height:30px;padding:0 var(--dim-space-3);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dim-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dim-tabActive{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft)}
.dim-formDivider{border-top:.5px solid var(--dsw-alias-border-l2);margin:0}
.dim-pasteReplace{display:flex;flex-direction:column;gap:var(--dim-space-1)}
.dim-importTestItem{display:flex;flex-direction:column;gap:var(--dim-space-2);padding:var(--dim-space-2) 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dim-importTestItem:last-child{border-bottom:0}
.dim-checkRow{display:flex;align-items:center;gap:var(--dim-space-2);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);cursor:pointer}
.dim-checkRow input{margin:0}
.dim-result{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:var(--dim-space-3);display:flex;flex-direction:column;gap:var(--dim-space-2)}
.dim-resultErr{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1))}
.dim-resultHead{display:flex;flex-wrap:wrap;align-items:center;gap:var(--dim-space-2)}
.dim-resultStats{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);overflow-wrap:anywhere}
.dim-resultMeta{color:var(--dsw-alias-label-tertiary);margin:0;font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default);overflow-wrap:anywhere}
.dim-details{margin-top:var(--dim-space-1)}
.dim-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
.dim-details summary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.dim-tools{list-style:none;margin:var(--dim-space-2) 0 0;padding:0;display:flex;flex-direction:column;gap:var(--dim-space-2);max-height:240px;overflow:auto}
.dim-toolsItem{display:flex;flex-direction:column;gap:var(--dim-space-1);padding:var(--dim-space-1) 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dim-toolsItem:last-child{border-bottom:0}
.dim-toolsName{font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dim-toolsDesc{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dim-formError{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xs-13);margin:0;overflow-wrap:anywhere}
@media (prefers-reduced-motion: reduce){.dim-card,.dim-tab,.dim-switch,.dim-switch::after,.dim-select,.dim-textarea{transition:none}}
`;

    function injectCss() {
      if (typeof document === 'undefined' || document === null) return;
      const id = 'dsh-mcp-manager/client.css';
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-mcp-manager';
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    injectCss();

    function createRpc(connection) {
      return async function rpc(endpoint, payload = {}) {
        const result = await connection.rpc.call(RPC_ROUTE, endpoint, payload);
        if (result === null || typeof result !== 'object') throw new Error('RPC returned no result');
        if (result.ok !== true) {
          const error = new Error(result.error?.message ?? 'RPC failed');
          error.code = result.error?.code;
          throw error;
        }
        return result.value;
      };
    }

    // #region data helpers

    function toEntries(value) {
      if (Array.isArray(value)) {
        return value
          .filter((entry) => entry !== null && typeof entry === 'object')
          .map((entry) => ({ name: String(entry.name ?? ''), value: String(entry.value ?? ''), expression: entry.expression === true }));
      }
      if (value !== null && typeof value === 'object') {
        return Object.entries(value).map(([name, entryValue]) => ({ name, value: String(entryValue ?? ''), expression: false }));
      }
      return [];
    }

    function normalizeServer(raw) {
      if (raw === null || typeof raw !== 'object') return null;
      const serverName = String(raw.serverName ?? '').trim();
      if (serverName === '') return null;
      const transport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
      const timeout = Number(raw.toolCallTimeoutMs);
      const timeoutConfigured = Number.isFinite(timeout) && timeout > 0;
      const source = raw.source === 'host' ? 'host' : 'manager';
      return {
        serverName,
        transport,
        enabled: raw.enabled !== false,
        toolCallTimeoutMs: timeoutConfigured ? Math.floor(timeout) : DEFAULT_TIMEOUT_MS,
        timeoutConfigured,
        url: typeof raw.url === 'string' ? raw.url : '',
        headers: toEntries(raw.headers),
        command: typeof raw.command === 'string' ? raw.command : '',
        args: Array.isArray(raw.args) ? raw.args.map((entry) => String(entry)) : [],
        env: toEntries(raw.env),
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        // Host-configured MCP rows are merged into `state.servers` read-only.
        source,
        readOnly: raw.readOnly === true || source === 'host',
        entryId: typeof raw.entryId === 'string' ? raw.entryId : '',
        active: raw.active !== false,
        disabled: raw.disabled === true || raw.hostDisabled === true,
        scope: raw.scope === 'preset' ? 'preset' : 'profile',
        conflict: raw.conflict === 'host' ? 'host' : '',
      };
    }

    const REFERENCE_ERROR_MESSAGES = {
      CREDENTIAL_MISSING: 'credential 引用缺少对应凭据；请检查宿主的凭据配置。',
      CREDENTIAL_UNAVAILABLE: 'credential 提供方不可用；请检查宿主凭据服务。',
      CREDENTIAL_RESOLVE_FAILED: 'credential 解析失败；请检查宿主凭据配置。',
      ENV_MISSING: '环境变量缺失；请检查宿主环境变量。',
    };

    function referenceErrorText(cause) {
      const code = typeof cause?.code === 'string' ? cause.code : '';
      if (REFERENCE_ERROR_MESSAGES[code] !== undefined) return REFERENCE_ERROR_MESSAGES[code];
      return typeof cause?.message === 'string' ? cause.message : String(cause);
    }

    // Mount `lastError` is a free-form string with no code field.
    function referenceTextHint(text) {
      if (typeof text !== 'string' || text === '') return '';
      const lower = text.toLowerCase();
      if (lower.includes('credential')) return 'credential 引用不可用；请检查宿主的凭据配置。';
      if (lower.includes('environment variable')) return '环境变量缺失；请检查宿主环境变量。';
      return '';
    }

    function mountErrorText(text) {
      if (typeof text !== 'string') return '';
      if (REFERENCE_ERROR_MESSAGES[text] !== undefined) return REFERENCE_ERROR_MESSAGES[text];
      const hint = referenceTextHint(text);
      return hint !== '' ? `${hint}（${text}）` : text;
    }

    function normalizeState(value) {
      const servers = Array.isArray(value?.servers) ? value.servers.map(normalizeServer).filter(Boolean) : [];
      const status = value?.status !== null && typeof value?.status === 'object' ? value.status : {};
      const stateLoadError = typeof value?.loadError === 'string' ? value.loadError : '';
      const warnings = Array.isArray(value?.warnings) ? value.warnings.map((entry) => String(entry)) : [];
      return { version: value?.version ?? 2, servers, status, stateLoadError, warnings };
    }

    function statusOf(statusMap, serverName) {
      const raw = statusMap !== null && typeof statusMap === 'object' ? statusMap[serverName] : null;
      const mounted = raw?.mounted === true;
      const count = Number(raw?.toolCount);
      const toolCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
      const lastError = typeof raw?.lastError === 'string' && raw.lastError.trim() !== '' ? raw.lastError : '';
      return { mounted, toolCount, lastError };
    }

    function statusView(server, statusMap) {
      const status = statusOf(statusMap, server.serverName);
      if (server.readOnly) {
        // Host-configured rows are mounted by DSH itself: `active` drives the
        // dot, `disabled` (or enabled:false) means the config row is off.
        if (server.disabled === true || server.enabled === false) return { ...status, label: '停用', dot: 'dim-dot' };
        if (status.lastError !== '' && server.conflict !== 'host') return { ...status, label: '错误', dot: 'dim-dot dim-dotErr' };
        if (server.active !== false) return { ...status, label: '已连接', dot: 'dim-dot dim-dotOk' };
        return { ...status, label: '未挂载', dot: 'dim-dot dim-dotWarn' };
      }
      if (!server.enabled) return { ...status, label: '停用', dot: 'dim-dot' };
      if (status.lastError !== '') return { ...status, label: '错误', dot: 'dim-dot dim-dotErr' };
      if (status.mounted && status.toolCount > 0) return { ...status, label: '已连接', dot: 'dim-dot dim-dotOk' };
      if (status.mounted) return { ...status, label: '已挂载未连接', dot: 'dim-dot dim-dotWarn' };
      return { ...status, label: '未挂载', dot: 'dim-dot' };
    }

    function serverTarget(server) {
      if (server.transport === 'streamable-http') return server.url !== '' ? server.url : '（未填写 MCP 地址）';
      const parts = [server.command, ...server.args].filter((part) => part !== '');
      return parts.length > 0 ? parts.join(' ') : '（未填写命令）';
    }

    function errorLabel(code) {
      if (typeof code !== 'string' || code === '') return ERROR_LABELS.unknown;
      return ERROR_LABELS[code] ?? ERROR_LABELS.unknown;
    }

    function formatLatency(value) {
      const latency = Number(value);
      if (!Number.isFinite(latency) || latency < 0) return '—';
      return `${Math.round(latency)} ms`;
    }

    function normalizeImportResult(value) {
      const added = Array.isArray(value?.added) ? value.added.map((entry) => String(entry)) : [];
      const skipped = Array.isArray(value?.skipped)
        ? value.skipped
          .filter((entry) => entry !== null && typeof entry === 'object')
          .map((entry) => ({ serverName: String(entry.serverName ?? ''), reason: String(entry.reason ?? '') }))
        : [];
      const warnings = Array.isArray(value?.warnings) ? value.warnings.map((entry) => String(entry)) : [];
      return { added, skipped, warnings };
    }

    function cleanEntries(rows) {
      return rows
        .filter((row) => row.name.trim() !== '')
        .map((row) => ({ name: row.name.trim(), value: row.value }));
    }

    // #endregion

    function Tag({ children, tone }) {
      const cls = tone === 'ok' ? ' dim-tagOk' : tone === 'err' ? ' dim-tagErr' : tone === 'warn' ? ' dim-tagWarn' : '';
      return h('span', { className: `dim-tag${cls}` }, children);
    }

    function StateLabel({ status }) {
      return h('span', { className: 'dim-state' },
        h('span', { className: status.dot, 'aria-hidden': 'true' }),
        h('span', { className: 'dim-stateText' }, status.label));
    }

    // Stable, unique id so each dialog can point `aria-labelledby` at its title.
    let dialogTitleSeq = 0;
    const FOCUSABLE_SELECTOR = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

    function Dialog({ title, onClose, children, rect, wide, className }) {
      const dialogRef = useRef(null);
      const titleIdRef = useRef(null);
      if (titleIdRef.current === null) {
        dialogTitleSeq += 1;
        titleIdRef.current = `dim-dialog-title-${dialogTitleSeq}`;
      }
      // Keep the latest onClose without re-running the focus effect on every render.
      const closeRef = useRef(onClose);
      closeRef.current = onClose;
      useEffect(() => {
        const node = dialogRef.current;
        if (node === null) return undefined;
        const previous = typeof document !== 'undefined' ? document.activeElement : null;
        const focusables = () => Array.from(node.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => element.getClientRects().length > 0);
        const first = focusables()[0];
        if (first !== undefined) first.focus();
        else node.focus();
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeRef.current();
            return;
          }
          if (event.key !== 'Tab') return;
          const items = focusables();
          if (items.length === 0) {
            event.preventDefault();
            node.focus();
            return;
          }
          const firstItem = items[0];
          const lastItem = items[items.length - 1];
          if (event.shiftKey && (document.activeElement === firstItem || document.activeElement === node)) {
            event.preventDefault();
            lastItem.focus();
          } else if (!event.shiftKey && document.activeElement === lastItem) {
            event.preventDefault();
            firstItem.focus();
          }
        };
        node.addEventListener('keydown', onKeyDown);
        return () => {
          node.removeEventListener('keydown', onKeyDown);
          if (previous !== null && typeof previous.focus === 'function') previous.focus();
        };
      }, []);
      return h('div', {
        className: 'dim-overlay',
        style: rect === null || rect === undefined
          ? null
          : {
            left: `${Math.max(0, rect.left)}px`,
            top: `${Math.max(0, rect.top)}px`,
            width: `${Math.max(0, rect.width)}px`,
            height: `${Math.max(0, rect.height)}px`,
            right: 'auto',
            bottom: 'auto',
            maxWidth: 'none',
            boxSizing: 'border-box',
          },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
      }, h('div', {
        ref: dialogRef,
        tabIndex: -1,
        className: `dim-dialog${wide ? ' dim-dialogWide' : ''}${className ? ` ${className}` : ''}`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleIdRef.current,
      },
      h('div', { className: 'dim-dialogHead' },
        h('h3', { id: titleIdRef.current, className: 'dim-dialogTitle' }, title),
        h(Button, { variant: 'outline', size: 'sm', onClick: onClose }, '关闭'),
      ),
      children,
      ));
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'dim-field' },
        h('span', null, label),
        children,
        hint ? h('span', { className: 'dim-fieldHint' }, hint) : null);
    }

    function InfoRow({ label, value, mono }) {
      return h('li', { className: 'dim-row dim-infoRow' },
        h('span', { className: 'dim-infoLabel' }, label),
        h('span', { className: `dim-infoValue${mono ? ' dim-mono' : ''}` }, value));
    }

    function KvEditor({ label, hint, rows, onChange, keyPlaceholder, valuePlaceholder }) {
      const update = (index, patch) => onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
      const remove = (index) => onChange(rows.filter((row, position) => position !== index));
      const add = () => onChange([...rows, { name: '', value: '' }]);
      const placeholderFor = (row) => (typeof valuePlaceholder === 'function' ? valuePlaceholder(row) : valuePlaceholder);
      return h('div', { className: 'dim-field' },
        h('div', { className: 'dim-fieldHead' },
          h('span', null, label),
          h(Button, { variant: 'outline', size: 'sm', onClick: add }, '添加一行')),
        rows.length > 0
          ? h('div', { className: 'dim-kv' }, ...rows.map((row, index) => h('div', { key: index, className: 'dim-kvRow' },
            h(Input, {
              value: row.name,
              placeholder: keyPlaceholder,
              onChange: (event) => update(index, { name: event.target.value }),
            }),
            h(Input, {
              value: row.value,
              placeholder: placeholderFor(row),
              onChange: (event) => update(index, { value: event.target.value }),
            }),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => remove(index) }, '删除'),
          )))
          : h('p', { className: 'dim-empty' }, '尚未添加。'),
        hint ? h('span', { className: 'dim-fieldHint' }, hint) : null);
    }

    function McpIcon({ size = 16 }) {
      // lucide "plug" — used by the sidebar entry, list rows and detail card.
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
      h('path', { d: 'M12 22v-5' }),
      h('path', { d: 'M9 8V2' }),
      h('path', { d: 'M15 8V2' }),
      h('path', { d: 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z' }));
    }

    function validateForm(form) {
      const serverName = form.serverName.trim();
      if (serverName === '') return '请填写服务器名称。';
      if (!SERVER_NAME_PATTERN.test(serverName)) return '服务器名称只能使用字母、数字、下划线或短横线，长度 1–32（它会成为工具名前缀 mcp__name__ 的一部分）。';
      if (form.transport === 'streamable-http') {
        const url = form.url.trim();
        if (url === '') return '请填写 MCP 地址。';
        if (!/^https?:\/\//i.test(url)) return 'MCP 地址需要以 http:// 或 https:// 开头。';
      } else if (form.command.trim() === '') {
        return '请填写要执行的命令（例如 npx）。';
      }
      const timeout = form.toolCallTimeoutMs.trim();
      if (timeout !== '' && (!/^\d+$/.test(timeout) || Number(timeout) <= 0)) return '工具调用超时需要是正整数毫秒值。';
      const entryLabel = form.transport === 'stdio' ? '环境变量' : '请求头';
      const entryRows = form.transport === 'stdio' ? form.env : form.headers;
      for (const row of entryRows) {
        if (row.name.trim() === '') continue;
        if (row.value === '' && row.existing !== true) {
          return `新增的${entryLabel}「${row.name.trim()}」需要填写值（可用 env:NAME / credential:NAME 引用）。`;
        }
      }
      return '';
    }

    function formToInput(form) {
      const transport = form.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
      const timeout = form.toolCallTimeoutMs.trim();
      const input = {
        serverName: form.serverName.trim(),
        transport,
        enabled: form.enabled === true,
        toolCallTimeoutMs: timeout === '' ? DEFAULT_TIMEOUT_MS : Number(timeout),
      };
      if (transport === 'stdio') {
        input.command = form.command.trim();
        input.args = form.argsText.split('\n').map((line) => line.trim()).filter((line) => line !== '');
        input.cwd = form.cwd.trim();
        input.env = cleanEntries(form.env);
        // Keep the persisted spec complete when switching transports.
        input.url = '';
        input.headers = [];
      } else {
        input.url = form.url.trim();
        input.headers = cleanEntries(form.headers);
        input.command = '';
        input.args = [];
        input.env = [];
        input.cwd = '';
      }
      return input;
    }

    function initialForm(mode, server) {
      return {
        serverName: server?.serverName ?? '',
        transport: server === null || server === undefined
          ? 'streamable-http'
          : (server.transport === 'streamable-http' ? 'streamable-http' : 'stdio'),
        url: server?.url ?? '',
        command: server?.command ?? '',
        argsText: (server?.args ?? []).join('\n'),
        cwd: server?.cwd ?? '',
        env: (server?.env ?? []).map((entry) => ({ name: entry.name, value: entry.value, existing: true })),
        headers: (server?.headers ?? []).map((entry) => ({ name: entry.name, value: entry.value, existing: true })),
        toolCallTimeoutMs: server !== null && server !== undefined ? String(server.toolCallTimeoutMs) : String(DEFAULT_TIMEOUT_MS),
        enabled: server === null || server === undefined ? true : server.enabled !== false,
      };
    }

    function ServerDialog({ mode, server, busy, onClose, onSubmit, onImport, onTest, onImportTest, rect }) {
      const [form, setForm] = useState(() => initialForm(mode, server));
      const [error, setError] = useState('');
      const [saving, setSaving] = useState(false);
      const [tab, setTab] = useState('manual');
      const [text, setText] = useState('');
      const [replace, setReplace] = useState(false);
      const [pasteError, setPasteError] = useState('');
      const [pasteResult, setPasteResult] = useState(null);
      const [importing, setImporting] = useState(false);
      const [manualTest, setManualTest] = useState(null);
      const [importTest, setImportTest] = useState(null);

      const editing = mode === 'edit';
      const activeTab = editing ? 'manual' : tab;
      const field = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
      // Map the current validation message back to the control that owns it so the
      // invalid field can expose `aria-invalid` (SPEC 表单规则).
      const invalidField = error === ''
        ? ''
        : (error.includes('服务器名称') ? 'serverName'
          : error.includes('MCP 地址') ? 'url'
            : error.includes('请填写要执行的命令') ? 'command'
              : error.includes('工具调用超时') ? 'toolCallTimeoutMs'
                : '');
      const submitManual = async () => {
        const message = validateForm(form);
        if (message !== '') {
          setError(message);
          return;
        }
        setError('');
        setSaving(true);
        try {
          const payload = formToInput(form);
          if (!editing) {
            // Add mode uses host defaults (enabled:true, 60000ms).
            delete payload.enabled;
            delete payload.toolCallTimeoutMs;
          }
          await onSubmit(payload);
        } catch (cause) {
          setError(cause.code === 'EXISTS_HOST_CONFIG'
            ? 'DSH 宿主已配置同名 MCP，无需重复添加，可在列表里直接查看宿主配置。'
            : referenceErrorText(cause));
          setSaving(false);
        }
      };

      const submitPaste = async () => {
        if (text.trim() === '') {
          setPasteError('请先粘贴 JSON 配置。');
          return;
        }
        setPasteError('');
        setImporting(true);
        try {
          const value = await onImport(text, { replace: replace === true });
          setPasteResult(value);
          setText('');
        } catch (cause) {
          setPasteError(referenceErrorText(cause));
        } finally {
          setImporting(false);
        }
      };

      const runManualTest = async () => {
        const message = validateForm(form);
        if (message !== '') {
          setManualTest({ loading: false, result: null, error: message });
          return;
        }
        setManualTest({ loading: true, result: null, error: '' });
        try {
          const result = await onTest(formToInput(form));
          setManualTest({ loading: false, result: result ?? null, error: '' });
        } catch (cause) {
          setManualTest({ loading: false, result: null, error: referenceErrorText(cause) });
        }
      };

      const runImportTest = async () => {
        if (text.trim() === '') {
          setImportTest({ loading: false, result: null, error: '请先粘贴 JSON 配置。' });
          return;
        }
        setImportTest({ loading: true, result: null, error: '' });
        try {
          const result = await onImportTest(text);
          setImportTest({ loading: false, result: result ?? null, error: '' });
        } catch (cause) {
          setImportTest({ loading: false, result: null, error: referenceErrorText(cause) });
        }
      };

      const manualConfig = [
        h(Field, {
          key: 'name',
          label: '服务器名称',
          hint: editing ? '不可改名。' : '会成为工具名前缀 mcp__name__；字母、数字、_、-，1–32 字符。',
        }, h(Input, {
          value: form.serverName,
          disabled: editing,
          placeholder: 'github',
          'aria-invalid': invalidField === 'serverName' ? true : undefined,
          onChange: (event) => field('serverName', event.target.value),
        })),
        h(Field, { key: 'transport', label: '传输方式' }, h('select', {
          className: 'dim-select',
          value: form.transport,
          onChange: (event) => field('transport', event.target.value),
        }, ...TRANSPORTS.map((transport) => h('option', { key: transport.id, value: transport.id }, transport.label)))),
        form.transport === 'stdio'
          ? h('div', { key: 'stdio', className: 'dim-field' },
            h('div', { className: 'dim-notice dim-noticeWarn' }, h('span', null, 'stdio 会执行你填写的命令，请只添加可信来源。')),
            h(Field, { label: '命令' }, h(Input, {
              value: form.command,
              placeholder: 'npx',
              'aria-invalid': invalidField === 'command' ? true : undefined,
              onChange: (event) => field('command', event.target.value),
            })),
            h(Field, { label: '参数（每行一个）' }, h('textarea', {
              className: 'dim-textarea dim-argsTextarea',
              rows: 3,
              value: form.argsText,
              placeholder: '-y\n@modelcontextprotocol/server-github',
              onChange: (event) => field('argsText', event.target.value),
            })),
            h(Field, { label: '工作目录（可选）', hint: '留空继承宿主工作目录。' }, h(Input, {
              value: form.cwd,
              placeholder: '/Users/you/project',
              onChange: (event) => field('cwd', event.target.value),
            })),
            h(KvEditor, {
              label: '环境变量',
              rows: form.env,
              onChange: (rows) => field('env', rows),
              keyPlaceholder: 'GITHUB_TOKEN',
              valuePlaceholder: 'env:GITHUB_TOKEN',
              hint: KV_REFERENCE_HINT,
            }),
          )
          : h('div', { key: 'http', className: 'dim-field' },
            h(Field, { label: 'MCP 地址', hint: '例如 https://mcp.example.com/mcp。' }, h(Input, {
              value: form.url,
              placeholder: 'https://mcp.unifuncs.com/mcp',
              'aria-invalid': invalidField === 'url' ? true : undefined,
              onChange: (event) => field('url', event.target.value),
            })),
            h(KvEditor, {
              label: '请求头',
              rows: form.headers.length > 0 ? form.headers : [{ name: '', value: '' }],
              onChange: (rows) => field('headers', rows),
              keyPlaceholder: 'Authorization',
              valuePlaceholder: 'env:MCP_API_KEY',
            }),
          ),
      ];

      const pasteConfig = [
        h('p', { key: 'pasteIntro', className: 'dim-fieldHint' }, '粘贴 mcpServers JSON，可先测试再导入。支持 mcpServers / 裸 map / 单个 server；http、sse 按 streamable-http 处理；缺省按 command/url 推断。'),
        h('textarea', {
          key: 'pasteText',
          className: 'dim-textarea dim-importTextarea',
          rows: 8,
          spellCheck: false,
          value: text,
          placeholder: IMPORT_EXAMPLE,
          'aria-invalid': pasteError !== '' ? true : undefined,
          onChange: (event) => setText(event.target.value),
        }),
        h('div', { key: 'replace', className: 'dim-pasteReplace' },
          h('label', { className: 'dim-checkRow' },
            h('input', {
              type: 'checkbox',
              checked: replace,
              onChange: (event) => setReplace(event.target.checked),
            }),
            '覆盖已存在的 server'),
          h('p', { className: 'dim-fieldHint' }, '同名默认跳过（EXISTS）；勾选后覆盖已有配置。')),
      ];

      const settingsSection = activeTab === 'manual'
        ? [
          ...(editing ? [
            h(Field, { key: 'timeout', label: '工具调用超时（毫秒）', hint: '默认 60000；长任务可调大。' }, h(Input, {
              type: 'number',
              value: form.toolCallTimeoutMs,
              placeholder: String(DEFAULT_TIMEOUT_MS),
              'aria-invalid': invalidField === 'toolCallTimeoutMs' ? true : undefined,
              onChange: (event) => field('toolCallTimeoutMs', event.target.value),
            })),
            h('label', { key: 'enabled', className: 'dim-checkRow' },
              h('input', {
                type: 'checkbox',
                checked: form.enabled,
                onChange: (event) => field('enabled', event.target.checked),
              }),
              '启用该 server'),
          ] : []),
          h('div', { key: 'test', className: 'dim-section' },
            h('div', { className: 'dim-sectionHead' },
              h('span', { className: 'dim-fieldHint' }, '测试当前表单，不保存。'),
              h(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: manualTest?.loading === true,
                onClick: () => void runManualTest(),
              }, manualTest?.loading === true ? '测试中…' : '测试连接')),
            h(TestResult, { testState: manualTest }),
          ),
        ]
        : [
          h('div', { key: 'importTest', className: 'dim-section' },
            h('div', { className: 'dim-sectionHead' },
              h('span', { className: 'dim-fieldHint' }, '逐个测试，不保存；stdio 会真实启动命令。'),
              h(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: importTest?.loading === true,
                onClick: () => void runImportTest(),
              }, importTest?.loading === true ? '测试中…' : '测试连接')),
            h(ImportTestResult, { testState: importTest }),
          ),
        ];

      const dialogError = activeTab === 'manual' ? error : pasteError;

      return h(Dialog, { title: editing ? `编辑 ${server?.serverName ?? ''}` : '添加 MCP', onClose, rect, wide: true, className: 'dim-dialogForm' },
        h('div', { className: 'dim-dialogBody' },
          !editing
            ? h('div', { className: 'dim-tabs' },
              h('button', {
                type: 'button',
                className: `dim-tab${activeTab === 'manual' ? ' dim-tabActive' : ''}`,
                onClick: () => setTab('manual'),
              }, '手动配置'),
              h('button', {
                type: 'button',
                className: `dim-tab${activeTab === 'paste' ? ' dim-tabActive' : ''}`,
                onClick: () => setTab('paste'),
              }, '代码粘贴'))
            : null,
          h('div', { className: 'dim-formBody' },
            h('div', { className: 'dim-tabStack' },
              h('div', { className: `dim-tabPanel${activeTab === 'manual' ? '' : ' dim-tabPanelHidden'}` },
                editing ? h('p', { key: 'editHint', className: 'dim-fieldHint' }, '保存后会重新挂载该 server。') : null,
                ...manualConfig),
              editing
                ? null
                : h('div', { className: `dim-tabPanel${activeTab === 'paste' ? '' : ' dim-tabPanelHidden'}` }, ...pasteConfig)),
            h('div', { className: 'dim-formDivider' }),
            h('div', { className: 'dim-dialogSettings' },
              h('h3', { className: 'dim-sectionTitle' }, '连接测试'),
              ...settingsSection)),
          dialogError !== '' ? h('p', { className: 'dim-formError', role: 'alert' }, dialogError) : null,
          activeTab === 'paste' && pasteResult !== null ? h(ImportResultView, { result: pasteResult }) : null,
          h('div', { className: 'dim-serverFooter' },
            h(Button, { variant: 'outline', size: 'sm', onClick: onClose }, '取消'),
            activeTab === 'manual'
              ? h(Button, { variant: 'primary', size: 'sm', disabled: busy || saving, onClick: () => void submitManual() }, saving ? '保存中…' : (editing ? '保存修改' : '添加 MCP'))
              : h(Button, { variant: 'primary', size: 'sm', disabled: importing, onClick: () => void submitPaste() }, importing ? '添加中…' : '添加 MCP')),
        ));
    }

    function RemoveDialog({ server, onClose, onConfirm, rect }) {
      const [error, setError] = useState('');
      const [working, setWorking] = useState(false);
      const submit = async () => {
        setError('');
        setWorking(true);
        try {
          await onConfirm(server.serverName);
        } catch (cause) {
          setError(cause.message);
          setWorking(false);
        }
      };
      return h(Dialog, { title: '删除 MCP server', onClose, rect },
        h('p', { className: 'dim-empty' }, `删除「${server.serverName}」后，它会立即从宿主卸载，工具不再对任何会话可见。manifest 中的这一条会被移除，此操作不可撤销。`),
        error !== '' ? h('p', { className: 'dim-formError', role: 'alert' }, error) : null,
        h('div', { className: 'dim-footer' },
          h(Button, { variant: 'outline', size: 'sm', onClick: onClose }, '取消'),
          h(Button, {
            variant: 'primary',
            size: 'sm',
            className: 'dim-danger',
            icon: h(IconTrashOutlineRegular, { size: 13, 'aria-hidden': 'true' }),
            disabled: working,
            onClick: () => void submit(),
          }, working ? '删除中…' : '删除'),
        ));
    }

    function skippedReasonLabel(reason) {
      if (reason === 'EXISTS') return '已存在（勾选“覆盖已存在的 server”后可重新导入）';
      if (reason === 'EXISTS_HOST_CONFIG') return '与宿主配置同名，已跳过（可在列表里直接查看宿主配置）';
      return reason !== '' ? reason : '未说明原因';
    }

    // `skipped[].reason` is either the exact code EXISTS or a full error
    // message. Field-mapping errors already carry "<serverName>: ...", so do
    // not prepend the name twice; validation errors carry it separately.
    function skippedReasonText(entry) {
      const reason = skippedReasonLabel(entry.reason);
      if (entry.serverName === '') return reason;
      if (reason.startsWith(`${entry.serverName}:`) || reason.startsWith(`${entry.serverName}：`)) return reason;
      return `${entry.serverName}：${reason}`;
    }

    function ImportResultView({ result }) {
      const added = Array.isArray(result?.added) ? result.added : [];
      const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      return h('div', { className: 'dim-result', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'dim-resultHead' },
          h(Tag, { tone: added.length > 0 ? 'ok' : 'warn' }, added.length > 0 ? `已导入 ${added.length} 个` : '没有导入新 server'),
          skipped.length > 0 ? h('span', { className: 'dim-resultStats' }, `跳过 ${skipped.length} 个`) : null),
        added.length > 0 ? h('p', { className: 'dim-resultMeta' }, `已导入：${added.join('、')}`) : null,
        skipped.length > 0
          ? h('ul', { className: 'dim-importList' }, ...skipped.map((entry, index) => h('li', { key: `${entry.serverName}:${index}` },
            skippedReasonText(entry))))
          : null,
        warnings.length > 0
          ? h('div', { className: 'dim-notice dim-noticeWarn' }, h('span', null, `警告：${warnings.join('；')}`))
          : null);
    }

    function TestResult({ testState }) {
      if (testState === null) return h('p', { className: 'dim-empty' }, '尚未测试。测试会新建一次连接，不影响已挂载的连接。');
      if (testState.loading) return h('p', { className: 'dim-empty', role: 'status', 'aria-live': 'polite' }, '正在连接… stdio 会真实启动命令，可能需要几秒。');
      if (testState.error !== '') return h('div', { className: 'dim-result dim-resultErr', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'dim-resultHead' }, h(Tag, { tone: 'err' }, '测试失败'), h('span', { className: 'dim-resultStats' }, 'RPC 请求失败')),
        h('p', { className: 'dim-failure' }, testState.error));
      const result = testState.result;
      if (result === null || typeof result !== 'object') return h('p', { className: 'dim-empty' }, '测试没有返回结果。');
      if (result.ok === true) {
        const tools = Array.isArray(result.tools) ? result.tools : [];
        const info = result.serverInfo ?? null;
        return h('div', { className: 'dim-result', role: 'status', 'aria-live': 'polite' },
          h('div', { className: 'dim-resultHead' },
            h(Tag, { tone: 'ok' }, '连接成功'),
            h('span', { className: 'dim-resultStats' }, `延迟 ${formatLatency(result.latencyMs)} · 协议 ${typeof result.protocolVersion === 'string' && result.protocolVersion !== '' ? result.protocolVersion : '未知'} · ${tools.length} 个工具`)),
          info !== null && typeof info === 'object'
            ? h('p', { className: 'dim-resultMeta' }, `server: ${String(info.name ?? '未知')}${typeof info.version === 'string' && info.version !== '' ? ` v${info.version}` : ''}`)
            : null,
          tools.length === 0
            ? h('p', { className: 'dim-empty' }, '服务端没有返回工具。')
            : h('details', { className: 'dim-details' },
              h('summary', null, `工具列表（${tools.length}）`),
              h('ul', { className: 'dim-tools' }, ...tools.map((tool, index) => h('li', { key: `${String(tool?.name ?? index)}:${index}`, className: 'dim-toolsItem' },
                h('span', { className: 'dim-toolsName' }, String(tool?.name ?? '')),
                typeof tool?.description === 'string' && tool.description !== ''
                  ? h('span', { className: 'dim-toolsDesc' }, tool.description)
                  : null,
              )))),
        );
      }
      const failure = result.error !== null && typeof result.error === 'object' ? result.error : {};
      return h('div', { className: 'dim-result dim-resultErr', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'dim-resultHead' },
          h(Tag, { tone: 'err' }, errorLabel(failure.code)),
          h('span', { className: 'dim-resultStats' }, typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'unknown')),
        h('p', { className: 'dim-failure' }, typeof failure.message === 'string' && failure.message !== '' ? failure.message : '未知错误'));
    }

    function ImportTestResult({ testState }) {
      if (testState === null) return h('p', { className: 'dim-empty' }, '尚未测试。测试不会保存配置。');
      if (testState.loading) return h('p', { className: 'dim-empty', role: 'status', 'aria-live': 'polite' }, '正在逐个连接粘贴配置中的 server…');
      if (testState.error !== '') return h('div', { className: 'dim-result dim-resultErr', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'dim-resultHead' }, h(Tag, { tone: 'err' }, '测试失败')),
        h('p', { className: 'dim-failure' }, testState.error));
      const value = testState.result;
      if (value === null || typeof value !== 'object') return h('p', { className: 'dim-empty' }, '测试没有返回结果。');
      const results = Array.isArray(value.results) ? value.results : [];
      const parseErrors = Array.isArray(value.parseErrors)
        ? value.parseErrors.map((entry) => (entry !== null && typeof entry === 'object' ? entry : { message: String(entry) }))
        : [];
      // importTest caps at 10 servers: `skipped` is the list of tested-out names.
      const skipped = Array.isArray(value.skipped) ? value.skipped.map((entry) => String(entry)) : [];
      return h('div', { className: 'dim-result', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'dim-resultHead' },
          h(Tag, { tone: results.length > 0 ? 'ok' : 'warn' }, `${results.length} 个 server 已测试`),
          parseErrors.length > 0 ? h(Tag, { tone: 'err' }, `解析错误 ${parseErrors.length} 条`) : null),
        parseErrors.length > 0
          ? h('ul', { className: 'dim-importList' }, ...parseErrors.map((entry, index) => h('li', { key: `parse:${index}` },
            `${String(entry.serverName ?? '') !== '' ? `${String(entry.serverName)}：` : ''}${String(entry.message ?? '未知解析错误')}`)))
          : null,
        skipped.length > 0
          ? h('p', { className: 'dim-fieldHint' }, `一次最多测试前 10 个 server，未测试：${skipped.join('、')}`)
          : null,
        ...results.map((entry, index) => h('div', { key: `${String(entry?.serverName ?? index)}:${index}`, className: 'dim-importTestItem' },
          h('div', { className: 'dim-titleRow' },
            h('span', { className: 'dim-rowId' }, String(entry?.serverName ?? `server ${index + 1}`)),
            entry?.ok === true ? h(Tag, { tone: 'ok' }, '连接成功') : h(Tag, { tone: 'err' }, errorLabel(entry?.error?.code))),
          h(TestResult, { testState: { loading: false, result: entry ?? null, error: '' } }))),
      );
    }

    function McpManagerPage({ rpc }) {
      const [snapshot, setSnapshot] = useState(null);
      const [loadError, setLoadError] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      const [view, setView] = useState('list');
      const [selectedName, setSelectedName] = useState(null);
      const [modal, setModal] = useState(null);
      const [testState, setTestState] = useState(null);
      const modalRef = useRef(false);
      const pageRef = useRef(null);
      const [panelRect, setPanelRect] = useState(null);
      modalRef.current = modal !== null;

      const loadState = async (options = {}) => {
        try {
          const value = await rpc('state');
          setSnapshot(normalizeState(value));
          setLoadError('');
          return value;
        } catch (cause) {
          if (!options.silent) setLoadError(cause.message);
          return null;
        }
      };

      const applyStatus = async () => {
        try {
          const result = await rpc('status');
          if (result !== null && typeof result === 'object' && result.status !== null && typeof result.status === 'object') {
            setSnapshot((previous) => (previous === null ? previous : { ...previous, status: result.status }));
          }
        } catch {
          // Best effort: the next `state` poll repairs the dots.
        }
      };

      const refreshAll = async () => {
        setBusy('refresh');
        setError('');
        try {
          await loadState();
        } finally {
          setBusy('');
        }
      };

      useEffect(() => {
        void loadState();
        const timer = setInterval(() => {
          if (!modalRef.current) void loadState({ silent: true });
        }, POLL_INTERVAL_MS);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      useEffect(() => {
        if (modal === null) {
          setPanelRect(null);
          return undefined;
        }
        let frame = null;
        let settle = null;
        const measure = () => {
          const rect = pageRef.current?.getBoundingClientRect();
          if (rect !== undefined && rect !== null && rect.width > 0 && rect.height > 0) {
            setPanelRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
          }
        };
        measure();
        frame = requestAnimationFrame(() => {
          measure();
          // The first modal render can precede flex/scroll settling after a
          // list→detail transition; measure once more after layout.
          settle = setTimeout(measure, 120);
        });
        let observer = null;
        if (typeof ResizeObserver !== 'undefined' && pageRef.current !== null) {
          observer = new ResizeObserver(measure);
          observer.observe(pageRef.current);
        }
        const onScroll = () => measure();
        window.addEventListener('resize', onScroll);
        window.addEventListener('scroll', onScroll, true);
        return () => {
          if (frame !== null) cancelAnimationFrame(frame);
          if (settle !== null) clearTimeout(settle);
          if (observer !== null) observer.disconnect();
          window.removeEventListener('resize', onScroll);
          window.removeEventListener('scroll', onScroll, true);
        };
      }, [modal]);

      useEffect(() => {
        setTestState(null);
      }, [selectedName]);

      useEffect(() => {
        if (view !== 'detail' || snapshot === null || selectedName === null) return;
        if (!snapshot.servers.some((server) => server.serverName === selectedName)) {
          setView('list');
          setSelectedName(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [view, snapshot, selectedName]);

      const openEditor = (server) => {
        setModal({ kind: 'form', mode: server === null ? 'add' : 'edit', server });
      };

      const importServers = async (json, options = {}) => {
        const payload = { json, replace: options.replace === true };
        const result = await rpc('server.import', payload);
        await loadState({ silent: true });
        return normalizeImportResult(result);
      };

      const importTestServers = async (json) => rpc('server.importTest', { json });

      const testFormServer = async (input) => rpc('server.test', input);

      const closeImport = () => {
        setModal(null);
        void loadState({ silent: true });
      };

      const saveServer = async (payload) => {
        const editing = modal?.kind === 'form' && modal.mode === 'edit';
        setBusy('save');
        setError('');
        try {
          await rpc(editing ? 'server.update' : 'server.add', payload);
          await loadState();
          setModal(null);
          setTestState(null);
          setSelectedName(payload.serverName);
          setView('detail');
          setNotice(editing ? `已保存 ${payload.serverName}` : `已添加 ${payload.serverName}`);
        } finally {
          setBusy('');
        }
      };

      const toggleEnabled = async (server, enabled) => {
        const key = `toggle:${server.serverName}`;
        setBusy(key);
        setError('');
        setNotice('');
        try {
          await rpc('server.toggle', { serverName: server.serverName, enabled });
          await applyStatus();
          await loadState();
          setNotice(`${server.serverName} 已${enabled ? '启用' : '停用'}`);
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy('');
        }
      };

      const removeServer = async (serverName) => {
        await rpc('server.remove', { serverName });
        setSelectedName((current) => (current === serverName ? null : current));
        setView('list');
        await loadState();
        setModal(null);
        setNotice(`已删除 ${serverName}`);
      };

      const runTest = async (server) => {
        setTestState({ serverName: server.serverName, loading: true, result: null, error: '' });
        try {
          // Always test the saved config (plaintext or env:/credential: references).
          const result = await rpc('server.test', { serverName: server.serverName });
          setTestState({ serverName: server.serverName, loading: false, result: result ?? null, error: '' });
          await applyStatus();
        } catch (cause) {
          setTestState({ serverName: server.serverName, loading: false, result: null, error: cause.message });
        }
      };

      if (snapshot === null) {
        return h('div', { className: 'dim-page', ref: pageRef },
          h('div', { className: 'dim-pageHead' },
            h('div', { className: 'dim-heading' },
              h('h1', { className: 'dim-title' }, 'MCP'),
              h('p', { className: 'dim-intro' }, '正在读取 MCP 配置与挂载状态…'),
            ),
          ),
          h('p', { className: 'dim-empty' }, loadError !== '' ? `读取失败：${loadError}` : ''));
      }

      const servers = snapshot.servers;
      const connectedCount = servers.filter((server) => statusView(server, snapshot.status).label === '已连接').length;
      const enabledCount = servers.filter((server) => server.enabled).length;
      const selectedServer = selectedName === null ? null : (servers.find((server) => server.serverName === selectedName) ?? null);

      const banner = error !== ''
        ? h('div', { className: 'dim-notice', role: 'status', 'aria-live': 'polite' }, h('span', null, error), h(Button, { variant: 'outline', size: 'sm', onClick: () => setError('') }, '关闭'))
        : loadError !== ''
          ? h('div', { className: 'dim-notice', role: 'status', 'aria-live': 'polite' }, h('span', null, loadError), h(Button, { variant: 'outline', size: 'sm', onClick: () => setLoadError('') }, '关闭'))
          : notice !== ''
            ? h('div', { className: 'dim-notice', role: 'status', 'aria-live': 'polite' }, h('span', null, notice), h(Button, { variant: 'outline', size: 'sm', onClick: () => setNotice('') }, '关闭'))
            : null;

      const hostWarning = typeof snapshot.stateLoadError === 'string' && snapshot.stateLoadError !== ''
        ? h('div', { className: 'dim-notice dim-noticeWarn', role: 'status', 'aria-live': 'polite' }, h('span', null, `manifest 读取失败：${snapshot.stateLoadError}`))
        : Array.isArray(snapshot.warnings) && snapshot.warnings.length > 0
          ? h('div', { className: 'dim-notice dim-noticeWarn', role: 'status', 'aria-live': 'polite' }, h('span', null, `manifest 有 ${snapshot.warnings.length} 条警告：${snapshot.warnings.slice(0, 3).join('；')}${snapshot.warnings.length > 3 ? '…' : ''}`))
          : null;

      const modalLayer = [
        modal?.kind === 'form'
          ? h(ServerDialog, {
            key: 'server-form',
            mode: modal.mode,
            server: modal.mode === 'edit' ? (modal.server ?? null) : null,
            busy: busy === 'save',
            rect: panelRect,
            onClose: () => setModal(null),
            onSubmit: saveServer,
            onImport: importServers,
            onTest: testFormServer,
            onImportTest: importTestServers,
          })
          : null,
        modal?.kind === 'remove' && modal.server !== null
          ? h(RemoveDialog, {
            key: 'server-remove',
            server: modal.server,
            rect: panelRect,
            onClose: () => setModal(null),
            onConfirm: removeServer,
          })
          : null,
      ];

      const pageHead = h('div', { className: 'dim-pageHead' },
        h('div', { className: 'dim-heading' },
          h('h1', { className: 'dim-title' }, 'MCP'),
          h('p', { className: 'dim-intro' }, `管理当前 profile 的 MCP server · ${servers.length} 个 server · ${enabledCount} 个启用 · ${connectedCount} 个已连接`),
        ),
        h('div', { className: 'dim-toolbar' },
          h(Button, {
            variant: 'outline',
            size: 'sm',
            icon: h(IconRefreshOutlineRegular, { size: 13, 'aria-hidden': 'true' }),
            disabled: busy === 'refresh',
            onClick: () => void refreshAll(),
          }, busy === 'refresh' ? '刷新中…' : '刷新'),
          h(Button, {
            variant: 'primary',
            size: 'sm',
            icon: h(IconPlusOutlineRegular, { size: 13, 'aria-hidden': 'true' }),
            onClick: () => openEditor(null),
          }, '添加 MCP'),
        ));

      if (view === 'detail' && selectedServer !== null) {
        const server = selectedServer;
        const status = statusView(server, snapshot.status);
        const readOnly = server.readOnly === true;
        const entries = server.transport === 'stdio' ? server.env : server.headers;
        const entriesTitle = server.transport === 'stdio' ? '环境变量' : '请求头';
        const detailTest = testState !== null && testState.serverName === server.serverName ? testState : null;
        const hostNotice = server.conflict === 'host'
          ? `与 DSH 宿主配置重名（entry ${server.entryId !== '' ? server.entryId : '未知'}），manager 项未重复挂载；当前实际运行的是宿主配置，连接信息请到 DSH 的 cordis.patch.yml 修改。如需改用 manager 侧配置，请先在 cordis.patch.yml 停用同名宿主行。`
          : (readOnly
            ? `此 MCP 来自 DSH 宿主配置（${server.entryId !== '' ? server.entryId : '未知 entry'}），请到 DSH 的 cordis.patch.yml 修改。`
            : '');
        const enabledValue = readOnly
          ? (server.disabled || !server.enabled ? '已停用（宿主配置）' : (server.active ? '已启用（宿主配置）' : '未启用（宿主配置）'))
          : (server.enabled ? '已启用' : '已停用');
        const overviewRows = [
          readOnly
            ? h(InfoRow, { key: 'source', label: '来源', value: `DSH 宿主配置（${server.scope}）` })
            : null,
          readOnly
            ? h(InfoRow, { key: 'entryId', label: 'entryId', value: server.entryId !== '' ? server.entryId : '（未提供）', mono: true })
            : null,
          h(InfoRow, { key: 'transport', label: '传输方式', value: server.transport }),
          h(InfoRow, { key: 'target', label: '目标', value: serverTarget(server), mono: true }),
          h(InfoRow, { key: 'tools', label: '工具数', value: `${status.toolCount} 个` }),
          h(InfoRow, { key: 'timeout', label: '工具调用超时', value: server.timeoutConfigured !== false ? `${server.toolCallTimeoutMs} ms` : '宿主默认' }),
          h(InfoRow, { key: 'enabled', label: '启用状态', value: enabledValue }),
          server.transport === 'stdio'
            ? h(InfoRow, { key: 'cwd', label: '工作目录', value: server.cwd !== '' ? server.cwd : '（继承宿主进程）', mono: server.cwd !== '' })
            : null,
        ].filter(Boolean);

        return h('div', { className: 'dim-page dim-detail', ref: pageRef },
          h('div', { className: 'dim-detailTop' },
            h('button', { className: 'dim-crumb', onClick: () => { setView('list'); setSelectedName(null); } },
              h(IconChevronLeftOutlineMedium, { size: 14, 'aria-hidden': 'true' }), ' MCP'),
          ),
          banner,
          hostWarning,
          h('div', { className: 'dim-detailHead' },
            h('div', { className: 'dim-detailHeadMain' },
              h('span', { className: 'dim-detailIcon' }, h(McpIcon, { size: 18 })),
              h('h1', { className: 'dim-detailTitle' }, server.serverName),
            ),
            readOnly
              ? null
              : h('div', { className: 'dim-toolbar' },
                h(Button, { variant: 'outline', size: 'sm', onClick: () => openEditor(server) }, '编辑'),
                h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  disabled: busy === `toggle:${server.serverName}`,
                  onClick: () => void toggleEnabled(server, !server.enabled),
                }, busy === `toggle:${server.serverName}` ? '处理中…' : (server.enabled ? '停用' : '启用')),
                h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  className: 'dim-danger',
                  icon: h(IconTrashOutlineRegular, { size: 13, 'aria-hidden': 'true' }),
                  onClick: () => setModal({ kind: 'remove', server }),
                }, '删除'),
              ),
          ),
          h('div', { className: 'dim-detailMain' },
            h('p', { className: 'dim-detailDesc' }, serverTarget(server)),
            h('div', { className: 'dim-titleRow' },
              h(StateLabel, { status }),
              h(Tag, null, server.transport),
              server.source === 'host' ? h(Tag, null, '来自 DSH 配置') : null,
              server.scope === 'preset' ? h(Tag, null, 'Preset') : null,
              server.conflict === 'host' ? h(Tag, { tone: 'warn' }, '与宿主配置重名') : null,
              h(Tag, null, `${status.toolCount} 个工具`)),
            h('p', { className: 'dim-detailMeta' }, server.conflict === 'host'
              ? `宿主配置运行中 · ${server.scope} · ${server.active ? 'active' : 'inactive'}`
              : (readOnly
                ? `DSH 宿主配置 · ${server.scope} · ${server.active ? 'active' : 'inactive'}`
                : `超时 ${server.toolCallTimeoutMs} ms · ${server.enabled ? '已启用' : '已停用'}`)),
            status.lastError !== '' && server.conflict !== 'host' ? h('p', { className: 'dim-failure' }, mountErrorText(status.lastError)) : null,
            hostNotice !== '' ? h('div', { className: 'dim-notice dim-noticeWarn' }, h('span', null, hostNotice)) : null,
          ),
          h('div', { className: 'dim-detailSections' },
            h('div', { className: 'dim-section' },
              h('div', { className: 'dim-sectionHead' }, h('h3', { className: 'dim-sectionTitle' }, '概览')),
              h('ul', { className: 'dim-rows' }, ...overviewRows),
            ),
            h('div', { className: 'dim-section' },
              h('div', { className: 'dim-sectionHead' },
                h('h3', { className: 'dim-sectionTitle' }, entriesTitle),
                h('span', { className: 'dim-sectionCount' }, entries.length === 0 ? '未配置' : `${entries.length} 项`),
              ),
              entries.length === 0
                ? h('p', { className: 'dim-empty' }, server.transport === 'stdio' ? '没有配置环境变量。' : '没有配置请求头。')
                : h('ul', { className: 'dim-rows' }, ...entries.map((entry, index) => h('li', { key: `${entry.name}:${index}`, className: 'dim-row dim-infoRow' },
                  h('span', { className: 'dim-infoLabel dim-mono' }, entry.name),
                  h('span', { className: 'dim-infoValue dim-mono' }, entry.value,
                    entry.expression ? h(Tag, { tone: 'warn' }, '表达式，未求值') : null),
                ))),
            ),
            h('div', { className: 'dim-section' },
              h('div', { className: 'dim-sectionHead' },
                h('h3', { className: 'dim-sectionTitle' }, '连通性测试'),
                h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  disabled: detailTest?.loading === true,
                  onClick: () => void runTest(server),
                }, detailTest?.loading === true ? '测试中…' : '测试连接'),
              ),
              h('p', { className: 'dim-sectionHint' }, server.transport === 'stdio'
                ? '测试会真实启动 command（等价于在本机执行该命令），只用于验证握手与工具列表。'
                : '会用当前配置发起一次 MCP 握手并拉取工具列表，不改动已挂载的连接。'),
              h(TestResult, { testState: detailTest }),
            ),
          ),
          modalLayer,
        );
      }

      const renderServerRow = (server) => {
        const status = statusView(server, snapshot.status);
        const key = `toggle:${server.serverName}`;
        const open = () => {
          setSelectedName(server.serverName);
          setView('detail');
        };
        return h('li', { key: server.serverName, className: 'dim-card' },
          h('div', { className: 'dim-cardHead' },
            h('button', { type: 'button', className: 'dim-cardOpen', onClick: open },
              h('span', { className: 'dim-cardIcon', 'aria-hidden': 'true' }, h(McpIcon, { size: 22 })),
              h('span', { className: 'dim-cardMain' },
                h('span', { className: 'dim-titleRow' },
                  h('span', { className: 'dim-cardTitle' }, server.serverName),
                  h(StateLabel, { status }),
                  h(Tag, null, server.transport),
                  server.source === 'host' ? h(Tag, null, '来自 DSH 配置') : null,
                  server.scope === 'preset' ? h(Tag, null, 'Preset') : null,
                  server.conflict === 'host' ? h(Tag, { tone: 'warn' }, '与宿主配置重名，未重复挂载') : null,
                  h(Tag, null, `${status.toolCount} 个工具`)),
                h('span', { className: 'dim-cardDesc' }, serverTarget(server)),
                status.lastError !== '' && server.conflict !== 'host'
                  ? h('span', { className: 'dim-cardMeta dim-danger' }, mountErrorText(status.lastError))
                  : h('span', { className: 'dim-cardMeta' }, server.conflict === 'host'
                    ? `宿主配置运行中 · ${server.scope} · ${server.active ? '已启用' : '未启用'}`
                    : (server.readOnly
                      ? `DSH 宿主配置 · ${server.scope} · ${server.active ? '已启用' : '未启用'}`
                      : `超时 ${server.toolCallTimeoutMs} ms · ${server.enabled ? '已启用' : '已停用'}`)))),
            h('span', { className: 'dim-cardEnd' },
              server.readOnly
                ? null
                : h('button', {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': server.enabled,
                  'aria-label': `启用 ${server.serverName}`,
                  title: server.enabled ? '停用' : '启用',
                  className: 'dim-switch',
                  disabled: busy === key,
                  onClick: (event) => {
                    event.stopPropagation();
                    void toggleEnabled(server, !server.enabled);
                  },
                }),
              h(IconChevronRightOutlineRegular, { size: 16, className: 'dim-chevron', 'aria-hidden': 'true' }))),
        );
      };

      return h('div', { className: 'dim-page', ref: pageRef },
        pageHead,
        banner,
        hostWarning,
        h('div', { className: 'dim-group' },
          h('div', { className: 'dim-groupHead' },
            h('h3', { className: 'dim-groupTitle' }, 'MCP Server'),
            h('span', { className: 'dim-groupCount' }, `${servers.length} 个`),
          ),
          servers.length === 0
            ? h('p', { className: 'dim-empty' }, '还没有 MCP server。点右上角「添加 MCP」开始。')
            : h('ul', { className: 'dim-cards' }, ...servers.map(renderServerRow)),
        ),
        modalLayer,
      );
    }

    const inject = ['slots', 'connection'];

    async function apply(ctx) {
      const rpc = createRpc(ctx.connection);
      const Page = () => h(McpManagerPage, { rpc });

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => 'MCP' }, McpIcon));
      ctx.slots.inject('main', function* registerMain() {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID }, Page);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
