import { bitable } from '@lark-base-open/js-sdk';

/**
 * 从插件 iframe 的 referrer（即飞书多维表页面地址）中解析 appToken 与域名。
 * 飞书多维表 URL 形如 https://www.feishu.cn/base/{appToken}?table=...&view=...
 * 在自定义组件 iframe 内，document.referrer 即为该页面地址。
 */
export function parseBaseFromReferrer() {
  try {
    const ref = document.referrer || '';
    const m = ref.match(/\/base\/([^/?#]+)/);
    if (m) {
      let domain = 'www.feishu.cn';
      try {
        domain = new URL(ref).host;
      } catch (e) {
        /* 忽略，使用默认域名 */
      }
      return { appToken: m[1], domain };
    }
  } catch (e) {
    /* 忽略 */
  }
  return null;
}

/**
 * 解析用户手动填写的内容：完整多维表链接，或裸 appToken。
 */
export function parseRawBase(raw) {
  if (!raw) return null;
  try {
    const m = raw.match(/\/base\/([^/?#]+)/);
    if (m) {
      let domain = 'www.feishu.cn';
      try {
        domain = new URL(raw).host;
      } catch (e) {
        /* 忽略 */
      }
      return { appToken: m[1], domain };
    }
  } catch (e) {
    /* 忽略 */
  }
  if (/^[a-zA-Z0-9]+$/.test(raw.trim())) {
    return { appToken: raw.trim(), domain: 'www.feishu.cn' };
  }
  return null;
}

/** 拼出一条记录在飞书多维表里可被直接打开的链接 */
export function buildRecordLink(domain, appToken, tableId, recordId) {
  return `https://${domain}/base/${appToken}?table=${encodeURIComponent(
    tableId
  )}&record=${encodeURIComponent(recordId)}`;
}

/** 判断单元格值是否为空（字符串/数组/null 等） */
export function isEmptyValue(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 获取当前激活的数据表及其字段元信息 */
export async function getActiveTableMeta() {
  const table = await bitable.base.getActiveTable();
  const fieldMetas = await table.getFieldMetaList();
  return { table, fieldMetas };
}

/** 分页读取当前表全部记录，兼容 getRecordsByPage / getRecordIdList 两种 API */
export async function getAllRecords(table) {
  if (typeof table.getRecordsByPage === 'function') {
    const records = [];
    let pageToken;
    do {
      const res = await table.getRecordsByPage({ pageSize: 200, pageToken });
      const list = (res && res.records) || [];
      records.push(...list);
      if (!res || !res.hasMore) break;
      pageToken = res.pageToken;
    } while (pageToken);
    return records;
  }
  const ids = await table.getRecordIdList();
  const recs = [];
  for (const id of ids) {
    const r = await table.getRecordById(id);
    recs.push({ recordId: id, fields: (r && r.fields) || {} });
  }
  return recs;
}

/**
 * 为每一行生成记录链接并写回目标列。
 * - targetFieldId：写回链接的列（必填）
 * - sourceFieldId：可选，仅处理该列非空的行（对应“分享记录”列）
 * 按行串行写入，避免并发写入触发飞书限流。
 */
export async function generateLinks({
  table,
  targetFieldId,
  sourceFieldId,
  domain,
  appToken,
  onProgress,
  onLog,
}) {
  const records = await getAllRecords(table);
  const total = records.length;
  let done = 0;
  let written = 0;
  let skipped = 0;

  const tableId =
    table.id || (table.getTableMeta && (await table.getTableMeta()).id);

  for (const rec of records) {
    const recordId = rec.recordId;
    if (!recordId) {
      done++;
      onProgress && onProgress(done, total);
      continue;
    }
    if (
      sourceFieldId &&
      isEmptyValue(rec.fields ? rec.fields[sourceFieldId] : undefined)
    ) {
      skipped++;
      done++;
      onProgress && onProgress(done, total);
      continue;
    }
    const link = buildRecordLink(domain, appToken, tableId, recordId);
    try {
      await table.setCellValue(targetFieldId, recordId, link);
      written++;
    } catch (e) {
      onLog &&
        onLog(
          `写入行 ${recordId} 失败：${e && e.message ? e.message : e}`,
          'error'
        );
    }
    done++;
    onProgress && onProgress(done, total);
  }
  return { total, written, skipped };
}
