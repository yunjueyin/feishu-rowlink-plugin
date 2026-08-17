import './style.css';
import { bitable } from '@lark-base-open/js-sdk';
import {
  parseBaseFromReferrer,
  parseRawBase,
  getActiveTableMeta,
  generateLinks,
} from './widget.js';

// 模块级元素引用（DOM 只构建一次）
let targetSel, sourceSel, appTokenBox, appTokenInput, startBtn, refreshBtn;
let state = {
  table: null,
  fieldMetas: [],
  appToken: null,
  domain: 'www.feishu.cn',
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
        el('label', {}, '目标字段（写回记录链接的列）'),
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
      (appTokenBox = el('div', {
        id: 'appTokenBox',
        class: 'field appTokenBox',
        style: 'display:none',
      }, [
        el('label', {}, '未自动识别到多维表地址，请手动粘贴多维表链接或 appToken'),
        (appTokenInput = el('input', {
          id: 'appTokenInput',
          type: 'text',
          placeholder: 'https://www.feishu.cn/base/xxxx 或 bascn...',
        })),
      ])),
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
  startBtn.addEventListener('click', onStart);
  refreshBtn.addEventListener('click', () => init(true));
}

function fillFieldOptions() {
  targetSel.innerHTML = '';
  sourceSel.innerHTML = '';
  targetSel.appendChild(el('option', { value: '' }, '请选择字段…'));
  sourceSel.appendChild(el('option', { value: '' }, '（处理全部行）'));
  let preselect = '';
  state.fieldMetas.forEach((f) => {
    targetSel.appendChild(el('option', { value: f.id }, f.name));
    sourceSel.appendChild(el('option', { value: f.id }, f.name));
    if (!preselect && /记录链接|链接|link/i.test(f.name)) preselect = f.id;
  });
  if (preselect) targetSel.value = preselect;
}

async function init(refresh = false) {
  const detected = parseBaseFromReferrer();
  if (detected) {
    state.appToken = detected.appToken;
    state.domain = detected.domain;
    appTokenBox.style.display = 'none';
    log(
      `已自动识别多维表：${detected.appToken}（${detected.domain}）`,
      'ok'
    );
  } else {
    appTokenBox.style.display = 'block';
    log('未能自动识别多维表地址，请在上方手动填写。', 'warn');
  }

  try {
    const { table, fieldMetas } = await getActiveTableMeta();
    state.table = table;
    state.fieldMetas = fieldMetas;
    fillFieldOptions();
    const tableName = table.name || table.id || '（当前数据表）';
    document.getElementById('status').textContent =
      `当前数据表：${tableName} ｜ 字段数：${fieldMetas.length}`;
    state.ready = true;
    log(
      `已加载字段：${fieldMetas.map((f) => f.name).join('、') || '（无）'}`,
      'ok'
    );
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

  let appToken = state.appToken;
  let domain = state.domain;
  if (!appToken) {
    const raw = (appTokenInput.value || '').trim();
    const parsed = parseRawBase(raw);
    if (!parsed) {
      log('请填写有效的多维表链接或 appToken。', 'warn');
      return;
    }
    appToken = parsed.appToken;
    domain = parsed.domain;
  }

  const sourceFieldId = sourceSel.value || null;
  document.getElementById('log').innerHTML = '';
  setProgress(0, 0);
  startBtn.disabled = true;
  log('开始生成记录链接…', 'info');

  try {
    const res = await generateLinks({
      table: state.table,
      targetFieldId,
      sourceFieldId,
      domain,
      appToken,
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
