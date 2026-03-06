import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = resolve(__dirname, "dist");
const indexFile = join(distDir, "index.html");
const port = Number(process.env.PORT) || 8080;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendFile(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";
  const cacheControl =
    ext === ".html" ? "no-cache, no-store, must-revalidate" : "public, max-age=3600";

  res.writeHead(200, {
    "Cache-Control": cacheControl,
    "Content-Type": contentType,
  });

  createReadStream(filePath).on("error", () => {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }).pipe(res);
}

const server = createServer((req, res) => {
  if (!existsSync(indexFile)) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Build output not found. Ensure npm run build executed.");
    return;
  }

  const requestUrl = new URL(req.url || "/", "http://localhost");
  const decodedPath = decodeURIComponent(requestUrl.pathname);
  const normalizedPath = normalize(decodedPath);
  const filePath = resolve(distDir, `.${normalizedPath}`);
  const inDistFolder = filePath === distDir || filePath.startsWith(distDir + sep);

  if (inDistFolder && existsSync(filePath) && statSync(filePath).isFile()) {
    sendFile(res, filePath);
    return;
  }

  sendFile(res, indexFile);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Server started on 0.0.0.0:${port}`);
});

