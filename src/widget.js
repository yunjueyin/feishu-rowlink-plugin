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
 * - targetFieldId：写回链接的列（必填，必须是「超链接」类型字段）
 * - targetFieldType：目标字段类型，用于提示
 * - sourceFieldId：可选，仅处理该列非空的行（对应“分享记录”列）
 * 写入对超链接字段做多格式兜底（{text,link} 对象 / 字符串 / 数组），确保写入成功。
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
  if (!isUrlType(targetFieldType)) {
    onLog &&
      onLog('提示：记录链接应写入「超链接」类型字段，才会显示为可点击链接。', 'warn');
  }

  let done = 0;
  let written = 0;
  let skipped = 0;

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
    const link = buildRecordLink(domain, recordId);
    // 超链接字段写入格式不确定，依次尝试多种，命中即止
    const candidates = [{ text: link, link }, link, [{ text: link, link }]];
    let ok = false;
    for (const v of candidates) {
      try {
        await table.setCellValue(targetFieldId, recordId, v);
        ok = true;
        break;
      } catch (e) {
        /* 尝试下一种格式 */
      }
    }
    if (ok) {
      written++;
    } else {
      onLog && onLog(`写入行 ${recordId} 失败（所有格式均失败）。`, 'error');
    }
    done++;
    onProgress && onProgress(done, total);
  }
  return { total, written, skipped };
}
