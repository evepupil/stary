import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function contentTypeFor(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

export function resolveAssetPath(rootDirectory, requestTarget) {
  const queryIndex = requestTarget.search(/[?#]/u);
  const rawPath = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath).replaceAll("\\", "/");
  } catch {
    throw httpError(400, "invalid URL encoding");
  }
  if (decodedPath.includes("\0")) {
    throw httpError(400, "invalid path");
  }

  const segments = decodedPath.split("/").filter((segment) => segment.length > 0);
  if (segments.includes("..")) {
    throw httpError(403, "path traversal is forbidden");
  }
  if (segments.length === 0) {
    segments.push("web", "index.html");
  } else if (segments[0] !== "web" && segments[0] !== "dist") {
    throw httpError(404, "path is not exposed by the acceptance server");
  } else if (decodedPath.endsWith("/")) {
    segments.push("index.html");
  }

  const root = path.resolve(rootDirectory);
  const assetPath = path.resolve(root, ...segments);
  if (assetPath !== root && !assetPath.startsWith(`${root}${path.sep}`)) {
    throw httpError(403, "path traversal is forbidden");
  }
  return assetPath;
}

export function createStaticHandler(rootDirectory) {
  return async function handleStaticRequest(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }

    try {
      const assetPath = resolveAssetPath(rootDirectory, request.url ?? "/");
      const body = await readFile(assetPath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.byteLength,
        "Content-Type": contentTypeFor(assetPath),
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : error?.code === "ENOENT"
          ? 404
          : 500;
      response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(statusCode === 500 ? "Internal server error" : error.message);
    }
  };
}

function parsePort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }
  return port;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const host = "127.0.0.1";
  const port = parsePort(process.argv[2] ?? process.env.PORT ?? "4173");
  const rootDirectory = fileURLToPath(new URL("../", import.meta.url));
  const server = createServer(createStaticHandler(rootDirectory));
  server.listen(port, host, () => {
    console.log(`STARY REBOUND/WASM acceptance page: http://${host}:${port}/web/`);
  });
}
