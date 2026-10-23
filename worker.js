// fuyelist 站点 Worker 入口（极薄转发层）
// 作用：仅接管 /api/muse/* 的请求并转给 functions/api/muse/ 下的接口模块；
// 其余全部路径原样交给静态资产（env.ASSETS），与加入口之前的纯静态行为一致。
// 接口模块沿用 Pages Functions 的导出形态（onRequestPost / onRequest），
// 本文件只做按路径分发，不含业务逻辑。

import * as poolState from "./functions/api/muse/pool-state.js";
import * as showcase from "./functions/api/muse/showcase.js";
import * as claim from "./functions/api/muse/claim.js";
import * as copy from "./functions/api/muse/copy.js";
import * as report from "./functions/api/muse/report.js";
import * as submit from "./functions/api/muse/submit.js";
import * as bulkImport from "./functions/api/muse/import.js";

const routes = {
  "/api/muse/pool-state": poolState,
  "/api/muse/showcase": showcase,
  "/api/muse/claim": claim,
  "/api/muse/copy": copy,
  "/api/muse/report": report,
  "/api/muse/submit": submit,
  "/api/muse/import": bulkImport,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const mod = routes[pathname];
    if (mod) {
      const context = { request, env, ctx, waitUntil: ctx.waitUntil.bind(ctx) };
      if (request.method === "POST" && typeof mod.onRequestPost === "function") {
        return mod.onRequestPost(context);
      }
      if (typeof mod.onRequest === "function") {
        return mod.onRequest(context);
      }
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
