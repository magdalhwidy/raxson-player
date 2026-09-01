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

    const streamHeaders = {
      "User-Agent": "IPTVSmartersPro",
      "Accept": "*/*",
      "Connection": "keep-alive"
    };

    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" }
      });
    }

    function normalizeUrl(urlStr) {
      let s = urlStr.trim();
      if (s.endsWith("/")) s = s.slice(0, -1);
      if (s.startsWith("http://") && s.endsWith(":80")) s = s.slice(0, -3);
      if (s.startsWith("https://") && s.endsWith(":443")) s = s.slice(0, -4);
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
          const response = await fetch(targetUrl, { method: "GET", headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, signal: controller.signal, redirect: "follow" });
          clearTimeout(timer);
          if (!response.ok) return { error: `HTTP ${response.status}` };
          const text = await response.text();
          try { return JSON.parse(text); } catch { return { raw: text, notJson: true }; }
        } catch (err) {
          if (timer) clearTimeout(timer);
          lastError = err?.message || String(err);
          if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 1500));
        }
      }
      return { error: lastError };
    }

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok" });
    }

    if (url.pathname === "/api") {
      const host = (url.searchParams.get("host") || "").trim();
      const user = (url.searchParams.get("user") || "").trim();
      const pwd = (url.searchParams.get("pass") || "").trim();
      const action = (url.searchParams.get("action") || "").trim();
      const extra = url.searchParams.get("extra") || "";

      if (!host || !user || !pwd || !action) return jsonResponse({ error: "Missing parameters" }, 400);

      const apiUrl = `${normalizeUrl(host)}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pwd)}&action=${encodeURIComponent(action)}${extra}`;
      const result = await fetchWithRetry(apiUrl);
      if (result.error) return jsonResponse(result, 502);
      return jsonResponse(result, 200);
    }

    if (url.pathname === "/stream") {
      let targetUrl = (url.searchParams.get("url") || "").trim();
      if (!targetUrl) return jsonResponse({ error: "Missing url parameter" }, 400);
      targetUrl = normalizeUrl(targetUrl);

      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) streamHeaders["Range"] = rangeHeader;

      try {
        const response = await fetch(targetUrl, {
          method: "GET",
          headers: streamHeaders,
          redirect: "follow"
        });

        const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
        const finalUrl = response.url || targetUrl;
        const basePath = getBasePath(finalUrl);

        // إذا كان الملف عبارة عن قائمة تشغيل M3U8، نقوم بتعديل روابط الأجزاء بداخله لتمر عبر الـ Worker
        if (contentType.includes("mpegurl") || contentType.includes("m3u") || targetUrl.includes(".m3u8")) {
          let text = await response.text();
          let lines = text.split("\n");
          let modifiedLines = lines.map(line => {
            let trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
              let absoluteUrl = trimmed.startsWith("http") ? trimmed : new URL(trimmed, basePath).href;
              return `/stream?url=${encodeURIComponent(absoluteUrl)}`;
            }
            return line;
          });

          return new Response(modifiedLines.join("\n"), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl" }
          });
        }

        const newHeaders = new Headers(response.headers);
        Object.keys(corsHeaders).forEach(key => newHeaders.set(key, corsHeaders[key]));

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
