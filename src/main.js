import './style.css';
import { bitable } from '@lark-base-open/js-sdk';
import {
  parseDomainFromReferrer,
  parseRawDomain,
  listTables,
  getTableFields,
  getAllRecords,
  generateLinks,
} from './widget.js';

let tableSel, targetSel, sourceSel, previewSel, domainBox, domainInput, startBtn, refreshBtn;
let rangeSeg, recListBox, recSearch, recList, recSelCount, recAllBtn, recNoneBtn;
let skipBox, resultCard, modalMask, modalBody, modalOk, modalCancel, toastHost;
let state = {
  domain: 'www.feishu.cn',
  tables: [],
  table: null,
  tableId: null,
  fieldMetas: [],
  records: [],
  ready: false,
  mode: 'all', // 'all' | 'selected'
  selected: new Set(),
  previewFieldId: '',
  searchTerm: '',
  skipExisting: true,
  generated: new Set(), // 已成功写入的 recordId，用于列表标记
  linksMap: [], // [{recordId, link}]
};

const CFG_KEY = 'feishu_rowlink_cfg_v1';
const CFG_VERSION = 1; // 配置结构版本，schema 变更时 +1 使旧配置失效

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (v == null) return;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'checked') node.checked = true;
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null || c === false) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function log(msg, type = 'info') {
  const box = document.getElementById('log');
  if (!box) return;
  box.appendChild(el('div', { class: 'log-line ' + type }, msg));
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  const box = document.getElementById('log');
  if (box) box.innerHTML = '';
}

function setProgress(done, total) {
  const p = document.getElementById('progress');
  const bar = document.getElementById('bar');
  if (!p || !bar) return;
  p.style.display = 'block';
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = pct + '%';
  bar.textContent = `${done} / ${total}`;
}

function showToast(msg, type = 'info') {
  // 优先用飞书原生 toast，失败则用自定义 toast
  try {
    if (bitable && bitable.ui && bitable.ui.toast) {
      bitable.ui.toast(msg);
      return;
    }
  } catch (e) {
    /* 回退自定义 toast */
  }
  if (!toastHost) return;
  const colors = { ok: '#2ea121', warn: '#d97700', error: '#e5484d', info: '#3370ff' };
  const t = el('div', { class: 'toast toast-' + type }, msg);
  t.style.borderLeftColor = colors[type] || colors.info;
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2800);
}

function fieldValueToText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v) && v.length) {
    const first = v[0];
    if (first && (first.text || first.name || first.link || first.title))
      return String(first.text || first.name || first.link || first.title);
    return '';
  }
  return '';
}

function previewOf(rec) {
  const f = (rec && rec.fields) || {};
  if (state.previewFieldId && f[state.previewFieldId] != null) {
    const t = fieldValueToText(f[state.previewFieldId]);
    if (t) return t;
  }
  for (const meta of state.fieldMetas) {
    const t = fieldValueToText(f[meta.id]);
    if (t) return t;
  }
  return rec && rec.recordId ? String(rec.recordId) : '(空行)';
}

const BRAND_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="2" y="2" width="20" height="20" rx="6" fill="#ffffff"/><g fill="none" stroke="#3370ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></g></svg>';

