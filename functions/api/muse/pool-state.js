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

// POST /api/muse/pool-state — 对应原型 getPoolState
export async function onRequestPost({ env }) {
  try {
    const db = env.DB;
    const { results: codes } = await db.prepare("SELECT * FROM codes").all();
    const rep = await db.prepare("SELECT COUNT(*) AS n FROM reports").first();
    const activeReal = codes.filter((c) => c.status === "available" && c.is_demo === 0);
    const pendingPublicCount = activeReal.filter((c) => isPendingVerification(c)).length;
    const availableCount = activeReal.length - pendingPublicCount;
    const totalClaimed = codes.reduce((s, c) => s + c.claims, 0);
    const totalSuccess = codes.reduce((s, c) => s + c.success_count, 0);
    const realCodes = codes.filter((c) => c.is_demo === 0);
    const totalShared = realCodes.length;
    const todayKey = shanghaiDateKey(new Date());
    const todayNewCount = realCodes.filter((c) => shanghaiDateKey(new Date(c.added_at)) === todayKey).length;
    let latest = null;
    for (const c of realCodes) {
      const t = Date.parse(c.added_at);
      if (latest === null || t > latest) latest = t;
    }
    return json({
      availableCount,
      pendingPublicCount,
      totalActiveCount: activeReal.length,
      totalCodes: codes.length,
      totalClaimed,
      totalSuccess,
      totalShared,
      totalReports: rep ? rep.n : 0,
      todayNewCount,
      latestCreatedAt: toIso(latest),
    });
  } catch (e) {
    return json({ ok: false, error: "internal_error", message: String(e && e.message ? e.message : e) }, 500);
  }
}
export async function onRequest() { return methodNotAllowed(); }

// 与原型一致：按 Asia/Shanghai 的日期判断“今日新入池”
function shanghaiDateKey(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
