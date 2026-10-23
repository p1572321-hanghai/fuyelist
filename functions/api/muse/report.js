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

// POST /api/muse/report — 对应原型 reportResult（结构化回报）
// 失败原因枚举与原型 FAIL_REASONS 完全一致：
//   硬失效 used_up / invalid / revoked -> 立即下架并写墓碑；
//   软失败 already_redeemed / expired_48h / too_many_attempts / other
//   -> fail_count +1；注意原型口径是累计失败满 2 次即下架（hardFail || newFail >= 2）。
// 成功回报：success_count +1、刷新 last_success_at；公开码由此升级为已验证
//（verification='verified'，与原型按 successCount>0 推导一致）；原型不会清零 fail_count，此处同样不清。
const FAIL_REASONS = ["used_up", "invalid", "revoked", "already_redeemed", "expired_48h", "too_many_attempts", "other"];
export async function onRequestPost({ request, env }) {
  try {
    const body = await readBody(request);
    const result = body.result;
    if (result !== "success" && result !== "failure") {
      return json({ ok: false, error: "invalid_result", message: "回报结果不合法。", retired: false }, 400);
    }
    let reason = null;
    if (result === "failure") {
      reason = FAIL_REASONS.includes(body.reason) ? body.reason : "other";
    }
    if (!body.code) {
      return json({ ok: false, error: "missing_code", message: "缺少邀请码。", retired: false }, 400);
    }
    const db = env.DB;
    const codeRow = await db
      .prepare("SELECT * FROM codes WHERE code_norm = ?")
      .bind(normalizeCode(body.code))
      .first();
    if (!codeRow) return json({ ok: false, message: "找不到这个码的记录。", retired: false });

    const claimId = Number.isInteger(body.claimId) && body.claimId > 0 ? body.claimId : null;
    const nowIso = new Date().toISOString();
    if (claimId) {
      const claim = await db.prepare("SELECT * FROM claims WHERE id = ?").bind(claimId).first();
      if (claim && claim.reported_at) {
        return json({ ok: false, message: "这次领取已经回报过了，谢谢。", retired: codeRow.status === "retired" });
      }
      if (claim) {
        await db.prepare("UPDATE claims SET reported_at = ? WHERE id = ?").bind(nowIso, claim.id).run();
      }
    }

    await db
      .prepare("INSERT INTO reports (code_id, claim_id, result, reason, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(codeRow.id, claimId, result, reason, nowIso)
      .run();

    let retired = codeRow.status === "retired";
    if (result === "success") {
      await db
        .prepare("UPDATE codes SET success_count = ?, last_success_at = ?, verification = 'verified' WHERE id = ?")
        .bind(codeRow.success_count + 1, nowIso, codeRow.id)
        .run();
    } else {
      const newFail = codeRow.fail_count + 1;
      const hardFail = reason === "used_up" || reason === "invalid" || reason === "revoked";
      retired = hardFail || newFail >= 2;
      await db
        .prepare("UPDATE codes SET fail_count = ?, status = ? WHERE id = ?")
        .bind(newFail, retired ? "retired" : codeRow.status, codeRow.id)
        .run();
      if (retired) {
        await db
          .prepare("INSERT OR IGNORE INTO tombstones (code_norm, code, reason, retired_at) VALUES (?, ?, ?, ?)")
          .bind(codeRow.code_norm, codeRow.code, hardFail ? reason : "repeated_failures", nowIso)
          .run();
      }
    }
    return json({
      ok: true,
      message: result === "success"
        ? "太好了，回报成功！你的反馈会帮码池保持准确。"
        : retired
          ? "已收到回报，这个码问题较多，已先下架不再发放。"
          : "已收到回报，这个码的发放优先级已降低。",
      retired,
    });
  } catch (e) {
    return json({ ok: false, error: "internal_error", message: String(e && e.message ? e.message : e) }, 500);
  }
}
export async function onRequest() { return methodNotAllowed(); }
