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
      // لا نحذف :80 لأن بعض السيرفرات تتطلبه صراحة في Host header
      return s;
    }

    const originHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      "Connection": "keep-alive",
      "Referer": "http://barqtv.website/"
    };

    async function fetchWithRetry(targetUrl, maxRetries = 3, timeoutMs = 45000) {
      let lastError = null;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let timer = null;
        try {
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch(targetUrl, { method: "GET", headers: originHeaders, signal: controller.signal, redirect: "follow" });
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
        // ✅ استخدام headers المستخدم الحقيقي (إخفاء هوية Cloudflare)
        const reqHeaders = new Headers();
        
        // نسخ User-Agent الحقيقي للمستخدم
        const userAgent = request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        reqHeaders.set("User-Agent", userAgent);
        reqHeaders.set("Accept", request.headers.get("Accept") || "*/*");
        reqHeaders.set("Accept-Language", request.headers.get("Accept-Language") || "en-US,en;q=0.9");
        reqHeaders.set("Accept-Encoding", "identity"); // identity فقط لتجنب مشاكل الضغط
        reqHeaders.set("Connection", "keep-alive");
        reqHeaders.set("Referer", "http://barqtv.website/");
        
        // ✅ إضافة IP المستخدم الحقيقي (مهم جداً لبعض السيرفرات)
        const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || request.headers.get("X-Real-IP");
        if (clientIp) {
          reqHeaders.set("X-Forwarded-For", clientIp);
          reqHeaders.set("X-Real-IP", clientIp);
        }
        
        // ✅ نسخ Range header (مهم للفيديو)
        const range = request.headers.get("Range");
        if (range) reqHeaders.set("Range", range);

        const response = await fetch(targetUrl, {
          method: request.method,
          headers: reqHeaders,
          redirect: "follow"
        });

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
