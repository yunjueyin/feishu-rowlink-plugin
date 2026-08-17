import { bitable } from '@lark-base-open/js-sdk';

/**
 * 从插件 iframe 的 referrer（即飞书多维表页面地址）中解析飞书域名。
 * 飞书「记录链接」的标准格式为 https://<domain>/record/<recordId>，域名取当前页面域名即可。
 */
export function parseDomainFromReferrer() {
  try {
    const ref = document.referrer || '';
    const m = ref.match(/^https?:\/\/([^/?#]+)/);
    if (m) return m[1];
  } catch (e) {
    /* 忽略 */
  }
  return null;
}

/**
 * 从用户手动输入中提取飞书域名（支持完整链接或裸域名如 www.feishu.cn）。
 */
export function parseRawDomain(raw) {
  if (!raw) return null;
  const m = raw.match(
    /([a-zA-Z0-9-]+\.feishu\.(cn|com)|[a-zA-Z0-9-]+\.larksuite\.com)/
  );
  if (m) return m[1];
  return null;
}

/**
 * 生成一条记录在飞书的「记录链接」。
 * 这是飞书「复制记录链接」功能导出的标准格式，仅依赖 recordId，
 * 不依赖 appToken / tableId，因此绝不会退化成「整个表格的链接」。
 */
export function buildRecordLink(domain, recordId) {
  return `https://${domain}/record/${recordId}`;
}

/**
 * 获取某条记录的可分享链接。
 * 优先用飞书官方的 getRecordShareLink（返回含 24 位规范 recordId 的链接）；
 * 因为 getRecordsByPage 返回的 recordId 只是客户端临时 id，直接拼 /record/<id>
 * 会跳到“页面不存在”。仅在 getRecordShareLink 不可用/失败时回退到自行拼接。
 */
async function getRecordLink(table, recordId, domain) {
  try {
    if (typeof table.getRecordShareLink === 'function') {
      const share = await table.getRecordShareLink(recordId);
      if (share && typeof share === 'string' && share.trim()) {
        return share.trim();
      }
    }
  } catch (e) {
    /* 回退到自行拼接 domain/record/id */
  }
  return buildRecordLink(domain, recordId);
}

/** 判断单元格值是否为空（字符串/数组/null 等） */
export function isEmptyValue(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * 判断字段是否为「超链接 / URL」类型。
 * 不同 SDK 版本下 type 可能是数字（15）或字符串（'url'/'link'/'hyperlink'），全部兼容。
 */
function isUrlType(t) {
  if (t == null) return false;
  const s = String(t).toLowerCase();
  return t === 15 || s === 'url' || s === 'link' || s === 'hyperlink';
}

/**
 * 读取单元格当前值（写后回读校验用）。
 * 返回 { available, value }：available=false 表示 getCellValue 不可用/抛错，
 * 此时无法校验，应信任 setCellValue 的提交结果，避免误判失败。
 */
async function readCell(table, fieldId, recordId) {
  try {
    if (typeof table.getCellValue === 'function') {
      const v = await table.getCellValue(fieldId, recordId);
      return { available: true, value: v };
    }
  } catch (e) {
    /* 回读失败不应中断写入流程 */
  }
  return { available: false, value: undefined };
}

/** 判断已写入的单元格取值里是否包含目标链接（兼容数组 / 对象 / 字符串多种形态） */
function valueContainsLink(stored, link) {
  if (stored == null) return false;
  if (typeof stored === 'string') return stored.includes(link);
  if (Array.isArray(stored)) {
    return stored.some(
      (s) =>
        s &&
        ((s.link && String(s.link).includes(link)) ||
          (s.text && String(s.text).includes(link)))
    );
  }
  if (typeof stored === 'object') {
    return (
      (stored.link && String(stored.link).includes(link)) ||
      (stored.text && String(stored.text).includes(link))
    );
  }
  return String(stored).includes(link);
}

/**
 * 限制并发的 map：用固定大小的协程池处理 items，避免一次性并发过多触发飞书限流。
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }
  const pool = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i++) pool.push(run());
  await Promise.all(pool);
  return results;
}

/**
 * 列出当前多维表下所有数据表，用于「数据表」下拉。
 * 用 getTableMetaList() 拿名称最可靠——getTableList() 返回的 ITable 实例
 * name 经常为空，会导致下拉里只显示 tableId 而非中文表名。
 */
export async function listTables() {
  let metas = [];
  try {
    metas = await bitable.base.getTableMetaList();
  } catch (e) {
    metas = [];
  }
  if (metas && metas.length) {
    return metas.map((m) => ({ id: m.id, name: m.name || m.id }));
  }
  const tables = await bitable.base.getTableList();
  return (tables || []).map((t) => ({ id: t.id, name: t.name || t.id }));
}

/** 获取某个数据表的字段元信息 */
export async function getTableFields(table) {
  return await table.getFieldMetaList();
}

/** 将不同 API 返回结构统一为 { recordId, fields } */
function normalizeRecord(r) {
  if (!r) return { recordId: null, fields: {} };
  const recordId = r.recordId != null ? r.recordId : r.id;
  return { recordId, fields: r.fields || {} };
}

/**
 * 读取数据表全部记录。
 * 优先使用 getRecordsByPage：在飞书自定义组件(widget)环境实测可用且能正确返回 recordId；
 * getRecordIdList 在该环境可能返回空，故作为兜底。
 */
export async function getAllRecords(table) {
  const records = [];
  if (typeof table.getRecordsByPage === 'function') {
    let pageToken;
    let guard = 0;
    do {
      const res = await table.getRecordsByPage({ pageSize: 200, pageToken });
      const list = (res && res.records) || [];
      for (const rec of list) records.push(normalizeRecord(rec));
      if (!res || !res.hasMore) break;
      pageToken = res.pageToken;
    } while (pageToken && guard++ < 1000);
    return records;
  }
  if (typeof table.getRecordIdList === 'function') {
    const ids = await table.getRecordIdList();
    for (const id of ids) {
      let r = null;
      try {
        r = await table.getRecordById(id);
      } catch (e) {
        r = { recordId: id, fields: {} };
      }
      records.push(normalizeRecord(r));
    }
    return records;
  }
  return records;
}

/**
 * 为每一行生成记录链接并写回目标列。
 * - targetFieldId：写回链接的列（必填，建议「超链接」类型字段）
 * - targetFieldType：目标字段类型，仅用于提示
 * - sourceFieldId：可选，仅处理该列非空的行
 * 提速策略：
 *   1) 用 setRecords 批量写（单次上限 200，这里按 100 分批），将 2N 次调用压成约 N/100 次；
 *   2) 获取分享链接并发执行（限制并发 6，避免限流）；
 *   3) 写后仅对首条做一次回读校验，确认格式有效，不再逐行回读。
 * 链接格式：超链接字段写入标准结构 [{type:'url', text, link}]，飞书渲染为蓝色可点击链接。
 */
export async function generateLinks({
  table,
  targetFieldId,
  targetFieldType,
  sourceFieldId,
  domain,
  onProgress,
  onLog,
}) {
  const records = await getAllRecords(table);
  const total = records.length;
  onLog && onLog(`已读取 ${total} 条记录，目标字段类型：${targetFieldType}。`, 'info');
  if (total === 0) {
    onLog &&
      onLog(
        '未读取到任何记录：请确认组件已添加到「包含数据」的多维表，且当前选中的数据表确实有记录。',
        'warn'
      );
  }
  const isUrl = isUrlType(targetFieldType);
  if (isUrl) {
    onLog &&
      onLog('目标为「超链接」字段，将写入标准超链接结构（蓝色可点击）。', 'info');
  } else {
    onLog &&
      onLog(
        '提示：记录链接建议写入「超链接」类型字段才会显示蓝色可点击链接；当前按文本格式写入（纯文本，不可点击）。',
        'warn'
      );
  }

  // 1) 并发获取每条记录的分享链接（限制并发，避免触发飞书限流）
  onLog && onLog('正在获取记录分享链接…', 'info');
  const links = await mapWithConcurrency(records, 6, async (rec) => {
    if (!rec.recordId) return null;
    if (
      sourceFieldId &&
      isEmptyValue(rec.fields ? rec.fields[sourceFieldId] : undefined)
    )
      return null;
    return await getRecordLink(table, rec.recordId, domain);
  });

  // 2) 组装待写入项：超链接字段写入标准结构 [{type:'url', text, link}]（蓝色可点击）
  const toWrite = [];
  let skipped = 0;
  records.forEach((rec, i) => {
    const link = links[i];
    if (!link) {
      skipped++;
      return;
    }
    toWrite.push({
      recordId: rec.recordId,
      link,
      cellValue: [{ type: 'url', text: link, link }],
    });
  });

  if (toWrite.length) {
    onLog && onLog(`示例记录链接：${toWrite[0].link}`, 'info');
  } else if (total > 0) {
    onLog &&
      onLog('没有需要写入的行（源字段筛选后为空，或记录无有效 id）。', 'warn');
  }

  // 3) 批量写入
  let written = 0;
  if (toWrite.length) {
    if (typeof table.setRecords === 'function') {
      const BATCH = 100; // setRecords 单次上限 200，取 100 留余量
      for (let i = 0; i < toWrite.length; i += BATCH) {
        const batch = toWrite.slice(i, i + BATCH);
        const payload = batch.map((w) => ({
          recordId: w.recordId,
          fields: { [targetFieldId]: w.cellValue },
        }));
        let okCount = 0;
        try {
          await table.setRecords(payload);
          okCount = batch.length;
        } catch (e) {
          // 批量失败：退化为逐行写入，逐行定位失败
          for (const w of batch) {
            try {
              await table.setCellValue(targetFieldId, w.recordId, w.cellValue);
              okCount++;
            } catch (e2) {
              onLog &&
                onLog(
                  `写入行 ${w.recordId} 失败：${e2 && e2.message ? e2.message : e2}`,
                  'error'
                );
            }
          }
        }
        written += okCount;
        onProgress && onProgress(skipped + i + batch.length, total);
      }
    } else {
      for (const w of toWrite) {
        try {
          await table.setCellValue(targetFieldId, w.recordId, w.cellValue);
          written++;
        } catch (e) {
          onLog &&
            onLog(
              `写入行 ${w.recordId} 失败：${e && e.message ? e.message : e}`,
              'error'
            );
        }
        onProgress && onProgress(skipped + written, total);
      }
    }
  }

  // 4) 仅对首条做一次回读校验，确认格式真正写进（避免“假成功”又不拖慢整体）
  if (toWrite.length && written > 0) {
    const first = toWrite[0];
    const { available, value } = await readCell(table, targetFieldId, first.recordId);
    if (available && value != null && !valueContainsLink(value, first.link)) {
      onLog &&
        onLog(
          '警告：回读校验未确认链接写入，请确认目标字段类型是否为「超链接」。',
          'warn'
        );
    }
  }

  return { total, written, skipped };
}
