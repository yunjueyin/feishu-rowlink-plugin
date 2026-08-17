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
  const isUrl = isUrlType(targetFieldType);
  if (isUrl) {
    onLog &&
      onLog(
        '目标为「超链接」字段，将按 URL 字段格式写入（优先纯链接字符串）。写后会回读校验确保真正写进。',
        'info'
      );
  } else {
    onLog &&
      onLog(
        '提示：记录链接建议写入「超链接」类型字段才会显示为可点击链接；当前按文本格式写入（纯文本，不可点击）。',
        'warn'
      );
  }

  let done = 0;
  let written = 0;
  let skipped = 0;
  // 已回读验证可用的取值格式：命中后优先复用，避免每行都重试多种格式
  let verifiedFormat = null;

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

    // 候选取值：
    //  - 超链接(URL)字段：SDK 要求 IOpenUrlSegment$1[]（数组，元素 {type:'url',text,link}），
    //    且 UrlTransformVal 允许纯字符串，故优先纯字符串。
    //  - 文本字段：{text, link} 行内链接可点击，其次纯字符串。
    let candidates = isUrl
      ? [link, [{ type: 'url', text: link, link }], { type: 'url', text: link, link }]
      : [{ text: link, link }, link, [{ text: link, link }]];
    if (verifiedFormat) candidates = [verifiedFormat, ...candidates];

    let ok = false;
    let lastErr = null;
    let lastResolvedValue = null; // 最后一个“setCellValue 未抛错”的取值
    const triedKeys = new Set();
    for (const v of candidates) {
      const key = JSON.stringify(v);
      if (triedKeys.has(key)) continue;
      triedKeys.add(key);
      try {
        await table.setCellValue(targetFieldId, recordId, v);
        lastResolvedValue = v;
        // 写后回读校验：避免 SDK 静默“成功”却没存进可见值（之前的假成功根因）
        const { available, value } = await readCell(table, targetFieldId, recordId);
        if (!available) {
          // 回读不可用：无法校验，信任 setCellValue 已提交
          ok = true;
          verifiedFormat = v;
          break;
        }
        if (valueContainsLink(value, link)) {
          ok = true;
          verifiedFormat = v;
          break;
        }
        // 回读可用但为空/不含链接，继续尝试下一种格式
      } catch (e) {
        lastErr = e;
      }
    }

    // 所有格式都“写入未抛错”但回读均未含链接：可能是回读缓存延迟，信任最后一次写入
    if (!ok && !lastErr && lastResolvedValue != null) {
      ok = true;
      verifiedFormat = lastResolvedValue;
      onLog &&
        onLog(
          `行 ${recordId}：写入已提交，但回读校验未确认（可能为缓存延迟），请在表中确认是否出现链接。`,
          'warn'
        );
    }

    if (ok) {
      written++;
    } else if (lastErr) {
      onLog && onLog(`写入行 ${recordId} 失败：${lastErr.message || lastErr}`, 'error');
    } else {
      onLog &&
        onLog(
          `写入行 ${recordId} 失败：所有格式回读均无内容（目标列可能不是可写字段，或字段类型不匹配）。`,
          'error'
        );
    }
    done++;
    onProgress && onProgress(done, total);
  }
  return { total, written, skipped };
}