function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-mark', html: BRAND_SVG }),
      el('div', { class: 'brand-text' }, [
        el('h1', {}, '记录链接生成器'),
        el('p', { class: 'sub' }, '为多维表行生成可点击的记录链接，写回指定列。'),
      ]),
    ]),
    el('div', { class: 'body' }, [
      el('div', { id: 'status', class: 'status' }, '正在初始化…'),

      el('div', { class: 'field' }, [
        el('label', {}, '数据表'),
        (tableSel = el('select', { id: 'tableField' }, [
          el('option', { value: '' }, '正在加载数据表…'),
        ])),
      ]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [
          el('label', {}, '目标字段（须为「超链接」类型）'),
          (targetSel = el('select', { id: 'targetField' }, [
            el('option', { value: '' }, '请选择字段…'),
          ])),
        ]),
        el('div', { class: 'field' }, [
          el('label', {}, '源字段（可选）'),
          (sourceSel = el('select', { id: 'sourceField' }, [
            el('option', { value: '' }, '（全部行）'),
          ])),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', {}, '预览字段（列表行显示内容）'),
        (previewSel = el('select', { id: 'previewField' }, [
          el('option', { value: '' }, '自动：首个有内容字段'),
        ])),
      ]),

      el('div', { class: 'field' }, [
        el('label', {}, '转换范围'),
        (rangeSeg = el('div', { class: 'segment' }, [
          el('button', { class: 'seg-btn active', 'data-mode': 'all' }, '全部行'),
          el('button', { class: 'seg-btn', 'data-mode': 'selected' }, '仅选中行'),
        ])),
      ]),

      (recListBox = el(
        'div',
        { id: 'recListBox', class: 'rec-list-box', style: 'display:none' },
        [
          el('div', { class: 'rec-head' }, [
            (recSelCount = el('span', { class: 'rec-count' }, '已选 0 / 0 条')),
            el('div', { class: 'rec-actions' }, [
              (recAllBtn = el('button', { class: 'link-btn' }, '全选')),
              (recNoneBtn = el('button', { class: 'link-btn' }, '清空')),
            ]),
          ]),
          (recSearch = el('input', {
            type: 'text',
            class: 'rec-search',
            placeholder: '搜索记录…',
          })),
          (recList = el('div', { class: 'rec-list' })),
        ]
      )),

      el('label', { class: 'check-line' }, [
        (skipBox = el('input', { type: 'checkbox', id: 'skipExisting', checked: 'checked' })),
        el('span', {}, '跳过已生成的行（避免重复覆盖，推荐）'),
      ]),

      (domainBox = el(
        'div',
        { id: 'domainBox', class: 'field domainBox', style: 'display:none' },
        [
          el('label', {}, '未识别到飞书域名，请填写（如 www.feishu.cn）'),
          (domainInput = el('input', {
            id: 'domainInput',
            type: 'text',
            placeholder: 'www.feishu.cn',
          })),
        ]
      )),

      el('div', { class: 'actions' }, [
        (startBtn = el('button', { id: 'start', class: 'primary' }, '开始生成')),
        (refreshBtn = el('button', { id: 'refresh', class: 'ghost' }, '刷新')),
      ]),

      el('div', { class: 'progress', id: 'progress', style: 'display:none' }, [
        el('div', { class: 'bar', id: 'bar' }, ''),
      ]),
      el('div', { class: 'log', id: 'log' }),
      (resultCard = el('div', { id: 'resultCard', class: 'result-card', style: 'display:none' })),
      el('div', { class: 'footer' }, [
        '目标字段用「超链接」类型，链接才会显示为蓝色可点击。',
      ]),
    ]),
  ]);
  app.appendChild(card);

  // 确认弹窗 + toast 宿主挂到 body，避免被卡片 overflow 裁剪
  modalMask = el('div', { class: 'modal-mask', id: 'modalMask', style: 'display:none' }, [
    el('div', { class: 'modal' }, [
      el('div', { class: 'modal-title' }, '确认生成记录链接'),
      (modalBody = el('div', { class: 'modal-body' })),
      el('div', { class: 'modal-actions' }, [
        (modalCancel = el('button', { class: 'ghost' }, '取消')),
        (modalOk = el('button', { class: 'primary' }, '确认生成')),
      ]),
    ]),
  ]);
  document.body.appendChild(modalMask);
  toastHost = el('div', { class: 'toast-host', id: 'toastHost' });
  document.body.appendChild(toastHost);

  tableSel.addEventListener('change', async () => {
    if (tableSel.value) {
      await selectTable(tableSel.value);
      saveCfg();
    }
  });
  startBtn.addEventListener('click', onStart);
  refreshBtn.addEventListener('click', () => init(true));
  rangeSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => setMode(b.getAttribute('data-mode')));
  });
  recAllBtn.addEventListener('click', () => {
    state.selected = new Set(state.records.map((r) => r.recordId));
    syncListChecks();
    updateSelCount();
  });
  recNoneBtn.addEventListener('click', () => {
    state.selected.clear();
    syncListChecks();
    updateSelCount();
  });
  recSearch.addEventListener('input', () => {
    state.searchTerm = recSearch.value.trim().toLowerCase();
    renderRecordList();
  });
  previewSel.addEventListener('change', () => {
    state.previewFieldId = previewSel.value;
    renderRecordList();
    saveCfg();
  });
  skipBox.addEventListener('change', () => {
    state.skipExisting = skipBox.checked;
    saveCfg();
  });
  modalCancel.addEventListener('click', hideModal);
  modalOk.addEventListener('click', () => {
    const fn = modalOk._onOk;
    hideModal();
    if (fn) fn();
  });
}

