// Muse 邀请码互助 — Cloudflare Worker 接口模块（外部同步写入）
// POST /api/muse/sync — 供另一个采集方（每日采集）把新邀请码同步进码池。
// 鉴权：请求头 X-Sync-Key 必须与环境变量 SYNC_KEY 完全一致，否则 401；
// 若环境未配置 SYNC_KEY，直接返回 503（默认关闭，不敞开写入）。
// 去重语义与 /api/muse/import（站主批量导入）完全一致：规范化后与全部历史行
// 比对（含 retired 与演示码），命中 retired/演示码计入 tombstoneDuplicates，
// 命中可用码计入 existingDuplicates；墓碑表独有的码也算命中已下架。
// 新码一律按 source='public'、status='available'、verification='unverified' 入池，
// 即「公开分享 · 待验证」层：排在自有码之后，一次成功回报即升级为正常层。
// 请求体二选一：{ "codes": ["ABC123", ...] } 或 { "text": "大段文本，空白/逗号分隔" }。
// 数据库通过 env.DB（D1 绑定，变量名 DB）访问；时间为 ISO 8601 UTC 文本。

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readBody(request) {
  try {
    const t = await request.text();
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

function methodNotAllowed() {
  return json({ ok: false, error: "method_not_allowed", message: "只接受 POST 请求。" }, 405);
}

// --- 与 import.js 一致的规范化与校验 ---
function normalizeCode(raw) {
  return String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "");
}
const CODE_FORMAT = /^[A-Z0-9]{6}$/;
function isValidCodeFormat(normalized) {
  return CODE_FORMAT.test(normalized);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.SYNC_KEY) {
      return json({ ok: false, error: "sync_not_configured", message: "未配置 SYNC_KEY，同步写入暂未开启。" }, 503);
    }
    const key = request.headers.get("X-Sync-Key");
    if (!key || key !== env.SYNC_KEY) {
      return json({ ok: false, error: "unauthorized", message: "未授权：需要正确的 X-Sync-Key 请求头。" }, 401);
    }
    const body = await readBody(request);
    let tokens = [];
    if (Array.isArray(body.codes)) {
      tokens = body.codes.map((c) => String(c ?? "").trim()).filter((c) => c.length > 0);
      if (tokens.length > 10000) {
        return json({ ok: false, error: "too_many_codes", message: "单次同步码数量超限（上限 10000 个）。" }, 400);
      }
    } else if (typeof body.text === "string" && body.text) {
      if (body.text.length > 500000) {
        return json({ ok: false, error: "text_too_large", message: "同步文本过长（上限 500000 字符）。" }, 400);
      }
      tokens = body.text.split(/[\s,，;；、|\/\\]+/).map((t) => t.trim()).filter((t) => t.length > 0);
    } else {
      return json({ ok: false, error: "empty_input", message: "同步内容为空：请提供 codes 数组或 text 文本。" }, 400);
    }
    const db = env.DB;
    const { results: existingRows } = await db.prepare("SELECT code_norm, status, is_demo FROM codes").all();
    const known = new Map();
    for (const r of existingRows) {
      if (!known.has(r.code_norm)) known.set(r.code_norm, { status: r.status, isDemo: r.is_demo });
    }
    // 墓碑表里独有（codes 中不存在）的规范化码也算命中已下架
    const { results: tombRows } = await db.prepare("SELECT code_norm FROM tombstones").all();
    const tombOnly = new Set(tombRows.map((r) => r.code_norm).filter((n) => !known.has(n)));

    const seenInBatch = new Set();
    let added = 0, existingDuplicates = 0, batchDuplicates = 0, tombstoneDuplicates = 0, invalidCount = 0;
    const toInsert = [];
    for (const token of tokens) {
      const normalized = normalizeCode(token);
      if (!isValidCodeFormat(normalized)) { invalidCount++; continue; }
      if (seenInBatch.has(normalized)) { batchDuplicates++; continue; }
      seenInBatch.add(normalized);
      const hit = known.get(normalized);
      if (hit) {
        if (hit.status === "retired" || hit.isDemo === 1) tombstoneDuplicates++;
        else existingDuplicates++;
        continue;
      }
      if (tombOnly.has(normalized)) { tombstoneDuplicates++; continue; }
      toInsert.push(normalized);
    }
    if (toInsert.length > 0) {
      const nowIso = new Date().toISOString();
      const stmts = toInsert.map((normalized) =>
        db.prepare(
          "INSERT OR IGNORE INTO codes (code, code_norm, source, is_demo, status, verification, claims, copies, success_count, fail_count, added_at, last_success_at) VALUES (?, ?, 'public', 0, 'available', 'unverified', 0, 0, 0, 0, ?, NULL)"
        ).bind(normalized, normalized, nowIso)
      );
      // D1 batch 单次语句数有限，分块执行
      for (let i = 0; i < stmts.length; i += 100) {
        await db.batch(stmts.slice(i, i + 100));
      }
      added = toInsert.length;
    }
    return json({
      ok: true,
      received: tokens.length,
      added,
      existingDuplicates,
      poolDuplicates: existingDuplicates,
      batchDuplicates,
      tombstoneDuplicates,
      tombstoned: tombstoneDuplicates,
      invalidCount,
      invalid: invalidCount,
    });
  } catch (e) {
    return json({ ok: false, error: "internal_error", message: String(e && e.message ? e.message : e) }, 500);
  }
}
export async function onRequest() { return methodNotAllowed(); }
