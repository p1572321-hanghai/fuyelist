import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.env.FUYELIST_PREVIEW_PORT || 4317);
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', json: 'application/json; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', ico: 'image/x-icon' };

http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // Preview may read the public pool, but never mutate the live invite database.
    if (pathname.startsWith('/api/')) {
      const allowed = ['/api/muse/pool-state', '/api/muse/showcase'];
      if (req.method !== 'POST' || !allowed.includes(pathname)) {
        res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '本地预览不执行领码、复制计数、提交或回报。' }));
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('Request too large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const body = pathname.endsWith('/showcase') ? { offset: Math.max(0, Math.min(Number(input.offset) || 0, 10000)) } : {};
      const response = await fetch('https://fuyelist.com' + pathname, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
      });
      res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(await response.text());
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    let file = path.resolve(root, '.' + pathname);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    const stat = await fs.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('.html')) {
      // This preview-only notice is never part of the published assets.
      body = Buffer.from(body.toString().replace('</body>', '<div style="position:fixed;bottom:10px;left:12px;z-index:90;background:#174f43ed;color:#fff;padding:7px 12px;border-radius:9px;font:11px system-ui;box-shadow:0 3px 14px #174f4320">本地设计预览 · 未发布 · 邀请码仅可浏览</div></body>'));
    }
    res.writeHead(200, { 'content-type': types[path.extname(file).slice(1)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 502, { 'content-type': 'text/plain; charset=utf-8' }).end(error.code === 'ENOENT' ? 'Not found' : 'Preview service unavailable');
  }
}).listen(port, '127.0.0.1', () => console.log('Local preview: http://127.0.0.1:' + port));