function setMode(mode) {
  state.mode = mode;
  rangeSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode);
  });
  recListBox.style.display = mode === 'selected' ? 'block' : 'none';
  if (mode === 'selected') renderRecordList();
  else updateSelCount();
  saveCfg();
}

function renderRecordList() {
  recList.innerHTML = '';
  if (!state.records.length) {
    recList.appendChild(
      el('div', { class: 'rec-empty', html: EMPTY_SVG('当前数据表没有任何记录') })
    );
    updateSelCount();
    return;
  }
  const term = state.searchTerm;
  let shown = 0;
  state.records.forEach((rec, i) => {
    const text = previewOf(rec);
    if (term && !text.toLowerCase().includes(term)) return;
    shown++;
    const id = rec.recordId;
    const done = state.generated.has(id);
    const item = el('label', { class: 'rec-item' + (done ? ' done' : '') }, [
      el('input', { type: 'checkbox', class: 'rec-check', 'data-id': id }),
      el('span', { class: 'rec-idx' }, String(i + 1)),
      el('span', { class: 'rec-text' }, text),
      done ? el('span', { class: 'rec-done-tag', html: CHECK_SVG }) : null,
    ]);
    const cb = item.querySelector('input');
    cb.checked = state.selected.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateSelCount();
    });
    recList.appendChild(item);
  });
  if (shown === 0 && term) {
    recList.appendChild(
      el('div', { class: 'rec-empty', html: EMPTY_SVG('没有匹配的记录') })
    );
  }
  updateSelCount();
}

function syncListChecks() {
  recList.querySelectorAll('.rec-check').forEach((cb) => {
    cb.checked = state.selected.has(cb.getAttribute('data-id'));
  });
}

function updateSelCount() {
  const n = state.selected.size;
  const total = state.records.length;
  if (recSelCount) recSelCount.textContent = `已选 ${n} / ${total} 条`;
  if (startBtn)
    startBtn.textContent =
      state.mode === 'selected' ? `开始生成（${n} 条）` : '开始生成';
}

function fillFieldOptions() {
  targetSel.innerHTML = '';
  sourceSel.innerHTML = '';
  previewSel.innerHTML = '';
  targetSel.appendChild(el('option', { value: '' }, '请选择字段…'));
  sourceSel.appendChild(el('option', { value: '' }, '（全部行）'));
  previewSel.appendChild(el('option', { value: '' }, '自动：首个有内容字段'));
  state.fieldMetas.forEach((f) => {
    targetSel.appendChild(el('option', { value: f.id }, f.name));
    sourceSel.appendChild(el('option', { value: f.id }, f.name));
    previewSel.appendChild(el('option', { value: f.id }, f.name));
  });
}

function applyCfgToControls(cfg) {
  if (!cfg) return;
  const metaIds = new Set(state.fieldMetas.map((f) => f.id));
  const has = (id) => id && metaIds.has(id);
  if (cfg.targetFieldId && has(cfg.targetFieldId)) targetSel.value = cfg.targetFieldId;
  else if (cfg.targetFieldId)
    log('已保存的目标字段不存在（可能已改名/删除），已忽略。', 'warn');
  if (cfg.sourceFieldId && has(cfg.sourceFieldId)) sourceSel.value = cfg.sourceFieldId;
  else if (cfg.sourceFieldId)
    log('已保存的源字段不存在（可能已改名/删除），已忽略。', 'warn');
  if (cfg.previewFieldId != null && has(cfg.previewFieldId)) {
    previewSel.value = cfg.previewFieldId;
    state.previewFieldId = cfg.previewFieldId;
  } else if (cfg.previewFieldId != null) {
    log('已保存的预览字段不存在（可能已改名/删除），已忽略。', 'warn');
  }
  if (cfg.mode) setMode(cfg.mode);
  if (typeof cfg.skipExisting === 'boolean') {
    state.skipExisting = cfg.skipExisting;
    skipBox.checked = cfg.skipExisting;
  }
}

