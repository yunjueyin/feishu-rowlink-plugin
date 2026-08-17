// 用 mock 的飞书 Table 实例驱动 generateLinks，覆盖边界场景找逻辑 bug。
// 直接 import 源码（src/widget.js），其顶层 import 了 @lark-base-open/js-sdk，
// 若 SDK 在 Node 下无法加载则会在 import 阶段报错（也会被如实报告）。

import assert from 'node:assert';
import { generateLinks, isEmptyValue } from './src/widget.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name} ${extra}`);
  }
}

// 构造一个可控的 mock table
function makeTable(opts = {}) {
  const {
    share = (rid) => `https://www.feishu.cn/record/CANON_${rid}`, // 标准 24 位规范链接
    shareFlaky = 0, // share 前 shareFlaky 次抛错，之后成功（测试重试）
    stored = {}, // recordId -> 当前目标列取值（用于预读 / 回读）
    batchFails = false, // true 时 setRecords 抛错，触发逐行兜底
    cellFailIds = new Set(), // 逐行兜底时这些 recordId 的 setCellValue 抛错
    partialReturn = null, // 数组：setRecords 仅“写入”并返回这些 id（模拟部分成功）
  } = opts;

  let shareFailsLeft = shareFlaky;
  const writes = []; // 记录写入内容
  const table = {
    async getRecordShareLink(recordId) {
      if (shareFailsLeft > 0) {
        shareFailsLeft--;
        throw new Error('share transient fail (simulated)');
      }
      return share(recordId);
    },
    async getCellValue(fieldId, recordId) {
      const v = stored[recordId];
      return v === undefined ? null : v;
    },
    async setRecords(records) {
      if (batchFails) {
        const e = new Error('batch failed (simulated)');
        e.simulated = true;
        throw e;
      }
      const ids = partialReturn ? partialReturn : records.map((r) => r.recordId);
      for (const r of records) {
        if (ids.includes(r.recordId)) writes.push({ recordId: r.recordId, fields: r.fields });
      }
      return ids;
    },
    async setCellValue(fieldId, recordId, value) {
      if (cellFailIds.has(recordId)) {
        const e = new Error('cell write failed (simulated)');
        e.simulated = true;
        throw e;
      }
      writes.push({ recordId, fieldId, value });
      return true;
    },
    _writes: writes,
  };
  return table;
}

function rec(id, fields = {}) {
  return { recordId: id, fields };
}

const TARGET_ID = 'f_link';
const SRC_ID = 'f_src';

