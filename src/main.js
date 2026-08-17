import './style.css';
import { bitable } from '@lark-base-open/js-sdk';
import {
  parseDomainFromReferrer,
  parseRawDomain,
  listTables,
  getTableFields,
  getAllRecords,
  generateLinks,
  previewText,
} from './widget.js';

let tableSel, targetSel, sourceSel, domainBox, domainInput, startBtn, refreshBtn;
let rangeSeg, recListBox, recList, recSelCount, recAllBtn, recNoneBtn;
let state = {
  domain: 'www.feishu.cn',
  tables: [],
  table: null,
  fieldMetas: [],
  records: [],
  ready: false,
  mode: 'all', // 'all' | 'selected'
  selected: new Set(),
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (v == null) return;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
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

function setProgress(done, total) {
  const p = document.getElementById('progress');
  const bar = document.getElementById('bar');
  if (!p || !bar) return;
  p.style.display = 'block';
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = pct + '%';
  bar.textContent = `${done} / ${total}`;
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
      el('div', { class: 'field' }, [
        el('label', {}, '目标字段（写回记录链接的列，须为「超链接」类型）'),
        (targetSel = el('select', { id: 'targetField' }, [
          el('option', { value: '' }, '请选择字段…'),
        ])),
      ]),
      el('div', { class: 'field' }, [
        el('label', {}, '源字段（可选：仅处理该列非空的行）'),
        (sourceSel = el('select', { id: 'sourceField' }, [
          el('option', { value: '' }, '（处理全部行）'),
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
          (recList = el('div', { class: 'rec-list' })),
        ]
      )),

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
      el('div', { class: 'footer' }, [
        '目标字段用「超链接」类型，链接才会显示为蓝色可点击。',
      ]),
    ]),
  ]);
  app.appendChild(card);

  tableSel.addEventListener('change', async () => {
    if (tableSel.value) await selectTable(tableSel.value);
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
}

function setMode(mode) {
  state.mode = mode;
  rangeSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode);
  });
  recListBox.style.display = mode === 'selected' ? 'block' : 'none';
  if (mode === 'selected') renderRecordList();
  else updateSelCount();
}

function renderRecordList() {
  recList.innerHTML = '';
  if (!state.records.length) {
    recList.appendChild(
      el('div', { class: 'rec-empty' }, '当前数据表没有任何记录。')
    );
    updateSelCount();
    return;
  }
  state.records.forEach((rec, i) => {
    const id = rec.recordId;
    const item = el('label', { class: 'rec-item' }, [
      el('input', { type: 'checkbox', class: 'rec-check', 'data-id': id }),
      el('span', { class: 'rec-idx' }, String(i + 1)),
      el('span', { class: 'rec-text' }, previewText(rec, state.fieldMetas)),
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
  targetSel.appendChild(el('option', { value: '' }, '请选择字段…'));
  sourceSel.appendChild(el('option', { value: '' }, '（处理全部行）'));
  state.fieldMetas.forEach((f) => {
    targetSel.appendChild(el('option', { value: f.id }, f.name));
    sourceSel.appendChild(el('option', { value: f.id }, f.name));
  });
}

async function selectTable(tableId) {
  const table = await bitable.base.getTable(tableId);
  state.table = table;
  const metas = await getTableFields(table);
  state.fieldMetas = metas;
  fillFieldOptions();
  // 读取记录用于「仅选中行」列表展示
  state.records = await getAllRecords(table);
  state.selected = new Set();
  if (state.mode === 'selected') renderRecordList();
  else updateSelCount();
  const info = state.tables.find((t) => t.id === tableId);
  document.getElementById('status').textContent =
    `当前数据表：${info ? info.name : table.name || table.id} ｜ ${
      state.records.length
    } 行 ｜ ${metas.length} 字段`;
}

async function init(refresh = false) {
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
    if (!tables.length)
      tableSel.appendChild(el('option', { value: '' }, '（无可用数据表）'));
    tables.forEach((t) =>
      tableSel.appendChild(el('option', { value: t.id }, t.name))
    );

    const active = await bitable.base.getActiveTable();
    if (active && tables.find((t) => t.id === active.id)) {
      tableSel.value = active.id;
      await selectTable(active.id);
    } else if (tables.length) {
      await selectTable(tables[0].id);
    }
    log(
      `已加载数据表：${tables.map((t) => t.name).join('、') || '（无）'}`,
      'ok'
    );
    state.ready = true;
  } catch (e) {
    document.getElementById('status').textContent = '初始化失败';
    log(
      '无法访问多维表，请在飞书多维表「自定义组件」中添加本插件后使用。错误：' +
        (e && e.message ? e.message : e),
      'error'
    );
  }
}

async function onStart() {
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
  const selectedIds = state.mode === 'selected' ? Array.from(state.selected) : null;
  if (state.mode === 'selected' && (!selectedIds || selectedIds.length === 0)) {
    log('请在记录列表中勾选要转换的行。', 'warn');
    return;
  }

  document.getElementById('log').innerHTML = '';
  setProgress(0, 0);
  startBtn.disabled = true;
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
      selectedIds,
      onProgress: setProgress,
      onLog: log,
    });
    log(
      `完成：共 ${res.total} 行，写入 ${res.written} 行，跳过 ${res.skipped} 行。`,
      'ok'
    );
    try {
      await bitable.ui.toast(`记录链接生成完成：${res.written} 行`);
    } catch (e) {
      /* 忽略 toast 失败 */
    }
  } catch (e) {
    log('生成失败：' + (e && e.message ? e.message : e), 'error');
  } finally {
    startBtn.disabled = false;
    updateSelCount();
  }
}

renderShell();
init(false);
