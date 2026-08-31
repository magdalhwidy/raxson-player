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
    // Helpers
    // =========================================================

    const USER_AGENT =
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0";

    const API_HEADERS = {
      "User-Agent": USER_AGENT,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "ar,en;q=0.9",
      "Referer": "http://barqtv.website/"
    };

    const STREAM_HEADERS = {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Referer": "http://barqtv.website/"
    };

    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8"
        }
      });
    }

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    // =========================================================
    // fetch API with retry
    // نفس منطق fetch_with_retry الموجود في app.py
    // =========================================================

    async function fetchApiWithRetry(targetUrl, maxRetries = 3, timeout = 45000) {
      let lastError = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let controller;
        let timer;

        try {
          controller = new AbortController();

          timer = setTimeout(() => {
            controller.abort();
          }, timeout);

          const response = await fetch(targetUrl, {
            method: "GET",
            headers: API_HEADERS,
            signal: controller.signal,
            redirect: "follow"
          });

          clearTimeout(timer);

          // نفس فكرة HTTPError في Python
          if (!response.ok) {
            return {
              error: `HTTP ${response.status}`,
              details: response.statusText || "HTTP error"
            };
          }

          const contentType =
            response.headers.get("Content-Type") || "";

          if (
            contentType.toLowerCase().includes("application/json") ||
            contentType.toLowerCase().includes("text/json")
          ) {
            try {
              return await response.json();
            } catch {
              const text = await response.text();
              return {
                raw: text
              };
            }
          }

          const text = await response.text();

          try {
            return JSON.parse(text);
          } catch {
            return {
              raw: text
            };
          }

        } catch (error) {
          if (timer) clearTimeout(timer);

          if (error.name === "AbortError") {
            lastError = "Request timeout";
          } else {
            lastError = error.message || String(error);
          }

          // مثل time.sleep(1.5) في app.py
          if (attempt < maxRetries - 1) {
            await sleep(1500);
          }
        }
      }

      return {
        error: `Failed after ${maxRetries} attempts`,
        details: lastError
      };
    }

    // =========================================================
    // HEALTH
    // =========================================================

    if (url.pathname === "/health") {
      return jsonResponse({
        status: "ok",
        service: "raxson-player"
      });
    }

    // =========================================================
    // /api
    // نفس app.py
    // =========================================================

    if (url.pathname === "/api") {
      const host = (url.searchParams.get("host") || "").trim();
      const user = (url.searchParams.get("user") || "").trim();
      const pwd = (url.searchParams.get("pass") || "").trim();
      const action = (url.searchParams.get("action") || "").trim();
      const extra = url.searchParams.get("extra") || "";

      if (!host || !user || !pwd || !action) {
        return jsonResponse(
          {
            error: "Missing parameters"
          },
          400
        );
      }

      const cleanHost = host.endsWith("/")
        ? host.slice(0, -1)
        : host;

      // المحافظة على نفس منطق app.py
      const apiUrl =
        `${cleanHost}/player_api.php` +
        `?username=${encodeURIComponent(user)}` +
        `&password=${encodeURIComponent(pwd)}` +
        `&action=${encodeURIComponent(action)}` +
        extra;

      // نفس الـtimeout الموجود في app.py
      const timeout =
        action === "get_live_streams"
          ? 60000
          : 35000;

      const result = await fetchApiWithRetry(
        apiUrl,
        3,
        timeout
      );

      if (result && result.error) {
        return jsonResponse(result, 502);
      }

      return jsonResponse(result);
    }

    // =========================================================
    // /stream
    // Proxy للبث
    // =========================================================

    if (url.pathname === "/stream") {
      const targetUrl =
        (url.searchParams.get("url") || "").trim();

      if (!targetUrl) {
        return jsonResponse(
          {
            error: "Missing url parameter"
          },
          400
        );
      }

      let parsedTarget;

      try {
        parsedTarget = new URL(targetUrl);
      } catch {
        return jsonResponse(
          {
            error: "Invalid stream URL"
          },
          400
        );
      }

      const headers = new Headers(STREAM_HEADERS);

      // مهم جداً للفيديو والـseek
      const rangeHeader = request.headers.get("Range");

      if (rangeHeader) {
        headers.set("Range", rangeHeader);
      }

      try {
        const response = await fetch(parsedTarget.href, {
          method: "GET",
          headers,
          redirect: "follow"
        });

        const contentType =
          response.headers.get("Content-Type") || "";

        const lowerTarget =
          parsedTarget.href.toLowerCase().split("?")[0];

        const isM3U8 =
          contentType.toLowerCase().includes("mpegurl") ||
          lowerTarget.endsWith(".m3u8") ||
          lowerTarget.endsWith(".m3u");

        // =====================================================
        // M3U8
        // =====================================================

        if (isM3U8) {
          const text = await response.text();

          const baseUrl = new URL(
            ".",
            parsedTarget.href
          ).href;

          const lines = text.split(/\r?\n/);

          const rewritten = lines.map(line => {
            const trimmed = line.trim();

            if (!trimmed) {
              return line;
            }

            // -------------------------------------------------
            // الأسطر التي تحتوي URI داخل #EXT-X-KEY
            // #EXT-X-MAP
            // #EXT-X-MEDIA
            // وغيرها
            // -------------------------------------------------

            if (trimmed.startsWith("#")) {
              return line.replace(
                /URI="([^"]+)"/g,
                (match, uri) => {
                  try {
                    const absolute =
                      new URL(uri, baseUrl).href;

                    return `URI="/stream?url=${encodeURIComponent(
                      absolute
                    )}"`;
                  } catch {
                    return match;
                  }
                }
              );
            }

            // -------------------------------------------------
            // Absolute URL
            // -------------------------------------------------

            if (
              trimmed.startsWith("http://") ||
              trimmed.startsWith("https://")
            ) {
              return `/stream?url=${encodeURIComponent(
                trimmed
              )}`;
            }

            // -------------------------------------------------
            // Relative URL
            // -------------------------------------------------

            try {
              const resolved =
                new URL(trimmed, baseUrl).href;

              return `/stream?url=${encodeURIComponent(
                resolved
              )}`;
            } catch {
              return line;
            }
          });

          const playlist = rewritten.join("\n");

          return new Response(playlist, {
            status: response.status,
            headers: {
              ...corsHeaders,
              "Content-Type":
                "application/vnd.apple.mpegurl",
              "Cache-Control":
                "no-cache, no-store, must-revalidate"
            }
          });
        }

        // =====================================================
        // الفيديو / TS / MP4 / أجزاء HLS
        // تمرير الـheaders المهمة
        // =====================================================

        const responseHeaders = new Headers();

        const forwardHeaders = [
          "Content-Type",
          "Content-Length",
          "Content-Range",
          "Accept-Ranges",
          "Last-Modified",
          "ETag"
        ];

        for (const header of forwardHeaders) {
          const value =
            response.headers.get(header);

          if (value) {
            responseHeaders.set(header, value);
          }
        }

        // CORS
        for (const [key, value] of Object.entries(corsHeaders)) {
          responseHeaders.set(key, value);
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });

      } catch (error) {
        return jsonResponse(
          {
            error: "Stream failed",
            details:
              error.message || String(error)
          },
          502
        );
      }
    }

    // =========================================================
    // الملفات الثابتة
    // =========================================================

    const assetResponse =
      await env.ASSETS.fetch(request);

    // ---------------------------------------------------------
    // index.html
    // ---------------------------------------------------------

    if (
      url.pathname === "/" ||
      url.pathname === "/index.html"
    ) {
      const headers =
        new Headers(assetResponse.headers);

      headers.set(
        "Cache-Control",
        "no-cache, no-store, must-revalidate"
      );

      for (const [key, value] of Object.entries(corsHeaders)) {
        headers.set(key, value);
      }

      return new Response(
        assetResponse.body,
        {
          status: assetResponse.status,
          headers
        }
      );
    }

    // ---------------------------------------------------------
    // manifest.json
    // ---------------------------------------------------------

    if (url.pathname === "/manifest.json") {
      const headers =
        new Headers(assetResponse.headers);

      headers.set(
        "Content-Type",
        "application/json"
      );

      headers.set(
        "Cache-Control",
        "no-cache, no-store, must-revalidate"
      );

      return new Response(
        assetResponse.body,
        {
          status: assetResponse.status,
          headers
        }
      );
    }

    // ---------------------------------------------------------
    // sw.js
    // ---------------------------------------------------------

    if (url.pathname === "/sw.js") {
      const headers =
        new Headers(assetResponse.headers);

      headers.set(
        "Content-Type",
        "application/javascript"
      );

      headers.set(
        "Cache-Control",
        "no-cache, no-store, must-revalidate"
      );

      headers.set(
        "Service-Worker-Allowed",
        "/"
      );

      return new Response(
        assetResponse.body,
        {
          status: assetResponse.status,
          headers
        }
      );
    }

    // ---------------------------------------------------------
    // باقي الملفات
    // logo1.png / images / ...
    // ---------------------------------------------------------

    return assetResponse;
  }
};
