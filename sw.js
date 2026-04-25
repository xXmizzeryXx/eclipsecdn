const CACHE_NAME = "eclipse-cdn-v1";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const GITHUB_API = "https://api.github.com";

const MIME_MAP = {
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  cjs: "application/javascript; charset=utf-8",
  ts: "application/typescript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  map: "application/json; charset=utf-8",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

function getMimeType(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function parseGitHubPath(pathname) {
  const cleaned = pathname.replace(/^\/gh\//, "");
  const parts = cleaned.split("/");

  if (parts.length < 3) return null;

  const user = parts[0];
  let repo = parts[1];
  let ref = null;

  if (repo.includes("@")) {
    const atIdx = repo.indexOf("@");
    ref = repo.slice(atIdx + 1);
    repo = repo.slice(0, atIdx);
    const file = parts.slice(2).join("/");
    if (!file) return null;
    return { user, repo, ref, file };
  }

  const rest = parts.slice(2).join("/");
  const tagMatch = rest.match(/^@([^/]+)\/(.+)$/);
  if (tagMatch) {
    return { user, repo, ref: tagMatch[1], file: tagMatch[2] };
  }

  const slashRef = rest.split("/");
  if (slashRef.length >= 2) {
    return { user, repo, ref: slashRef[0], file: slashRef.slice(1).join("/") };
  }

  return null;
}

async function resolveLatestTag(user, repo) {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${user}/${repo}/releases/latest`);
    if (res.ok) {
      const data = await res.json();
      return data.tag_name;
    }
  } catch {}
  try {
    const res = await fetch(`${GITHUB_API}/repos/${user}/${repo}/tags`);
    if (res.ok) {
      const tags = await res.json();
      if (tags.length) return tags[0].name;
    }
  } catch {}
  return "main";
}

function buildErrorResponse(status, message) {
  return new Response(JSON.stringify({ error: message, status }, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  if (!url.pathname.startsWith("/gh/")) return;

  event.respondWith(handleCDN(event.request, url));
});

async function handleCDN(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const parsed = parseGitHubPath(url.pathname);
  if (!parsed) return buildErrorResponse(400, "Invalid path format. Usage: /gh/:user/:repo@:version/:file");

  let { user, repo, ref, file } = parsed;

  if (ref === "latest") {
    ref = await resolveLatestTag(user, repo);
  }

  const rawUrl = `${GITHUB_RAW}/${user}/${repo}/${ref}/${file}`;
  const cacheKey = new Request(rawUrl);
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return decorateResponse(cached, file, ref);

  let res;
  try {
    res = await fetch(rawUrl);
  } catch {
    return buildErrorResponse(502, "Failed to reach GitHub");
  }

  if (!res.ok) {
    if (res.status === 404) return buildErrorResponse(404, `File not found: ${user}/${repo}@${ref}/${file}`);
    if (res.status === 403) return buildErrorResponse(403, "GitHub rate limit or access denied");
    return buildErrorResponse(res.status, "Upstream error from GitHub");
  }

  const isImmutable = ref !== "main" && ref !== "master" && ref !== "HEAD";
  const cloned = res.clone();

  if (isImmutable) await cache.put(cacheKey, cloned);

  return decorateResponse(res, file, ref);
}

function decorateResponse(res, file, ref) {
  const isImmutable = ref !== "main" && ref !== "master" && ref !== "HEAD";
  const cacheControl = isImmutable
    ? "public, max-age=86400, immutable"
    : "public, max-age=3600, stale-while-revalidate=86400";

  const headers = new Headers(res.headers);
  headers.set("Content-Type", getMimeType(file));
  headers.set("Cache-Control", cacheControl);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Timing-Allow-Origin", "*");
  headers.set("X-Eclipse-CDN", "1");
  headers.set("X-Eclipse-Source", file);

  return new Response(res.body, { status: res.status, headers });
}