function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    if (!obj || obj.version !== CFG_VERSION) return null; // 版本不符（或旧无版本）直接忽略
    return obj;
  } catch (e) {
    return null;
  }
}

function saveCfg() {
  try {
    const cfg = {
      version: CFG_VERSION,
      tableId: state.tableId,
      targetFieldId: targetSel.value,
      sourceFieldId: sourceSel.value,
      previewFieldId: previewSel.value,
      mode: state.mode,
      skipExisting: skipBox.checked,
    };
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch (e) {
    /* localStorage 不可用时忽略 */
  }
}

async function selectTable(tableId) {
  const table = await bitable.base.getTable(tableId);
  state.table = table;
  state.tableId = tableId;
  const metas = await getTableFields(table);
  state.fieldMetas = metas;
  fillFieldOptions();
  state.records = await getAllRecords(table);
  state.selected = new Set();
  state.generated = new Set();
  if (state.mode === 'selected') renderRecordList();
  else updateSelCount();
  const info = state.tables.find((t) => t.id === tableId);
  document.getElementById('status').textContent =
    `当前数据表：${info ? info.name : table.name || table.id} ｜ ${
      state.records.length
    } 行 ｜ ${metas.length} 字段`;
}

async function init(refresh = false) {
  applyTheme();
  const detected = parseDomainFromReferrer();
  if (detected && /feishu|larksuite/.test(detected)) {
    state.domain = detected;
    domainBox.style.display = 'none';
    log(`已识别飞书域名：${detected}`, 'ok');
  } else {
    domainBox.style.display = 'block';
    log('未能识别飞书域名，请在上方手动填写（如 www.feishu.cn）。', 'warn');
  }

  try {
    const tables = await listTables();
    state.tables = tables;
    tableSel.innerHTML = '';
    if (!tables.length) {
      tableSel.appendChild(el('option', { value: '' }, '（无可用数据表）'));
      document.getElementById('status').textContent = '未检测到数据表';
      document.getElementById('status').className = 'status warn';
      return;
    }
    tables.forEach((t) =>
      tableSel.appendChild(el('option', { value: t.id }, t.name))
    );

    const cfg = loadCfg();
    let activeId = null;
    if (cfg && tables.find((t) => t.id === cfg.tableId)) activeId = cfg.tableId;
    else {
      const active = await bitable.base.getActiveTable();
      if (active && tables.find((t) => t.id === active.id)) activeId = active.id;
    }
    if (!activeId) activeId = tables[0].id;

    tableSel.value = activeId;
    await selectTable(activeId);
    applyCfgToControls(cfg);
    log(
      `已加载数据表：${tables.map((t) => t.name).join('、') || '（无）'}`,
      'ok'
    );
    state.ready = true;
  } catch (e) {
    const s = document.getElementById('status');
    s.textContent = '初始化失败';
    s.className = 'status warn';
    log(
      '无法访问多维表，请在飞书多维表「自定义组件」中添加本插件后使用。错误：' +
        (e && e.message ? e.message : e),
      'error'
    );
  }
}

function showModal(infoHtml, onOk) {
  modalBody.innerHTML = infoHtml;
  modalOk._onOk = onOk;
  modalMask.style.display = 'flex';
}
function hideModal() {
  modalMask.style.display = 'none';
  modalOk._onOk = null;
}

function lockUI() {
  [tableSel, targetSel, sourceSel, previewSel, recSearch, recAllBtn, recNoneBtn, refreshBtn, startBtn].forEach(
    (n) => n && (n.disabled = true)
  );
  rangeSeg.querySelectorAll('.seg-btn').forEach((b) => (b.disabled = true));
  recList.querySelectorAll('.rec-check').forEach((c) => (c.disabled = true));
  skipBox.disabled = true;
  document.getElementById('app').classList.add('loading');
}
function unlockUI() {
  [tableSel, targetSel, sourceSel, previewSel, recSearch, recAllBtn, recNoneBtn, refreshBtn, startBtn].forEach(
    (n) => n && (n.disabled = false)
  );
  rangeSeg.querySelectorAll('.seg-btn').forEach((b) => (b.disabled = false));
  recList.querySelectorAll('.rec-check').forEach((c) => (c.disabled = false));
  skipBox.disabled = false;
  document.getElementById('app').classList.remove('loading');
}

async function onStart(opts = {}) {
  if (!state.ready || !state.table) {
    log('请先等待初始化完成。', 'warn');
    return;
  }
  const targetFieldId = targetSel.value;
  if (!targetFieldId) {
    log('请选择「目标字段」。', 'warn');
    return;
  }

  let domain = state.domain;
  if (!/feishu|larksuite/.test(domain || '')) {
    const parsed = parseRawDomain((domainInput.value || '').trim());
    if (!parsed) {
      log('请填写有效的飞书域名。', 'warn');
      return;
    }
    domain = parsed;
  }

  const sourceFieldId = sourceSel.value || null;
  let selectedIds = null;
  // 正常“仅选中行”模式：必须勾选了记录（重跑失败项走下方 onlyIds 分支，不在此校验）
  if (state.mode === 'selected' && !opts.onlyIds) {
    selectedIds = Array.from(state.selected);
    if (!selectedIds.length) {
      log('请在记录列表中勾选要转换的行。', 'warn');
      return;
    }
  }

  // 若为“重跑失败项”，从 opts 取失败的 id 集合；先校验这些 id 仍存在于当前表
  if (opts.onlyIds) {
    const valid = new Set(state.records.map((r) => r.recordId));
    const filtered = (opts.onlyIds || []).filter((id) => valid.has(id));
    if (!filtered.length) {
      log('没有可重跑的记录（这些记录可能已不在当前数据表）。', 'warn');
      return;
    }
    selectedIds = filtered;
    if (state.mode !== 'selected') setMode('selected');
  }

  const targetName =
    (state.fieldMetas.find((f) => f.id === targetFieldId) || {}).name || targetFieldId;
  const affectCount = selectedIds ? selectedIds.length : state.records.length;
  const modeText = selectedIds ? `仅选中 ${selectedIds.length} 条` : '全部行';

  const doGenerate = async () => {
    clearLog();
    setProgress(0, 0);
    lockUI();
    log('开始生成记录链接…', 'info');
    try {
      const targetMeta = state.fieldMetas.find((f) => f.id === targetFieldId);
      const res = await generateLinks({
        table: state.table,
        records: state.records,
        targetFieldId,
        targetFieldType: targetMeta ? targetMeta.type : null,
        sourceFieldId,
        domain,
        selectedIds: opts.onlyIds ? selectedIds : selectedIds,
        skipExisting: opts.forceWrite ? false : state.skipExisting,
        onProgress: setProgress,
        onLog: log,
      });
      state.generated = new Set(res.links.map((l) => l.recordId));
      state.linksMap = res.links;
      if (state.mode === 'selected') renderRecordList();
      renderResultCard(res);
      showToast(`记录链接生成完成：成功 ${res.written} 行`, 'ok');
      log(
        `完成：共 ${res.total} 行｜写入 ${res.written}｜跳过已生成 ${res.skippedExisting}｜源空跳过 ${res.skipped}｜失败 ${res.failed}。`,
        res.failed ? 'warn' : 'ok'
      );
    } catch (e) {
      log('生成失败：' + (e && e.message ? e.message : e), 'error');
      showToast('生成失败，请查看日志', 'error');
    } finally {
      unlockUI();
      updateSelCount();
    }
  };

  // 生成前确认（交互：二次确认，防误触）
  if (opts.skipConfirm) {
    await doGenerate();
    return;
  }
  const infoHtml = `
    <div class="cf-row"><span>转换范围</span><b>${modeText}</b></div>
    <div class="cf-row"><span>目标字段</span><b>${escapeHtml(targetName)}</b></div>
    <div class="cf-row"><span>将影响行数</span><b>${affectCount} 行</b></div>
    <div class="cf-row"><span>跳过已生成</span><b>${state.skipExisting && !opts.forceWrite ? '是' : '否'}</b></div>
    <div class="cf-tip">点击「确认生成」后，将把记录链接写入上述字段列。</div>`;
  showModal(infoHtml, doGenerate);
}

function renderResultCard(res) {
  resultCard.innerHTML = '';
  const blocks = [];
  blocks.push(
    statBlock('ok', '成功写入', res.written, '#2ea121')
  );
  blocks.push(
    statBlock('skip', '跳过已生成', res.skippedExisting, '#3370ff')
  );
  blocks.push(
    statBlock('empty', '源空跳过', res.skipped, '#8a9099')
  );
  blocks.push(
    statBlock('fail', '失败', res.failed, '#e5484d')
  );
  resultCard.appendChild(el('div', { class: 'rc-grid' }, blocks));

  if (res.failedRows && res.failedRows.length) {
    const list = el('div', { class: 'rc-fail' }, [
      el('div', { class: 'rc-fail-title' }, `失败明细（${res.failedRows.length} 条）`),
    ]);
    res.failedRows.slice(0, 30).forEach((f) => {
      list.appendChild(
        el('div', { class: 'rc-fail-item' }, [
          el('code', {}, String(f.recordId)),
          el('span', { class: 'rc-fail-msg' }, f.error || ''),
        ])
      );
    });
    resultCard.appendChild(list);
  }

  const actions = el('div', { class: 'rc-actions' }, [
    el('button', { class: 'link-btn', onclick: copyAll }, '复制全部链接'),
    el('button', { class: 'link-btn', onclick: exportCsv }, '导出 CSV'),
  ]);
  if (res.failedRows && res.failedRows.length) {
    actions.appendChild(
      el(
        'button',
        {
          class: 'link-btn danger',
          onclick: () =>
            onStart({
              onlyIds: res.failedRows.map((f) => f.recordId),
              forceWrite: true,
              skipConfirm: true,
            }),
        },
        '重跑失败项'
      )
    );
  }
  resultCard.appendChild(actions);
  resultCard.style.display = 'block';
}

function statBlock(kind, label, val, color) {
  return el('div', { class: 'rc-stat rc-' + kind }, [
    el('div', { class: 'rc-val', style: 'color:' + color }, String(val)),
    el('div', { class: 'rc-label' }, label),
  ]);
}

function copyAll() {
  if (!state.linksMap.length) {
    showToast('没有可复制的链接', 'warn');
    return;
  }
  const text = state.linksMap.map((l) => l.link).join('\n');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast(`已复制 ${state.linksMap.length} 条链接`, 'ok'),
        () => fallbackCopy(text)
      );
    } else fallbackCopy(text);
  } catch (e) {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(`已复制 ${state.linksMap.length} 条链接`, 'ok');
  } catch (e) {
    showToast('复制失败', 'error');
  }
}
function exportCsv() {
  if (!state.linksMap.length) {
    showToast('没有可导出的链接', 'warn');
    return;
  }
  const header = 'recordId,link\n';
  const body = state.linksMap
    .map((l) => `${l.recordId},"${l.link.replace(/"/g, '""')}"`)
    .join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'record_links.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('已导出 record_links.csv', 'ok');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function applyTheme() {
  let dark = false;
  try {
    dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    dark = false;
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

const EMPTY_SVG = (text) =>
  `<div class="empty-wrap"><svg viewBox="0 0 64 64" width="56" height="56" fill="none">
    <rect x="10" y="16" width="44" height="34" rx="6" stroke="#c8cdd6" stroke-width="2.5"/>
    <path d="M10 26h44" stroke="#c8cdd6" stroke-width="2.5"/>
    <circle cx="17" cy="21" r="2" fill="#c8cdd6"/>
    <path d="M22 36h20M22 42h12" stroke="#dfe3ea" stroke-width="2.5" stroke-linecap="round"/>
  </svg><div class="empty-text">${text}</div></div>`;

const CHECK_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#2ea121" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>';

// 跟随系统/飞书深色主题
try {
  if (window.matchMedia) {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', applyTheme);
  }
} catch (e) {
  /* 忽略 */
}

renderShell();
init(false);
