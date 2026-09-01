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

    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" }
      });
    }

    function normalizeUrl(urlStr) {
      let s = urlStr.trim();
      if (s.endsWith("/")) s = s.slice(0, -1);
      return s;
    }

    // Headers للاتصال بالسيرفر الأصلي
    function buildOriginHeaders(req) {
      const h = new Headers();
      h.set("User-Agent", req.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      h.set("Accept", req.headers.get("Accept") || "*/*");
      h.set("Accept-Language", req.headers.get("Accept-Language") || "en-US,en;q=0.9,ar;q=0.8");
      h.set("Referer", "https://barqtv.website/");
      return h;
    }

    async function fetchWithRetry(targetUrl, maxRetries = 3, timeoutMs = 45000) {
      let lastError = null;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let timer = null;
        try {
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch(targetUrl, { 
            method: "GET", 
            headers: buildOriginHeaders(request), 
            signal: controller.signal, 
            redirect: "follow" 
          });
          clearTimeout(timer);
          if (!response.ok) return { error: `HTTP ${response.status}`, details: response.statusText };
          const text = await response.text();
          try { return JSON.parse(text); } catch { return { raw: text, notJson: true }; }
        } catch (err) {
          if (timer) clearTimeout(timer);
          lastError = err?.name === "AbortError" ? "Request timeout" : (err?.message || String(err));
          if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 1500));
        }
      }
      return { error: `Failed after ${maxRetries} attempts: ${lastError}` };
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "raxson-player" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api") {
      const host = (url.searchParams.get("host") || "").trim();
      const user = (url.searchParams.get("user") || "").trim();
      const pwd = (url.searchParams.get("pass") || "").trim();
      const action = (url.searchParams.get("action") || "").trim();
      const extra = url.searchParams.get("extra") || "";
      if (!host || !user || !pwd || !action) return jsonResponse({ error: "Missing parameters" }, 400);
      const cleanHost = normalizeUrl(host);
      const apiUrl = `${cleanHost}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pwd)}&action=${encodeURIComponent(action)}${extra}`;
      const timeout = action === "get_live_streams" ? 60000 : 35000;
      const result = await fetchWithRetry(apiUrl, 3, timeout);
      if (result && typeof result === "object" && "error" in result) {
        return jsonResponse({ error: result.error, details: result.details, debugUrl: apiUrl.replace(/password=[^&]+/, "password=***") }, 502);
      }
      if (result && typeof result === "object" && result.notJson) {
        return jsonResponse({ error: "Invalid response from server", details: "Server returned non-JSON data.", debugUrl: apiUrl.replace(/password=[^&]+/, "password=***"), preview: result.raw?.substring(0, 200) || "" }, 502);
      }
      return jsonResponse(result, 200);
    }

    if (url.pathname === "/stream") {
      let targetUrl = (url.searchParams.get("url") || "").trim();
      if (!targetUrl) return jsonResponse({ error: "Missing url parameter" }, 400);

      targetUrl = normalizeUrl(targetUrl);

      try {
        const reqHeaders = buildOriginHeaders(request);

        // تمرير Range header (مهم جداً للفيديو)
        const range = request.headers.get("Range");
        if (range) reqHeaders.set("Range", range);

        const response = await fetch(targetUrl, {
          method: request.method,
          headers: reqHeaders,
          redirect: "follow"
        });

        const contentType = (response.headers.get("content-type") || "").toLowerCase();

        // معالجة M3U8 playlists
        const isM3U8 = contentType.includes("mpegurl") || 
                       contentType.includes("m3u") || 
                       targetUrl.toLowerCase().endsWith(".m3u8") || 
                       targetUrl.toLowerCase().endsWith(".m3u");

        if (isM3U8) {
          const text = await response.text();

          const lastSlash = targetUrl.lastIndexOf("/");
          const basePath = lastSlash >= 0 ? targetUrl.substring(0, lastSlash + 1) : targetUrl;

          const lines = text.split("\n");
          const newLines = [];

          for (let line of lines) {
            const stripped = line.trim();
            if (!stripped || stripped.startsWith("#")) {
              newLines.push(line);
            } else if (stripped.startsWith("http")) {
              newLines.push("/stream?url=" + encodeURIComponent(stripped));
            } else {
              try {
                const resolved = new URL(stripped, basePath).href;
                newLines.push("/stream?url=" + encodeURIComponent(resolved));
              } catch (e) {
                newLines.push(line);
              }
            }
          }

          const newText = newLines.join("\n");
          const newHeaders = new Headers(corsHeaders);
          newHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
          newHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");

          return new Response(newText, {
            status: 200,
            headers: newHeaders
          });
        }

        // للملفات العادية (TS, MP4, إلخ)
        const newHeaders = new Headers(corsHeaders);
        ["content-type","content-length","content-range","accept-ranges","last-modified","etag","cache-control","expires"].forEach(h => {
          const v = response.headers.get(h);
          if (v) newHeaders.set(h, v);
        });

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (err) {
        return jsonResponse({ error: "Stream proxy failed", details: err.message }, 502);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};