async function run() {
  console.log('=== helper 函数 ===');
  check('isEmptyValue 空字符串=true', isEmptyValue('   '));
  check('isEmptyValue 空数组=true', isEmptyValue([]));

  console.log('\n=== A: 全部行 + 超链接字段 + 正常写入 ===');
  {
    const table = makeTable();
    const records = [rec('r1', { [SRC_ID]: 'a' }), rec('r2', { [SRC_ID]: 'b' }), rec('r3', { [SRC_ID]: 'c' })];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 15, domain: 'www.feishu.cn',
    });
    check('written = 3', res.written === 3, JSON.stringify(res));
    check('skipped = 0', res.skipped === 0);
    check('failed = 0', res.failed === 0);
    check('links 长度 = 3', res.links.length === 3);
    check('写入结构为数组 [{type:url}]', Array.isArray(table._writes[0].fields[TARGET_ID]) && table._writes[0].fields[TARGET_ID][0].type === 'url');
    check('写入 link 用规范 id', table._writes[0].fields[TARGET_ID][0].link.includes('CANON_r1'));
    check('text 默认等于 link', table._writes[0].fields[TARGET_ID][0].text === table._writes[0].fields[TARGET_ID][0].link);
  }

  console.log('\n=== B: skipExisting 跳过已生成行 ===');
  {
    const stored = { r1: 'https://www.feishu.cn/record/ALREADY_done_xyz', r2: null, r3: null };
    const table = makeTable({ stored });
    const records = [rec('r1'), rec('r2'), rec('r3')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn', skipExisting: true,
    });
    check('skippedExisting = 1', res.skippedExisting === 1, `got ${res.skippedExisting}`);
    check('written = 2', res.written === 2, `got ${res.written}`);
    check('不写已生成的 r1', !table._writes.some((w) => w.recordId === 'r1'), JSON.stringify(table._writes));
  }

  console.log('\n=== C: skipExisting=false 会重写已生成行 ===');
  {
    const stored = { r1: 'https://www.feishu.cn/record/ALREADY_done_xyz' };
    const table = makeTable({ stored });
    const records = [rec('r1')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn', skipExisting: false,
    });
    check('written = 1（被重写）', res.written === 1, `got ${res.written}`);
    check('skippedExisting = 0', res.skippedExisting === 0);
  }

  console.log('\n=== D: sourceFieldId 过滤（源空跳过） ===');
  {
    const table = makeTable();
    const records = [rec('r1', { [SRC_ID]: '有值' }), rec('r2', { [SRC_ID]: '' }), rec('r3', {})];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn', sourceFieldId: SRC_ID,
    });
    check('written = 1', res.written === 1, `got ${res.written}`);
    check('skipped(源空) = 2', res.skipped === 2, `got ${res.skipped}`);
  }

  console.log('\n=== E: selectedIds 只处理选中行 ===');
  {
    const table = makeTable();
    const records = [rec('r1'), rec('r2'), rec('r3')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn', selectedIds: ['r2'],
    });
    check('written = 1', res.written === 1, `got ${res.written}`);
    check('只写了 r2', table._writes.length === 1 && table._writes[0].recordId === 'r2');
  }

  console.log('\n=== F: setRecords 抛错 -> 逐行兜底 ===');
  {
    const table = makeTable({ batchFails: true });
    const records = [rec('r1'), rec('r2')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn',
    });
    check('兜底后 written = 2', res.written === 2, `got ${res.written}`);
    check('兜底用 setCellValue', table._writes.every((w) => w.fieldId === TARGET_ID && w.value && Array.isArray(w.value)));
  }

  console.log('\n=== G: 批量失败->逐行兜底->个别行仍失败 -> 收集 failedRows ===');
  {
    const table = makeTable({ batchFails: true, cellFailIds: new Set(['r2']) });
    const records = [rec('r1'), rec('r2'), rec('r3')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn',
    });
    check('written = 2', res.written === 2, `got ${res.written}`);
    check('failed = 1', res.failed === 1, `got ${res.failed}`);
    check('failedRows 含 r2', res.failedRows.length === 1 && res.failedRows[0].recordId === 'r2');
    check('linksOut 不含 r2', !res.links.some((l) => l.recordId === 'r2'));
  }

  console.log('\n=== H: 自定义 linkText ===');
  {
    const table = makeTable();
    const records = [rec('r1')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn', linkText: '点击查看',
    });
    check('text 用自定义文案', table._writes[0].fields[TARGET_ID][0].text === '点击查看');
    check('link 仍为真实链接', table._writes[0].fields[TARGET_ID][0].link.includes('CANON_r1'));
  }

  console.log('\n=== I: 空记录 / 无 recordId ===');
  {
    const table = makeTable();
    const resEmpty = await generateLinks({ table, records: [], targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'x' });
    check('空记录 total=0', resEmpty.total === 0 && resEmpty.written === 0);
    const resNoId = await generateLinks({ table, records: [rec(null), {}], targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'x' });
    check('无 recordId 被跳过 written=0', resNoId.written === 0 && resNoId.skipped === 2, `w=${resNoId.written} s=${resNoId.skipped}`);
  }

  console.log('');
  console.log('=== J: setRecords 部分返回（仅写入部分 id）-> 缺失行逐行兜底 ===');
  {
    const table = makeTable({ partialReturn: ['r1'] }); // 仅 r1 被批量写入，r2/r3 需兜底
    const records = [rec('r1'), rec('r2'), rec('r3')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn',
    });
    check('written = 3（r1 批写 + r2/r3 兜底）', res.written === 3, `got ${res.written}`);
    check('failed = 0', res.failed === 0);
    check('r2/r3 走了 setCellValue 兜底', table._writes.filter((w) => w.fieldId === TARGET_ID).length === 2);
  }

  console.log('\n=== K: setRecords 部分返回 + 兜底行仍失败 -> 收集失败 ===');
  {
    const table = makeTable({ partialReturn: ['r1'], cellFailIds: new Set(['r2']) });
    const records = [rec('r1'), rec('r2'), rec('r3')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn',
    });
    check('written = 2', res.written === 2, `got ${res.written}`);
    check('failed = 1', res.failed === 1, `got ${res.failed}`);
    check('failedRows 含 r2', res.failedRows.length === 1 && res.failedRows[0].recordId === 'r2');
  }

  console.log('\n=== L: getRecordShareLink 瞬时失败 2 次后成功 -> 重试拿到规范链接 ===');
  {
    const table = makeTable({ shareFlaky: 2 });
    const records = [rec('r1')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn',
    });
    check('written = 1（重试成功）', res.written === 1, `got ${res.written}`);
    check('link 仍是规范 CANON 链接（非兜底）', res.links[0].link.includes('CANON_r1'));
  }

  console.log('\n=== M: getRecordShareLink 始终失败 -> 兜底用 domain 拼链接 ===');
  {
    const table = makeTable({ shareFlaky: 99 });
    const records = [rec('r1')];
    const res = await generateLinks({
      table, records, targetFieldId: TARGET_ID, targetFieldType: 'url', domain: 'www.feishu.cn',
    });
    check('written = 1（兜底链接）', res.written === 1, `got ${res.written}`);
    check('link 为 domain 兜底格式（不含 CANON）', res.links[0].link === 'https://www.feishu.cn/record/r1');
  }

  console.log('');
  console.log(`\n==== 结果: ${pass} 通过 / ${fail} 失败 ====`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error('测试执行抛出异常（可能是 import SDK 失败或逻辑错误）:');
  console.error(e);
  process.exit(2);
});
