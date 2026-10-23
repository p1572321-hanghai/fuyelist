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

// POST /api/muse/showcase — 对应原型 getShowcase（每批 12 个，offset 轮换）
const SHOWCASE_SIZE = 12;
export async function onRequestPost({ request, env }) {
  try {
    const body = await readBody(request);
    const offsetRaw = Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
    const enriched = await loadEnrichedActiveCodes(env.DB);
    const total = enriched.length;
    const pendingCount = enriched.filter((e) => e.tier === 1).length;
    if (total === 0) {
      return json({ codes: [], totalAvailable: 0, curatedCount: 0, pendingCount: 0, offset: 0 });
    }
    const start = offsetRaw % total;
    const rotated = [...enriched.slice(start), ...enriched.slice(0, start)];
    const page = rotated.slice(0, SHOWCASE_SIZE);
    return json({
      codes: page.map((e) => ({
        id: e.row.id,
        code: e.row.code,
        claimCount: e.row.claims,
        successCount: e.row.success_count,
        createdAt: toIso(e.createdMs),
        lastSuccessAt: toIso(e.lastSuccessMs),
        freshness: e.freshness,
        source: outSource(e.row),
        pendingVerification: isPendingVerification(e.row),
      })),
      totalAvailable: total,
      curatedCount: total - pendingCount,
      pendingCount,
      offset: start,
    });
  } catch (e) {
    return json({ ok: false, error: "internal_error", message: String(e && e.message ? e.message : e) }, 500);
  }
}
export async function onRequest() { return methodNotAllowed(); }
