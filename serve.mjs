// Servidor local mínimo para probar la app en el PC: npm start → http://localhost:8080
// Sin dependencias: usa solo módulos incluidos en Node.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Maps a URL path to a file inside root, or null if it would escape root. */
export function resolveSafePath(root, urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  } catch {
    return null;
  }
  // Reject traversal before URL normalisation hides it.
  if (pathname.split(/[\\/]/).includes("..") || decodeURIComponent(urlPath).includes("..")) {
    return null;
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  const full = path.join(root, pathname);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

function start(port = 8080) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  createServer(async (req, res) => {
    const file = resolveSafePath(root, req.url ?? "/");
    if (!file) {
      res.writeHead(403).end("Prohibido");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("No encontrado");
    }
  }).listen(port, "127.0.0.1", () => {
    console.log(`App en http://localhost:${port}  (Ctrl+C para parar)`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start(Number(process.env.PORT) || 8080);
}
