export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,Range",
      "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
      "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,Last-Modified,ETag,Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const originHeaders = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "ar,en;q=0.9",
      "Referer": "http://barqtv.website/"
    };

    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" }
      });
    }

    // Helper: normalize URL (remove :80/:443)
    function normalizeUrl(urlStr) {
      let s = urlStr.trim();
      if (s.endsWith("/")) s = s.slice(0, -1);
      // Remove :80 from http URLs
      if (s.startsWith("http://") && s.endsWith(":80")) {
        s = s.slice(0, -3);
      }
      // Remove :443 from https URLs
      if (s.startsWith("https://") && s.endsWith(":443")) {
        s = s.slice(0, -4);
      }
      return s;
    }

    function getBasePath(urlStr) {
      const lastSlash = urlStr.lastIndexOf("/");
      return lastSlash >= 0 ? urlStr.substring(0, lastSlash + 1) : urlStr + "/";
    }

    async function fetchWithRetry(targetUrl, maxRetries = 3, timeoutMs = 45000) {
      let lastError = null;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let timer = null;
        try {
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch(targetUrl, { method: "GET", headers: originHeaders, signal: controller.signal, redirect: "follow" });
          clearTimeout(timer);

          if (!response.ok) {
            return { error: `HTTP ${response.status}`, details: response.statusText };
          }

          const text = await response.text();
          try {
            return JSON.parse(text);
          } catch (jsonErr) {
            return { raw: text, notJson: true };
          }
        } catch (err) {
          if (timer) clearTimeout(timer);
          lastError = err?.name === "AbortError" ? "Request timeout" : (err?.message || String(err));
          if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 1500));
        }
      }
      return { error: `Failed after ${maxRetries} attempts: ${lastError}` };
    }

    // Health Check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "raxson-player" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // API Proxy
    if (url.pathname === "/api") {
      const host = (url.searchParams.get("host") || "").trim();
      const user = (url.searchParams.get("user") || "").trim();
      const pwd = (url.searchParams.get("pass") || "").trim();
      const action = (url.searchParams.get("action") || "").trim();
      const extra = url.searchParams.get("extra") || "";

      if (!host || !user || !pwd || !action) {
        return jsonResponse({ error: "Missing parameters" }, 400);
      }

      const cleanHost = normalizeUrl(host);
      const apiUrl = `${cleanHost}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pwd)}&action=${encodeURIComponent(action)}${extra}`;

      const timeout = action === "get_live_streams" ? 60000 : 35000;
      const result = await fetchWithRetry(apiUrl, 3, timeout);

      if (result && typeof result === "object" && "error" in result) {
        return jsonResponse({
          error: result.error,
          details: result.details,
          debugUrl: apiUrl.replace(/password=[^&]+/, "password=***")
        }, 502);
      }

      if (result && typeof result === "object" && result.notJson) {
        return jsonResponse({
          error: "Invalid response from server",
          details: "Server returned non-JSON data.",
          debugUrl: apiUrl.replace(/password=[^&]+/, "password=***"),
          preview: result.raw?.substring(0, 200) || ""
        }, 502);
      }

      return jsonResponse(result, 200);
    }

    // Stream Proxy
    if (url.pathname === "/stream") {
      let targetUrl = (url.searchParams.get("url") || "").trim();
      if (!targetUrl) return jsonResponse({ error: "Missing url parameter" }, 400);

      targetUrl = normalizeUrl(targetUrl);

      const lowerTargetUrl = targetUrl.toLowerCase();
      const isM3U8ByExt = lowerTargetUrl.endsWith(".m3u8") || lowerTargetUrl.endsWith(".m3u");

      const streamHeaders = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
        "Accept": isM3U8ByExt ? "application/vnd.apple.mpegurl, audio/mpegurl, */*" : "*/*",
        "Referer": targetUrl.substring(0, targetUrl.indexOf("/", targetUrl.indexOf("://") + 3) + 1) || "http://barqtv.website/"
      };

      const rangeHeader = request.headers.get("Range");
      if (rangeHeader && !isM3U8ByExt) {
        streamHeaders["Range"] = rangeHeader;
      }

      try {
        const method = request.method === "HEAD" ? "HEAD" : "GET";
        const response = await fetch(targetUrl, { method, headers: streamHeaders, redirect: "follow" });

        const finalUrl = response.url || targetUrl;
        const basePath = getBasePath(finalUrl);

        const contentType = response.headers.get("Content-Type") || "";
        const lowerContentType = contentType.toLowerCase();

        let isActuallyM3U8 = lowerContentType.includes("mpegurl") || 
                             lowerContentType.includes("m3u") ||
                             isM3U8ByExt;

        if (isActuallyM3U8) {
          const text = await response.text();
          const trimmed = text.trim();

          if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
            return jsonResponse({
              error: "Server returned HTML instead of M3U8",
              details: "The stream URL may be invalid or the server is blocking Cloudflare IPs.",
              url: targetUrl.replace(/\/[^/]+\/[^/]+\//, "/*****/*****/"),
              preview: trimmed.substring(0, 300)
            }, 502);
          }

          const lines = text.split("\n");
          const newLines = lines.map(line => {
            const stripped = line.trim();

            if (stripped && !stripped.startsWith("#")) {
              if (stripped.startsWith("http://") || stripped.startsWith("https://")) {
                return "/stream?url=" + encodeURIComponent(stripped);
              }
              try {
                const resolved = new URL(stripped, basePath).href;
                return "/stream?url=" + encodeURIComponent(resolved);
              } catch { return line; }
            }

            if (stripped.startsWith("#")) {
              const uriMatch = stripped.match(/URI="([^"]+)"/);
              if (uriMatch) {
                const originalUri = uriMatch[1];
                let resolvedUri;
                if (originalUri.startsWith("http://") || originalUri.startsWith("https://")) {
                  resolvedUri = originalUri;
                } else {
                  try { resolvedUri = new URL(originalUri, basePath).href; } catch { return line; }
                }
                const proxyUri = "/stream?url=" + encodeURIComponent(resolvedUri);
                return line.replace(`URI="${originalUri}"`, `URI="${proxyUri}"`);
              }
            }

            return line;
          });

          return new Response(newLines.join("\n"), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "no-cache, no-store, must-revalidate"
            }
          });
        }

        // Video/Audio segments pass-through
        const newHeaders = new Headers();
        const passThrough = ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range", "Last-Modified", "ETag", "Cache-Control", "Content-Disposition"];
        passThrough.forEach(h => {
          const v = response.headers.get(h);
          if (v) newHeaders.set(h, v);
        });

        if (lowerTargetUrl.endsWith(".mp4")) newHeaders.set("Content-Type", "video/mp4");
        else if (lowerTargetUrl.endsWith(".ts") || lowerTargetUrl.endsWith(".m2ts")) newHeaders.set("Content-Type", "video/mp2t");
        else if (lowerTargetUrl.endsWith(".mkv")) newHeaders.set("Content-Type", "video/x-matroska");
        else if (lowerTargetUrl.endsWith(".avi")) newHeaders.set("Content-Type", "video/x-msvideo");
        else if (lowerTargetUrl.endsWith(".aac")) newHeaders.set("Content-Type", "audio/aac");
        else if (lowerTargetUrl.endsWith(".mp3")) newHeaders.set("Content-Type", "audio/mpeg");

        if (!newHeaders.has("Accept-Ranges")) {
          newHeaders.set("Accept-Ranges", "bytes");
        }

        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Access-Control-Allow-Headers", "Content-Type,Authorization,Range");
        newHeaders.set("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
        newHeaders.set("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges,Last-Modified,ETag,Content-Type");
        newHeaders.set("Cache-Control", "no-transform, no-store, must-revalidate, private");
        newHeaders.set("X-Content-Type-Options", "nosniff");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });

      } catch (err) {
        return jsonResponse({
          error: "Stream fetch failed",
          details: err?.message || String(err),
          url: targetUrl.replace(/\/[^/]+\/[^/]+\//, "/*****/*****/")
        }, 502);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};
