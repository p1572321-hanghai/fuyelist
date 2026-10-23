// Muse 邀请码互助 — Cloudflare Pages Function（部署版，自包含单文件）
// 逻辑移植自 muse-mvp 原型 server/src/actions.ts，语义保持一致；
// 与原型的命名映射：source 'owner'->'own'、status 'active'->'available'、
// claim_count->claims；API 响应里的 source 仍按原型输出 'owner'/'public'。
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

// --- 与原型一致的规范化与校验 ---
function normalizeCode(raw) {
  return String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "");
}
const CODE_FORMAT = /^[A-Z0-9]{6}$/;
function isValidCodeFormat(normalized) {
  return CODE_FORMAT.test(normalized);
}

// 待验证 = 公开批量导入且从未有成功回报（与原型 isPendingVerification 一致）
function isPendingVerification(row) {
  return row.source === "public" && row.success_count === 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 与原型 computeFreshness 逐条对应（时间参数改为毫秒数）
function computeFreshness(createdMs, lastSuccessMs, lastActivityMs, nowMs) {
  const ageDays = (nowMs - createdMs) / DAY_MS;
  const hasSuccess = lastSuccessMs !== null;
  if (ageDays > 14 && !hasSuccess) return "stale";
  if (ageDays <= 3) return "fresh";
  if (hasSuccess && (nowMs - lastSuccessMs) / DAY_MS <= 7) return "fresh";
  if ((ageDays > 7 && !hasSuccess) || (nowMs - lastActivityMs) / DAY_MS > 7) return "pending";
  return "pending";
}

// 与原型 computeSortScore 逐条对应（分数越小越靠前）
function computeSortScore(row, createdMs, lastSuccessMs, nowMs) {
  const ageDays = (nowMs - createdMs) / DAY_MS;
  let score = row.claims * 10;
  score += row.fail_count * 15;
  if (lastSuccessMs !== null) {
    const sinceSuccess = (nowMs - lastSuccessMs) / DAY_MS;
    if (sinceSuccess <= 7) score -= 20;
    else if (sinceSuccess <= 14) score -= 10;
    else score -= 3;
  } else {
    if (ageDays > 14) score += 40;
    else if (ageDays > 7) score += 20;
    else if (ageDays > 3) score += 5;
  }
  return score;
}

// 与原型 loadEnrichedActiveCodes 对应：可用且非演示的码，
// 由 reports 推导最近成功/最近动静，分层（待验证垫底）+ 分数排序。
async function loadEnrichedActiveCodes(db) {
  const { results: rows } = await db
    .prepare("SELECT * FROM codes WHERE status = 'available' AND is_demo = 0")
    .all();
  const { results: reportRows } = await db
    .prepare("SELECT code_id, result, created_at FROM reports")
    .all();
  const lastSuccess = new Map();
  const lastActivity = new Map();
  for (const r of reportRows) {
    const t = Date.parse(r.created_at);
    const pa = lastActivity.get(r.code_id);
    if (pa === undefined || t > pa) lastActivity.set(r.code_id, t);
    if (r.result === "success") {
      const p = lastSuccess.get(r.code_id);
      if (p === undefined || t > p) lastSuccess.set(r.code_id, t);
    }
  }
  const now = Date.now();
  const enriched = rows.map((row) => {
    const createdMs = Date.parse(row.added_at);
    const ls = lastSuccess.has(row.id) ? lastSuccess.get(row.id) : null;
    const la = lastActivity.has(row.id) ? lastActivity.get(row.id) : createdMs;
    const activity = la > createdMs ? la : createdMs;
    return {
      row,
      createdMs,
      lastSuccessMs: ls,
      lastActivityMs: activity,
      freshness: computeFreshness(createdMs, ls, activity, now),
      score: computeSortScore(row, createdMs, ls, now),
      tier: isPendingVerification(row) ? 1 : 0,
    };
  });
  enriched.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.score - b.score ||
      a.row.claims - b.row.claims ||
      a.row.fail_count - b.row.fail_count ||
      a.row.id - b.row.id
  );
  return enriched;
}

function toIso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}
// 对外 source 命名与原型保持一致
function outSource(row) {
  return row.source === "own" ? "owner" : "public";
}

// POST /api/muse/import — 对应原型 bulkImportCodes（站主批量导入）
// 鉴权：请求头 X-Admin-Key 必须与环境变量 ADMIN_KEY 完全一致，否则 401。
// 去重语义与原型一致：规范化后与全部历史行比对（含 retired 与演示码），
// 命中 retired/演示码计入 tombstoneDuplicates，命中可用码计入 existingDuplicates；
// 返回值同时带原型键名与部署简述键名（poolDuplicates/tombstoned/invalid 为别名）。
export async function onRequestPost({ request, env }) {
  try {
    const key = request.headers.get("X-Admin-Key");
    if (!env.ADMIN_KEY || !key || key !== env.ADMIN_KEY) {
      return json({ ok: false, error: "unauthorized", message: "未授权：需要正确的 X-Admin-Key 请求头。" }, 401);
    }
    const body = await readBody(request);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) {
      return json({ ok: false, error: "empty_text", message: "导入文本为空。" }, 400);
    }
    if (text.length > 500000) {
      return json({ ok: false, error: "text_too_large", message: "导入文本过长（上限 500000 字符）。" }, 400);
    }
    const tokens = text.split(/[\s,，;；、|\/\\]+/).map((t) => t.trim()).filter((t) => t.length > 0);
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
