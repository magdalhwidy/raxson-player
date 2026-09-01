export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =========================================================
    // CORS
    // =========================================================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,Range",
      "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
      "Access-Control-Expose-Headers":
        "Content-Length,Content-Range,Accept-Ranges,Last-Modified,ETag,Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // =========================================================
    // Common headers used by app.py
    // =========================================================
    const originHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "ar,en;q=0.9",
      "Referer": "http://barqtv.website/"
    };

    // =========================================================
    // Helper: JSON response
    // =========================================================
    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate"
        }
      });
    }

    // =========================================================
    // Helper: fetch JSON with retry
    // =========================================================
    async function fetchWithRetry(targetUrl, maxRetries = 3, timeoutMs = 45000) {
      let lastError = null;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let timer = null;
        try {
          const controller = new AbortController();
          timer = setTimeout(() => { controller.abort(); }, timeoutMs);
          const response = await fetch(targetUrl, {
            method: "GET",
            headers: originHeaders,
            signal: controller.signal,
            redirect: "follow"
          });
          clearTimeout(timer);
          timer = null;
          if (!response.ok) {
            return {
              error: `HTTP ${response.status}`,
              details: response.statusText || `HTTP ${response.status}`
            };
          }
          const text = await response.text();
          try {
            return JSON.parse(text);
          } catch {
            return { raw: text };
          }
        } catch (err) {
          if (timer) clearTimeout(timer);
          lastError = err?.name === "AbortError" ? "Request timeout" : (err?.message || String(err));
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      }
      return { error: `Failed after ${maxRetries} attempts: ${lastError}` };
    }

    // =========================================================
    // /health
    // =========================================================
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "raxson-player" }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8"
          }
        }
      );
    }

    // =========================================================
    // /api
    // =========================================================
    if (url.pathname === "/api") {
      const host = (url.searchParams.get("host") || "").trim();
      const user = (url.searchParams.get("user") || "").trim();
      const pwd = (url.searchParams.get("pass") || "").trim();
      const action = (url.searchParams.get("action") || "").trim();
      const extra = url.searchParams.get("extra") || "";
      if (!host || !user || !pwd || !action) {
        return jsonResponse({ error: "Missing parameters" }, 400);
      }
      const cleanHost = host.endsWith("/") ? host.slice(0, -1) : host;
      const apiUrl =
        `${cleanHost}/player_api.php` +
        `?username=${encodeURIComponent(user)}` +
        `&password=${encodeURIComponent(pwd)}` +
        `&action=${encodeURIComponent(action)}` +
        extra;
      const timeout = action === "get_live_streams" ? 60000 : 35000;
      const result = await fetchWithRetry(apiUrl, 3, timeout);
      if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "error")) {
        return jsonResponse(result, 502);
      }
      return jsonResponse(result, 200);
    }

    // =========================================================
    // /stream  (FULLY FIXED)
    // =========================================================
    if (url.pathname === "/stream") {
      const targetUrl = (url.searchParams.get("url") || "").trim();
      if (!targetUrl) {
        return jsonResponse({ error: "Missing url parameter" }, 400);
      }

      // Build origin request headers
      const streamHeaders = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
        "Accept": "*/*",
        "Referer": "http://barqtv.website/"
      };

      // Forward Range header from browser (critical for seek/scrub)
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        streamHeaders["Range"] = rangeHeader;
      }

      try {
        // Support HEAD requests (some players send HEAD before GET)
        const method = request.method === "HEAD" ? "HEAD" : "GET";

        console.log(`[STREAM] ${method} -> ${targetUrl.substring(0, 80)}...`);

        const response = await fetch(targetUrl, {
          method: method,
          headers: streamHeaders,
          redirect: "follow"
        });

        console.log(`[STREAM] Origin status: ${response.status}, CT: ${response.headers.get("Content-Type") || "none"}`);

        const contentType = response.headers.get("Content-Type") || "";
        const lowerTargetUrl = targetUrl.toLowerCase();

        const isM3U8 =
          contentType.toLowerCase().includes("mpegurl") ||
          lowerTargetUrl.endsWith(".m3u8") ||
          lowerTargetUrl.endsWith(".m3u");

        // =====================================================
        // M3U8 / M3U
        // =====================================================
        if (isM3U8) {
          const text = await response.text();
          let baseUrl;
          try {
            baseUrl = new URL(targetUrl);
          } catch {
            return jsonResponse({ error: "Invalid stream URL" }, 400);
          }
          const basePath = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
          const lines = text.split("\n");
          const newLines = lines.map(line => {
            const stripped = line.trim();
            if (!stripped || stripped.startsWith("#")) {
              return line;
            }
            if (stripped.startsWith("http://") || stripped.startsWith("https://")) {
              return "/stream?url=" + encodeURIComponent(stripped);
            }
            try {
              const resolved = new URL(stripped, basePath).href;
              return "/stream?url=" + encodeURIComponent(resolved);
            } catch {
              return line;
            }
          });

          return new Response(
            newLines.join("\n"),
            {
              status: response.status,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/vnd.apple.mpegurl",
                "Cache-Control": "no-cache, no-store, must-revalidate"
              }
            }
          );
        }

        // =====================================================
        // Normal video stream — ROBUST PROXY
        // =====================================================
        const hopByHop = [
          "connection", "keep-alive", "proxy-authenticate",
          "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"
        ];

        const responseHeaders = { ...corsHeaders };

        // Forward safe headers from origin
        response.headers.forEach((value, key) => {
          const lowerKey = key.toLowerCase();
          if (hopByHop.includes(lowerKey)) return;
          if (lowerKey === "content-encoding") return;
          if (lowerKey === "content-length") return;
          if (lowerKey === "content-disposition") return; // Prevent forced download
          responseHeaders[key] = value;
        });

        // FORCE correct Content-Type based on extension (prevents Cloudflare compression)
        if (lowerTargetUrl.endsWith(".mp4")) {
          responseHeaders["Content-Type"] = "video/mp4";
        } else if (lowerTargetUrl.endsWith(".ts") || lowerTargetUrl.endsWith(".m2ts")) {
          responseHeaders["Content-Type"] = "video/mp2t";
        } else if (lowerTargetUrl.endsWith(".mkv")) {
          responseHeaders["Content-Type"] = "video/x-matroska";
        } else if (lowerTargetUrl.endsWith(".avi")) {
          responseHeaders["Content-Type"] = "video/x-msvideo";
        }

        // CRITICAL: Prevent Cloudflare from transforming (compressing) the stream
        responseHeaders["Cache-Control"] = "no-transform, no-store, must-revalidate, private";
        responseHeaders["X-Content-Type-Options"] = "nosniff";

        // CRITICAL: Always declare range support for video
        if (!responseHeaders["Accept-Ranges"]) {
          responseHeaders["Accept-Ranges"] = "bytes";
        }

        console.log(`[STREAM] Returning with CT: ${responseHeaders["Content-Type"] || "none"}, AR: ${responseHeaders["Accept-Ranges"] || "none"}`);

        return new Response(
          response.body,
          {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
          }
        );

      } catch (err) {
        console.error(`[STREAM] Error: ${err?.message || String(err)}`);
        return jsonResponse(
          { error: "Stream failed", details: err?.message || String(err) },
          502
        );
      }
    }

    // =========================================================
    // Static files
    // =========================================================
    try {
      const assetResponse = await env.ASSETS.fetch(request);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const headers = new Headers(assetResponse.headers);
        headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers
        });
      }
      if (url.pathname === "/manifest.json") {
        const headers = new Headers(assetResponse.headers);
        headers.set("Content-Type", "application/json");
        headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers
        });
      }
      if (url.pathname === "/sw.js") {
        const headers = new Headers(assetResponse.headers);
        headers.set("Content-Type", "application/javascript");
        headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
        headers.set("Service-Worker-Allowed", "/");
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers
        });
      }
      return assetResponse;
    } catch (err) {
      return jsonResponse(
        { error: "Asset failed", details: err?.message || String(err) },
        500
      );
    }
  }
};
