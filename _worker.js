export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Range, Origin, Referer, Accept, If-Range, If-None-Match, If-Modified-Since",
      "Access-Control-Allow-Methods":
        "GET, HEAD, OPTIONS",
      "Access-Control-Expose-Headers":
        "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      console.log("[ROUTER]", { method: request.method, pathname: url.pathname, search: url.search });

      if (url.pathname === "/api") {
        return await handleApi(url, cors);
      }

      if (url.pathname === "/stream") {
        return await handleStream(request, url, cors);
      }

      if (url.pathname === "/test") {
        return new Response("Worker OK - Raxson FINAL VOD Proxy", {
          status: 200,
          headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (url.pathname === "/debug") {
        return await handleDebug(request, url, cors);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", { status: 404, headers: cors });
    } catch (error) {
      console.error("[WORKER ERROR]", { message: error?.message || String(error), stack: error?.stack || "" });
      return json({ error: "Worker Error", details: error?.message || String(error) }, 500, cors);
    }
  },
};

const ALLOWED_HOSTS = new Set([
  "barqtv.website",
  "barqtvclg.shop",
]);

async function handleApi(url, cors) {
  const host = url.searchParams.get("host")?.trim();
  const user = url.searchParams.get("user")?.trim();
  const pass = url.searchParams.get("pass")?.trim();
  const action = url.searchParams.get("action")?.trim();
  const extra = url.searchParams.get("extra") || "";

  if (!host || !user || !pass || !action) {
    return json({ error: "Missing parameters" }, 400, cors);
  }

  let cleanHost;
  try { cleanHost = normalizeHost(host); } catch (error) {
    return json({ error: "Invalid host", details: error.message }, 400, cors);
  }

  const hostUrl = new URL(cleanHost);
  if (!ALLOWED_HOSTS.has(hostUrl.hostname.toLowerCase())) {
    return json({ error: "Host not allowed", host: hostUrl.hostname }, 403, cors);
  }

  const apiUrl = new URL("/player_api.php", cleanHost + "/");
  apiUrl.searchParams.set("username", user);
  apiUrl.searchParams.set("password", pass);
  apiUrl.searchParams.set("action", action);
  appendExtraParams(apiUrl, extra);

  console.log("[API REQUEST]", { action, host: apiUrl.hostname, pathname: apiUrl.pathname, query: apiUrl.search });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(apiUrl.toString(), {
      method: "GET", redirect: "follow", cache: "no-store", signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ar,en;q=0.9",
        "Referer": cleanHost + "/",
      },
    });

    console.log("[API RESPONSE]", { action, status: response.status, finalUrl: response.url, contentType: response.headers.get("content-type") || "" });

    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { ...cors, "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache" },
    });
  } catch (error) {
    console.error("[API ERROR]", { action, error: error?.message || String(error) });
    return json({ error: "API fetch failed", details: error?.message || String(error) }, 502, cors);
  } finally { clearTimeout(timeout); }
}

