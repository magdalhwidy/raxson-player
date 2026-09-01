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

    function normalizeUrl(urlStr) {
      let s = urlStr.trim();
      if (s.endsWith("/")) s = s.slice(0, -1);
      if (s.startsWith("http://") && s.endsWith(":80")) {
        s = s.slice(0, -3);
      }
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

    // Stream Proxy (Advanced M3U8 Rewriting & Pass-through)
    if (url.pathname === "/stream") {
      let targetUrl = (url.searchParams.get("url") || "").trim();
      if (!targetUrl) return jsonResponse({ error: "Missing url parameter" }, 400);

      targetUrl = normalizeUrl(targetUrl);
      const lowerTargetUrl = targetUrl.toLowerCase();
      const isM3U8ByExt = lowerTargetUrl.includes(".m3u8") || lowerTargetUrl.includes(".m3u") || lowerTargetUrl.includes("/auth/");

      const upstreamHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
        "Referer": "http://barqtv.website/"
      };

      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        upstreamHeaders["Range"] = rangeHeader;
      }

      try {
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: upstreamHeaders,
          redirect: "follow"
        });

        const finalUrl = response.url || targetUrl;
        const basePath = getBasePath(finalUrl);
        const contentType = response.headers.get("Content-Type") || "";
        const lowerContentType = contentType.toLowerCase();

        let isActuallyM3U8 = lowerContentType.includes("mpegurl") || 
                             lowerContentType.includes("m3u") ||
                             lowerContentType.includes("text/plain") ||
                             isM3U8ByExt;

        // معالجة وإعادة كتابة روابط الـ M3U8 الداخلية لتمر عبر الـ Worker
        if (isActuallyM3U8 && !lowerTargetUrl.endsWith(".mp4") && !lowerTargetUrl.endsWith(".mkv")) {
          const text = await response.text();
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
            return line;
          });

          return new Response(newLines.join("\n"), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "no-cache"
            }
          });
        }

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        newHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
        newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");

        if (lowerTargetUrl.endsWith(".mp4")) newHeaders.set("Content-Type", "video/mp4");
        else if (lowerTargetUrl.endsWith(".mkv")) newHeaders.set("Content-Type", "video/x-matroska");
        else if (lowerTargetUrl.endsWith(".ts")) newHeaders.set("Content-Type", "video/mp2t");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });

      } catch (err) {
        return jsonResponse({
          error: "Stream fetch failed",
          details: err?.message || String(err)
        }, 502);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};
