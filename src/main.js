import './style.css';
import { bitable } from '@lark-base-open/js-sdk';
import {
  parseDomainFromReferrer,
  parseRawDomain,
  listTables,
  getTableFields,
  generateLinks,
} from './widget.js';

// 模块级元素引用（DOM 只构建一次）
let tableSel, targetSel, sourceSel, domainBox, domainInput, startBtn, refreshBtn;
let state = {
  domain: 'www.feishu.cn',
  tables: [],
  table: null,
  fieldMetas: [],
  ready: false,
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
  const line = el('div', { class: 'log-line ' + type }, msg);
  box.appendChild(line);
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

function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.appendChild(
    el('div', { class: 'card' }, [
      el('h1', {}, '记录链接生成器'),
      el('p', { class: 'sub' }, [
        '一键为多维表每一行生成「记录链接」，写回到对应行的指定列。',
      ]),
      el('div', { id: 'status', class: 'status' }, '正在初始化…'),
      el('div', { class: 'field' }, [
        el('label', {}, '数据表（选择要处理的工作表）'),
        (tableSel = el('select', { id: 'tableField' }, [
          el('option', { value: '' }, '正在加载数据表…'),
        ])),
      ]),
      el('div', { class: 'field' }, [
        el('label', {}, '目标字段（写回记录链接的列，必须用「超链接」类型）'),
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
      (domainBox = el(
        'div',
        {
          id: 'domainBox',
          class: 'field domainBox',
          style: 'display:none',
        },
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
        (refreshBtn = el('button', { id: 'refresh' }, '刷新字段')),
      ]),
      el('div', { class: 'progress', id: 'progress', style: 'display:none' }, [
        el('div', { class: 'bar', id: 'bar' }, ''),
      ]),
      el('div', { class: 'log', id: 'log' }),
    ])
  );
  tableSel.addEventListener('change', async () => {
    if (tableSel.value) {
      await selectTable(tableSel.value);
    }
  });
  startBtn.addEventListener('click', onStart);
  refreshBtn.addEventListener('click', () => init(true));
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
  const info = state.tables.find((t) => t.id === tableId);
  document.getElementById('status').textContent =
    `当前数据表：${info ? info.name : table.name || table.id} ｜ 字段数：${metas.length}`;
}

async function init(refresh = false) {
  // 1) 解析飞书域名
  const detected = parseDomainFromReferrer();
  if (detected && /feishu|larksuite/.test(detected)) {
    state.domain = detected;
    domainBox.style.display = 'none';
    log(`已识别飞书域名：${detected}`, 'ok');
  } else {
    domainBox.style.display = 'block';
    log('未能识别飞书域名，请在上方手动填写（如 www.feishu.cn）。', 'warn');
  }

  // 2) 列出数据表并默认选中当前激活表
  try {
    const tables = await listTables();
    state.tables = tables;
    tableSel.innerHTML = '';
    if (!tables.length) {
      tableSel.appendChild(el('option', { value: '' }, '（无可用数据表）'));
    }
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
    log(`已加载数据表：${tables.map((t) => t.name).join('、') || '（无）'}`, 'ok');
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
    const raw = (domainInput.value || '').trim();
    const parsed = parseRawDomain(raw);
    if (!parsed) {
      log('请填写有效的飞书域名。', 'warn');
      return;
    }
    domain = parsed;
  }

  const sourceFieldId = sourceSel.value || null;
  document.getElementById('log').innerHTML = '';
  setProgress(0, 0);
  startBtn.disabled = true;
  log('开始生成记录链接…', 'info');

  try {
    const targetMeta = state.fieldMetas.find((f) => f.id === targetFieldId);
    const res = await generateLinks({
      table: state.table,
      targetFieldId,
      targetFieldType: targetMeta ? targetMeta.type : null,
      sourceFieldId,
      domain,
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
  }
}

renderShell();
init(false);