async function handleStream(request, url, cors) {
  const target = url.searchParams.get("url")?.trim();
  if (!target) return json({ error: "Missing url parameter" }, 400, cors);

  let targetUrl;
  try { targetUrl = new URL(target); } catch (_) { return json({ error: "Invalid media URL" }, 400, cors); }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return json({ error: "Unsupported protocol" }, 403, cors);
  }

  const hostname = targetUrl.hostname.toLowerCase();

  // Extract and validate source host for HLS segments
  const sourceHost = url.searchParams.get("host")?.trim().toLowerCase();
  const isLiveHlsSegment = 
    url.searchParams.get("hls") === "1" &&
    isIpAddress(hostname) &&
    /^\/hls(?:\/|$)/i.test(targetUrl.pathname) &&
    !!sourceHost &&
    ALLOWED_HOSTS.has(sourceHost);

  if (!ALLOWED_HOSTS.has(hostname) && !isLiveHlsSegment) {
    return json({ error: "Media host not allowed", host: hostname }, 403, cors);
  }

  if (isLiveHlsSegment) {
    console.log("[LIVE HLS SEGMENT]", { ip: hostname, path: targetUrl.pathname, sourceHost });
    return await proxyLiveSegmentWithResolveOverride(request, targetUrl, cors, sourceHost);
  }

  if (/^\/live(?:\/|$)/i.test(targetUrl.pathname)) {
    console.log("[LIVE PROXY START]", { host: hostname, path: targetUrl.pathname });
    return await handleLiveStream(request, targetUrl, cors);
  }

  const isMovie = /^\/movie(?:\/|$)/i.test(targetUrl.pathname);
  const isSeries = /^\/series(?:\/|$)/i.test(targetUrl.pathname);

  if (!isMovie && !isSeries) {
    return json({ error: "Only movie and series media are allowed", path: targetUrl.pathname }, 403, cors);
  }

  console.log("[VOD PROXY START]", { type: isMovie ? "movie" : "series", host: hostname, path: targetUrl.pathname, range: request.headers.get("Range") || "" });

  const upstreamHeaders = buildUpstreamHeaders(request, targetUrl);

  try {
    const firstResponse = await fetch(targetUrl.toString(), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders, redirect: "manual", cache: "no-store",
    });

    console.log("[VOD FIRST RESPONSE]", { status: firstResponse.status, location: firstResponse.headers.get("location") || "", contentType: firstResponse.headers.get("content-type") || "" });

    if (firstResponse.status >= 200 && firstResponse.status < 300) {
      return makeBrowserResponse(firstResponse, request, cors);
    }

    if (firstResponse.status >= 300 && firstResponse.status < 400) {
      const location = firstResponse.headers.get("location");
      if (!location) return json({ error: "VOD redirect without Location", status: firstResponse.status }, 502, cors);

      const redirectUrl = new URL(location, targetUrl.toString());
      console.log("[VOD REDIRECT]", { from: targetUrl.toString(), to: redirectUrl.toString() });

      if (!isIpAddress(redirectUrl.hostname)) {
        return await fetchHostnameRedirect(request, redirectUrl, upstreamHeaders, cors);
      }

      console.log("[VOD IP REDIRECT]", { ip: redirectUrl.hostname, port: redirectUrl.port || "80", protocol: redirectUrl.protocol, path: redirectUrl.pathname + redirectUrl.search });
      return await proxyVodIpWithResolveOverride(request, redirectUrl, cors, hostname);
    }

    const errorText = await safeReadText(firstResponse);
    console.error("[VOD UPSTREAM ERROR]", { status: firstResponse.status, body: errorText.substring(0, 500) });
    return new Response(errorText || `Upstream HTTP ${firstResponse.status}`, {
      status: firstResponse.status,
      headers: { ...cors, "Content-Type": firstResponse.headers.get("content-type") || "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[VOD PROXY ERROR]", { message: error?.message || String(error), target: targetUrl.toString() });
    return json({ error: "VOD proxy failed", details: error?.message || String(error) }, 502, cors);
  }
}

