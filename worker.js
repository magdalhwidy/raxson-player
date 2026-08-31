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

    // Flask would effectively allow OPTIONS requests.
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
    // /health
    // =========================================================
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "raxson-player"
        }),
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
    //
    // Equivalent to:
    // fetch_with_retry(url, max_retries=3, timeout=45)
    // from app.py
    // =========================================================
    async function fetchWithRetry(targetUrl, maxRetries = 3, timeoutMs = 45000) {
      let lastError = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let timer = null;

        try {
          const controller = new AbortController();

          timer = setTimeout(() => {
            controller.abort();
          }, timeoutMs);

          const response = await fetch(targetUrl, {
            method: "GET",
            headers: originHeaders,
            signal: controller.signal,
            redirect: "follow"
          });

          clearTimeout(timer);
          timer = null;

          // Same basic behavior as urllib:
          // HTTP errors are returned as errors.
          if (!response.ok) {
            return {
              error: `HTTP ${response.status}`,
              details: response.statusText || `HTTP ${response.status}`
            };
          }

          const contentType =
            response.headers.get("Content-Type") || "";

          const text = await response.text();

          // app.py tries json.loads first.
          try {
            return JSON.parse(text);
          } catch {
            return {
              raw: text
            };
          }
        } catch (err) {
          if (timer) {
            clearTimeout(timer);
          }

          if (err && err.name === "AbortError") {
            lastError = "Request timeout";
          } else {
            lastError = err?.message || String(err);
          }

          // Equivalent to:
          // time.sleep(1.5)
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      }

      return {
        error: `Failed after ${maxRetries} attempts: ${lastError}`
      };
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

      // Same validation as app.py
      if (!host || !user || !pwd || !action) {
        return jsonResponse(
          {
            error: "Missing parameters"
          },
          400
        );
      }

      // Same as:
      // if host.endswith("/"): host = host[:-1]
      const cleanHost = host.endsWith("/")
        ? host.slice(0, -1)
        : host;

      // Same query structure as app.py
      const apiUrl =
        `${cleanHost}/player_api.php` +
        `?username=${encodeURIComponent(user)}` +
        `&password=${encodeURIComponent(pwd)}` +
        `&action=${encodeURIComponent(action)}` +
        extra;

      // Same timeout logic:
      // 60 sec for get_live_streams
      // 35 sec for everything else
      const timeout =
        action === "get_live_streams"
          ? 60000
          : 35000;

      const result = await fetchWithRetry(
        apiUrl,
        3,
        timeout
      );

      // Same general behavior as app.py:
      // if "error" in result -> 502
      if (
        result &&
        typeof result === "object" &&
        Object.prototype.hasOwnProperty.call(result, "error")
      ) {
        return jsonResponse(result, 502);
      }

      return jsonResponse(result, 200);
    }

    // =========================================================
    // /stream
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

      // Same headers as app.py
      const streamHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
        "Accept": "*/*",
        "Referer": "http://barqtv.website/"
      };

      // Critical for seeking/scrubbing.
      const rangeHeader = request.headers.get("Range");

      if (rangeHeader) {
        streamHeaders["Range"] = rangeHeader;
      }

      try {
        const response = await fetch(targetUrl, {
          method: "GET",
          headers: streamHeaders,
          redirect: "follow"
        });

        const contentType =
          response.headers.get("Content-Type") || "";

        const lowerTargetUrl =
          targetUrl.toLowerCase();

        // Same M3U8/M3U detection logic.
        const isM3U8 =
          contentType.toLowerCase().includes("mpegurl") ||
          lowerTargetUrl.endsWith(".m3u8") ||
          lowerTargetUrl.endsWith(".m3u");

        // =====================================================
        // M3U8 / M3U
        // =====================================================
        if (isM3U8) {
          const text = await response.text();

          // Equivalent to:
          // base_path = url[:url.rfind('/') + 1]
          let baseUrl;

          try {
            baseUrl = new URL(targetUrl);
          } catch {
            return jsonResponse(
              {
                error: "Invalid stream URL"
              },
              400
            );
          }

          // We use the directory containing the playlist
          // as the base for relative URLs.
          const basePath =
            targetUrl.substring(
              0,
              targetUrl.lastIndexOf("/") + 1
            );

          const lines = text.split("\n");

          const newLines = lines.map(line => {
            const stripped = line.trim();

            // Preserve empty lines and #EXT... lines.
            if (
              !stripped ||
              stripped.startsWith("#")
            ) {
              return line;
            }

            // Absolute HTTP/HTTPS URL
            if (
              stripped.startsWith("http://") ||
              stripped.startsWith("https://")
            ) {
              return (
                "/stream?url=" +
                encodeURIComponent(stripped)
              );
            }

            // Relative URL
            try {
              const resolved =
                new URL(stripped, basePath).href;

              return (
                "/stream?url=" +
                encodeURIComponent(resolved)
              );
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
                "Content-Type":
                  "application/vnd.apple.mpegurl",
                "Cache-Control":
                  "no-cache, no-store, must-revalidate"
              }
            }
          );
        }

        // =====================================================
        // Normal video stream
        // =====================================================
        const responseHeaders = {
          ...corsHeaders
        };

        // Same essential headers as app.py
        const headersToForward = [
          "Content-Type",
          "Content-Length",
          "Content-Range",
          "Accept-Ranges",
          "Last-Modified",
          "ETag"
        ];

        for (const headerName of headersToForward) {
          const value =
            response.headers.get(headerName);

          if (value) {
            responseHeaders[headerName] = value;
          }
        }

        // Return origin body directly.
        //
        // This is the Cloudflare equivalent of the
        // generator() in app.py.
        return new Response(
          response.body,
          {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
          }
        );

      } catch (err) {
        return jsonResponse(
          {
            error: "Stream failed",
            details: err?.message || String(err)
          },
          502
        );
      }
    }

    // =========================================================
    // Static files
    // =========================================================
    //
    // Equivalent to Flask:
    //
    // /
    // /manifest.json
    // /sw.js
    // /logo1.png
    // /images/<filename>
    //
    // Cloudflare serves them through env.ASSETS.
    // =========================================================

    try {
      const assetResponse =
        await env.ASSETS.fetch(request);

      // /
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

        return new Response(
          assetResponse.body,
          {
            status: assetResponse.status,
            statusText: assetResponse.statusText,
            headers
          }
        );
      }

      // /manifest.json
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
            statusText: assetResponse.statusText,
            headers
          }
        );
      }

      // /sw.js
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
            statusText: assetResponse.statusText,
            headers
          }
        );
      }

      // Everything else
      return assetResponse;

    } catch (err) {
      return jsonResponse(
        {
          error: "Asset failed",
          details: err?.message || String(err)
        },
        500
      );
    }
  }
};