async function handleLiveStream(request, targetUrl, cors) {
  const targetOrigin = getOrigin(targetUrl.toString());
  const upstreamHeaders = buildLiveUpstreamHeaders(request, targetOrigin);

  let firstResponse;
  try {
    firstResponse = await fetch(targetUrl.toString(), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders, redirect: "manual", cache: "no-store",
    });
  } catch (error) {
    console.error("[LIVE FIRST FETCH ERROR]", { message: error?.message || String(error) });
    return json({ error: "Live provider request failed", details: error?.message || String(error) }, 502, cors);
  }

  console.log("[LIVE FIRST RESPONSE]", { status: firstResponse.status, location: firstResponse.headers.get("location") || "", contentType: firstResponse.headers.get("content-type") || "" });

  if (firstResponse.status >= 200 && firstResponse.status < 300) {
    const playlist = await firstResponse.text();
    return rewriteLivePlaylist(playlist, targetUrl, targetUrl, new URL(request.url).origin, cors);
  }

  if (firstResponse.status >= 300 && firstResponse.status < 400) {
    const location = firstResponse.headers.get("location");
    if (!location) return json({ error: "Live redirect without Location" }, 502, cors);

    const redirectUrl = new URL(location, targetUrl.toString());
    console.log("[LIVE REDIRECT]", { to: redirectUrl.toString() });

    if (isIpAddress(redirectUrl.hostname)) {
      const result = await fetchLivePlaylistWithResolveOverride(request, redirectUrl, targetUrl.hostname);
      if (!result) return json({ error: "Could not retrieve live playlist" }, 502, cors);

      console.log("[LIVE M3U8 RESPONSE]", { status: result.status, contentType: result.headers.get("content-type") || "", contentLength: result.headers.get("content-length") || "" });

      if (result.status < 200 || result.status >= 300) {
        return new Response(result.bodyText || `Live upstream HTTP ${result.status}`, {
          status: result.status,
          headers: { ...cors, "Content-Type": result.headers.get("content-type") || "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return rewriteLivePlaylist(result.bodyText, redirectUrl, targetUrl, new URL(request.url).origin, cors);
    }

    try {
      const redirectOrigin = getOrigin(redirectUrl.toString());
      const redirectHeaders = buildLiveUpstreamHeaders(request, redirectOrigin);
      const response = await fetch(redirectUrl.toString(), { method: request.method === "HEAD" ? "HEAD" : "GET", headers: redirectHeaders, redirect: "manual", cache: "no-store" });
      if (response.status >= 200 && response.status < 300) {
        const playlist = await response.text();
        return rewriteLivePlaylist(playlist, redirectUrl, targetUrl, new URL(request.url).origin, cors);
      }
      return new Response(await safeReadText(response), { status: response.status, headers: { ...cors, "Content-Type": response.headers.get("content-type") || "text/plain; charset=utf-8" } });
    } catch (error) {
      console.error("[LIVE HOST REDIRECT ERROR]", { message: error?.message || String(error) });
      return json({ error: "Live hostname redirect failed", details: error?.message || String(error) }, 502, cors);
    }
  }

  return new Response(await safeReadText(firstResponse), { status: firstResponse.status, headers: { ...cors, "Content-Type": firstResponse.headers.get("content-type") || "text/plain; charset=utf-8" } });
}

function buildLiveUpstreamHeaders(request, targetOrigin) {
  const headers = new Headers();
  headers.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36");
  headers.set("Accept", "application/vnd.apple.mpegurl,application/x-mpegurl,*/*;q=0.8");
  headers.set("Accept-Encoding", "identity");
  headers.set("Accept-Language", request.headers.get("Accept-Language") || "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7");
  headers.set("Referer", targetOrigin + "/");
  return headers;
}

async function fetchLivePlaylistWithResolveOverride(request, redirectUrl, originalHostname) {
  const ip = redirectUrl.hostname;
  const port = Number(redirectUrl.port || 80);
  if (!isIpAddress(ip)) throw new Error("Live IP redirect target is not an IP");
  if (port !== 80) throw new Error("Only HTTP port 80 is supported for Live IP redirect");

  const fetchUrl = new URL(redirectUrl);
  fetchUrl.hostname = originalHostname;

  const origin = `http://${originalHostname}`;

  console.log("[LIVE IP REDIRECT → resolveOverride]", { ip, fetchUrl: fetchUrl.href, originalHostname });

  try {
    const response = await fetch(fetchUrl.href, {
      method: "GET",
      headers: buildLiveUpstreamHeaders({ headers: new Headers() }, origin),
      redirect: "manual",
      cache: "no-store",
      cf: { resolveOverride: ip },
    });

    const bodyText = await safeReadText(response);
    return { status: response.status, headers: response.headers, bodyText };
  } catch (error) {
    console.error("[LIVE RESOLVE OVERRIDE ERROR]", { message: error?.message || String(error) });
    return null;
  }
}

async function proxyLiveSegmentWithResolveOverride(request, targetUrl, cors, originalHost) {
  const ip = targetUrl.hostname;
  const port = Number(targetUrl.port || 80);

  if (!isIpAddress(ip)) return json({ error: "Live segment target is not an IP" }, 400, cors);
  if (!ALLOWED_HOSTS.has(originalHost)) {
    return json({ error: "Unauthorized source host" }, 403, cors);
  }

  const fetchUrl = new URL(targetUrl);
  fetchUrl.hostname = originalHost;

  console.log("[LIVE SEGMENT IP REDIRECT → resolveOverride]", { ip, fetchUrl: fetchUrl.href, originalHost });

  try {
    const response = await fetch(fetchUrl.href, {
      method: request.method,
      headers: buildLiveUpstreamHeaders({ headers: request.headers }, `http://${originalHost}`),
      redirect: "manual",
      cache: "no-store",
      cf: { resolveOverride: ip },
    });

    return makeBrowserResponse(response, request, cors);
  } catch (error) {
    console.error("[LIVE SEGMENT RESOLVE OVERRIDE ERROR]", { message: error?.message || String(error), ip, originalHost });
    return json({ error: "Live segment fetch failed", details: error?.message || String(error) }, 502, cors);
  }
}

async function proxyVodIpWithResolveOverride(request, redirectUrl, cors, originalHost) {
  const ip = redirectUrl.hostname;
  const port = Number(redirectUrl.port || 80);

  if (!isIpAddress(ip)) return json({ error: "VOD IP redirect target is not an IP" }, 400, cors);
  if (!ALLOWED_HOSTS.has(originalHost)) {
    return json({ error: "Unauthorized VOD source host" }, 403, cors);
  }

  const fetchUrl = new URL(redirectUrl);
  fetchUrl.hostname = originalHost;

  console.log("[VOD IP REDIRECT → resolveOverride]", { ip, fetchUrl: fetchUrl.href, originalHost });

  try {
    const response = await fetch(fetchUrl.href, {
      method: request.method,
      headers: buildUpstreamHeaders(request, `http://${originalHost}`),
      redirect: "manual",
      cache: "no-store",
      cf: { resolveOverride: ip },
    });

    return makeBrowserResponse(response, request, cors);
  } catch (error) {
    console.error("[VOD IP RESOLVE OVERRIDE ERROR]", { message: error?.message || String(error), ip, originalHost });
    return json({ error: "VOD IP fetch failed", details: error?.message || String(error) }, 502, cors);
  }
}

async function fetchHostnameRedirect(request, redirectUrl, upstreamHeaders, cors) {
  try {
    const response = await fetch(redirectUrl.toString(), { method: request.method === "HEAD" ? "HEAD" : "GET", headers: upstreamHeaders, redirect: "manual", cache: "no-store" });
    if (response.status >= 200 && response.status < 300) {
      return makeBrowserResponse(response, request, cors);
    }
    return new Response(await safeReadText(response), { status: response.status, headers: { ...cors, "Content-Type": response.headers.get("content-type") || "text/plain; charset=utf-8" } });
  } catch (error) {
    console.error("[VOD HOST REDIRECT ERROR]", { message: error?.message || String(error) });
    return json({ error: "VOD hostname redirect failed", details: error?.message || String(error) }, 502, cors);
  }
}

function buildUpstreamHeaders(request, targetUrl) {
  const headers = new Headers();
  headers.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36");
  headers.set("Accept", "video/*,*/*;q=0.8");
  headers.set("Accept-Language", request.headers.get("Accept-Language") || "ar,en;q=0.9");
  headers.set("Referer", getOrigin(targetUrl.toString()) + "/");
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  return headers;
}

function makeBrowserResponse(response, request, cors) {
  const headers = new Headers(cors);
  const copyHeaders = ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Content-Disposition"];
  for (const name of copyHeaders) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "no-store");
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}

function rewriteLivePlaylist(playlist, baseUrl, originalUrl, workerOrigin, cors) {
  const lines = playlist.split(/\r?\n/);
  const base = new URL(baseUrl);
  const originalBase = new URL(originalUrl);
  const sourceHost = originalBase.hostname;
  const output = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { output.push(line); continue; }
    if (trimmed.startsWith("#")) {
      output.push(line.replace(/URI="([^"]+)"/gi, (match, uri) => {
        try {
          const absolute = new URL(uri, base.href).href;
          return `URI="${buildSegmentProxyUrl(absolute, originalUrl, workerOrigin, sourceHost)}"`;
        } catch (_) { return match; }
      }));
      continue;
    }
    try {
      const absolute = new URL(trimmed, base.href).href;
      output.push(buildSegmentProxyUrl(absolute, originalUrl, workerOrigin, sourceHost));
    } catch (_) { output.push(line); }
  }

  const headers = new Headers(cors);
  headers.set("Content-Type", "application/vnd.apple.mpegurl");
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  return new Response(output.join("\n"), { status: 200, headers });
}

function buildSegmentProxyUrl(absoluteUrl, originalUrl, workerOrigin, sourceHost) {
  const u = new URL(workerOrigin + "/stream");
  u.searchParams.set("url", absoluteUrl);
  u.searchParams.set("hls", "1");
  if (sourceHost) u.searchParams.set("host", sourceHost);
  return u.href;
}

function normalizeHost(host) {
  if (!/^https?:\/\//i.test(host)) host = "http://" + host;
  const u = new URL(host);
  return u.origin;
}

function appendExtraParams(url, extra) {
  if (!extra) return;
  const params = extra.split("&");
  for (const p of params) {
    const [k, ...v] = p.split("=");
    if (k) url.searchParams.set(decodeURIComponent(k), decodeURIComponent(v.join("=")));
  }
}

function getOrigin(value) {
  try { return new URL(value).origin; } catch (_) { return value; }
}

async function safeReadText(response) {
  try { return await response.text(); } catch (_) { return ""; }
}

function isIpAddress(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split(".").every(p => { const n = Number(p); return Number.isInteger(n) && n >= 0 && n <= 255; });
}

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
