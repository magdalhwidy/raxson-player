export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Range, Accept, Origin, Referer",
      "Access-Control-Allow-Methods":
        "GET, HEAD, OPTIONS",
      "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, Content-Disposition",
    };

    // ---------------------------------------------------------
    // CORS preflight
    // ---------------------------------------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      // -------------------------------------------------------
      // API
      // -------------------------------------------------------
      if (pathname === "/api") {
        return await handleApi(request, url, corsHeaders);
      }

      // -------------------------------------------------------
      // STREAM
      // -------------------------------------------------------
      if (pathname === "/stream") {
        return await handleStream(request, url, corsHeaders);
      }

      // -------------------------------------------------------
      // DEBUG
      // -------------------------------------------------------
      if (pathname === "/debug") {
        return await handleDebug(request, url, corsHeaders);
      }

      // -------------------------------------------------------
      // STATIC ASSETS
      // -------------------------------------------------------
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", {
        status: 404,
        headers: corsHeaders,
      });

    } catch (err) {
      console.error("[WORKER ERROR]", err);

      return jsonResponse(
        {
          error: "Worker Error",
          details: err?.message || String(err),
        },
        500,
        corsHeaders
      );
    }
  },
};


// =============================================================
// API
// =============================================================

async function handleApi(request, url, corsHeaders) {
  const host = url.searchParams.get("host")?.trim() || "";
  const user = url.searchParams.get("user")?.trim() || "";
  const pass = url.searchParams.get("pass")?.trim() || "";
  const action = url.searchParams.get("action")?.trim() || "";
  const extra = url.searchParams.get("extra") || "";

  if (!host || !user || !pass || !action) {
    return jsonResponse(
      { error: "Missing parameters" },
      400,
      corsHeaders
    );
  }

  const cleanHost = host.replace(/\/+$/, "");

  const targetUrl =
    `${cleanHost}/player_api.php` +
    `?username=${encodeURIComponent(user)}` +
    `&password=${encodeURIComponent(pass)}` +
    `&action=${encodeURIComponent(action)}` +
    `${extra}`;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ar,en;q=0.9",
    "Referer": `${cleanHost}/`,
  };

  console.log("[API REQUEST]", {
    action,
    url: targetUrl,
  });

  const heavyActions = [
    "get_live_streams",
    "get_vod_streams",
    "get_series",
    "get_vod_categories",
    "get_series_categories",
    "get_live_categories",
  ];

  const timeout =
    heavyActions.includes(action)
      ? 90000
      : 40000;

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timer);

    console.log("[API RESPONSE]", {
      action,
      status: response.status,
      url: response.url,
      contentType: response.headers.get("Content-Type"),
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...corsHeaders,
        "Content-Type":
          response.headers.get("Content-Type") ||
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-cache, no-store, must-revalidate",

        "Pragma": "no-cache",
      },
    });

  } catch (err) {
    clearTimeout(timer);

    console.error("[API ERROR]", {
      action,
      url: targetUrl,
      error: err?.message || String(err),
    });

    return jsonResponse(
      {
        error: "Fetch failed",
        details: err?.message || String(err),
        url: targetUrl,
      },
      502,
      corsHeaders
    );
  }
}


// =============================================================
// STREAM
// =============================================================

async function handleStream(request, url, corsHeaders) {
  const targetUrl =
    url.searchParams.get("url")?.trim() || "";

  if (!targetUrl) {
    return jsonResponse(
      { error: "Missing url parameter" },
      400,
      corsHeaders
    );
  }

  let parsed;

  try {
    parsed = new URL(targetUrl);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return jsonResponse(
        { error: "Invalid URL scheme" },
        400,
        corsHeaders
      );
    }

  } catch {
    return jsonResponse(
      { error: "Invalid URL" },
      400,
      corsHeaders
    );
  }

  const method =
    request.method === "HEAD"
      ? "HEAD"
      : "GET";

  // -----------------------------------------------------------
  // Headers deliberately kept close to the working Vercel
  // implementation.
  //
  // IMPORTANT:
  // No Origin header is sent upstream.
  // -----------------------------------------------------------

  const baseHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",

    "Accept": "*/*",

    "Referer": "http://barqtv.website/",
  };

  // -----------------------------------------------------------
  // Forward Range exactly as received from the player.
  // -----------------------------------------------------------

  const range = request.headers.get("Range");

  if (range) {
    baseHeaders["Range"] = range;
  }

  console.log("[STREAM REQUEST]", {
    method,
    targetUrl,
    range: range || null,
  });

  try {
    // ---------------------------------------------------------
    // First try:
    // exact URL supplied by frontend
    // ---------------------------------------------------------

    const result = await fetchWithRedirects(
      targetUrl,
      method,
      baseHeaders
    );

    let response = result.response;
    let finalUrl = result.finalUrl;

    // ---------------------------------------------------------
    // If HTTP returned 403, optionally try HTTPS equivalent.
    //
    // This does NOT bypass authentication. It simply tests the
    // HTTPS version of the same host/path.
    // ---------------------------------------------------------

    if (
      response.status === 403 &&
      parsed.protocol === "http:"
    ) {
      const httpsUrl = new URL(targetUrl);

      httpsUrl.protocol = "https:";

      // Port 80 should not be retained when switching to HTTPS.
      if (httpsUrl.port === "80") {
        httpsUrl.port = "";
      }

      console.log(
        "[STREAM HTTPS FALLBACK]",
        httpsUrl.href
      );

      try {
        const httpsResult = await fetchWithRedirects(
          httpsUrl.href,
          method,
          baseHeaders
        );

        console.log("[STREAM HTTPS RESULT]", {
          status: httpsResult.response.status,
          finalUrl: httpsResult.finalUrl,
        });

        // Use HTTPS if it succeeds or if the original response
        // was an error.
        if (
          httpsResult.response.status >= 200 &&
          httpsResult.response.status < 400
        ) {
          response = httpsResult.response;
          finalUrl = httpsResult.finalUrl;
        }

      } catch (httpsError) {
        console.error(
          "[STREAM HTTPS ERROR]",
          httpsError?.message || String(httpsError)
        );
      }
    }

    // ---------------------------------------------------------
    // Diagnostics
    // ---------------------------------------------------------

    const contentType =
      response.headers.get("Content-Type") || "";

    const contentLength =
      response.headers.get("Content-Length");

    const contentRange =
      response.headers.get("Content-Range");

    const acceptRanges =
      response.headers.get("Accept-Ranges");

    const location =
      response.headers.get("Location");

    const server =
      response.headers.get("Server");

    const via =
      response.headers.get("Via");

    const cacheStatus =
      response.headers.get("CF-Cache-Status");

    const lowerType =
      contentType.toLowerCase();

    const lowerUrl =
      finalUrl.toLowerCase();

    const isM3U8 =
      lowerType.includes("mpegurl") ||
      lowerType.includes("m3u8") ||
      lowerUrl.includes(".m3u8") ||
      lowerUrl.includes(".m3u");

    console.log(
      "[STREAM RESPONSE]",
      JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        originalUrl: targetUrl,
        finalUrl,
        redirected: finalUrl !== targetUrl,
        contentType,
        contentLength,
        contentRange,
        acceptRanges,
        location,
        server,
        via,
        cacheStatus,
        requestedRange: range || null,
        isM3U8,
      })
    );

    // ---------------------------------------------------------
    // M3U8
    // ---------------------------------------------------------

    if (
      isM3U8 &&
      response.status >= 200 &&
      response.status < 300
    ) {
      const playlist =
        await response.text();

      const rewritten =
        rewriteM3U8(
          playlist,
          finalUrl
        );

      return new Response(rewritten, {
        status: response.status,
        statusText: response.statusText,

        headers: {
          ...corsHeaders,

          "Content-Type":
            "application/vnd.apple.mpegurl",

          "Cache-Control":
            "no-cache, no-store, must-revalidate",

          "Pragma": "no-cache",
        },
      });
    }

    // ---------------------------------------------------------
    // Non-M3U8
    //
    // IMPORTANT:
    // Do NOT call text(), json(), arrayBuffer(), etc.
    //
    // Pass the ReadableStream directly.
    // ---------------------------------------------------------

    const responseHeaders = {
      ...corsHeaders,

      "Content-Type":
        contentType ||
        "application/octet-stream",

      "Cache-Control":
        "no-cache, no-store, must-revalidate",

      "Pragma": "no-cache",
    };

    // Preserve important media headers.
    const headersToCopy = [
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Last-Modified",
      "ETag",
      "Content-Disposition",
      "Expires",
      "Vary",
      "Content-Encoding",
    ];

    for (const name of headersToCopy) {
      const value =
        response.headers.get(name);

      if (value) {
        responseHeaders[name] = value;
      }
    }

    // If origin returned 206 but omitted Accept-Ranges,
    // tell the player that byte ranges are supported.
    if (
      response.status === 206 &&
      !responseHeaders["Accept-Ranges"]
    ) {
      responseHeaders["Accept-Ranges"] = "bytes";
    }

    return new Response(
      response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      }
    );

  } catch (err) {

    console.error(
      "[STREAM ERROR]",
      JSON.stringify({
        targetUrl,
        error:
          err?.message ||
          String(err),
      })
    );

    return jsonResponse(
      {
        error: "Stream failed",
        details:
          err?.message ||
          String(err),
        url: targetUrl,
      },
      502,
      corsHeaders
    );
  }
}


// =============================================================
// DEBUG
//
// /debug?url=https://example.com/...
//
// This endpoint is intentionally diagnostic.
// It reads only a small amount of the upstream response body
// when possible, so we can see what a 403 actually contains.
//
// Do NOT use this endpoint for normal video playback.
// =============================================================

async function handleDebug(request, url, corsHeaders) {
  const targetUrl =
    url.searchParams.get("url")?.trim() || "";

  if (!targetUrl) {
    return jsonResponse(
      {
        error:
          "Missing url parameter",
      },
      400,
      corsHeaders
    );
  }

  let parsed;

  try {
    parsed = new URL(targetUrl);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      throw new Error(
        "Only HTTP/HTTPS allowed"
      );
    }

  } catch (err) {
    return jsonResponse(
      {
        error: "Invalid URL",
        details:
          err?.message ||
          String(err),
      },
      400,
      corsHeaders
    );
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",

    "Accept": "*/*",

    "Referer": "http://barqtv.website/",
  };

  const range =
    request.headers.get("Range");

  if (range) {
    headers["Range"] = range;
  }

  try {
    const result =
      await fetchWithRedirects(
        targetUrl,
        "GET",
        headers
      );

    const response =
      result.response;

    const body =
      await readSmallBody(
        response,
        4096
      );

    return jsonResponse(
      {
        request: {
          url: targetUrl,
          protocol: parsed.protocol,
          range: range || null,
        },

        response: {
          status: response.status,
          statusText: response.statusText,
          finalUrl: result.finalUrl,

          headers: {
            contentType:
              response.headers.get(
                "Content-Type"
              ),

            contentLength:
              response.headers.get(
                "Content-Length"
              ),

            contentRange:
              response.headers.get(
                "Content-Range"
              ),

            acceptRanges:
              response.headers.get(
                "Accept-Ranges"
              ),

            location:
              response.headers.get(
                "Location"
              ),

            server:
              response.headers.get(
                "Server"
              ),

            via:
              response.headers.get(
                "Via"
              ),

            wwwAuthenticate:
              response.headers.get(
                "WWW-Authenticate"
              ),

            cacheControl:
              response.headers.get(
                "Cache-Control"
              ),

            cfCacheStatus:
              response.headers.get(
                "CF-Cache-Status"
              ),
          },

          bodyPreview: body,
        },
      },
      200,
      corsHeaders
    );

  } catch (err) {
    return jsonResponse(
      {
        error: "Debug fetch failed",
        details:
          err?.message ||
          String(err),

        url: targetUrl,
      },
      502,
      corsHeaders
    );
  }
}


// =============================================================
// REDIRECT HANDLER
// =============================================================

async function fetchWithRedirects(
  initialUrl,
  method,
  headers
) {
  let currentUrl =
    initialUrl;

  const maxRedirects = 5;

  for (
    let i = 0;
    i <= maxRedirects;
    i++
  ) {

    console.log(
      "[UPSTREAM FETCH]",
      {
        attempt: i + 1,
        url: currentUrl,
        method,
      }
    );

    const response =
      await fetch(
        currentUrl,
        {
          method,

          headers: {
            ...headers,
          },

          redirect: "manual",

          // Do not cache media requests.
          cache: "no-store",
        }
      );

    // Not a redirect.
    if (
      !isRedirectStatus(
        response.status
      )
    ) {
      return {
        response,
        finalUrl: currentUrl,
      };
    }

    const location =
      response.headers.get(
        "Location"
      );

    console.log(
      "[UPSTREAM REDIRECT]",
      {
        status: response.status,
        from: currentUrl,
        location,
      }
    );

    if (!location) {
      return {
        response,
        finalUrl: currentUrl,
      };
    }

    if (i >= maxRedirects) {
      console.error(
        "[UPSTREAM] Too many redirects"
      );

      return {
        response,
        finalUrl: currentUrl,
      };
    }

    const nextUrl =
      new URL(
        location,
        currentUrl
      );

    currentUrl =
      nextUrl.href;
  }

  throw new Error(
    "Redirect handling failed"
  );
}


// =============================================================
// REDIRECT STATUS
// =============================================================

function isRedirectStatus(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}


// =============================================================
// M3U8 REWRITER
// =============================================================

function rewriteM3U8(
  text,
  baseUrl
) {
  const lines =
    text.split("\n");

  const output = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    let line =
      lines[i];

    // ---------------------------------------------------------
    // M3U8 tags
    // ---------------------------------------------------------

    if (
      line.startsWith("#")
    ) {

      line =
        rewriteUriInTag(
          line,
          baseUrl
        );

      output.push(line);

      continue;
    }

    const trimmed =
      line.trim();

    // Empty line.
    if (!trimmed) {
      output.push(line);
      continue;
    }

    // ---------------------------------------------------------
    // Segment / playlist URL
    // ---------------------------------------------------------

    const resolved =
      resolveUrl(
        trimmed,
        baseUrl
      );

    output.push(
      proxyUrl(resolved)
    );
  }

  return output.join("\n");
}


// =============================================================
// Rewrite URI="..." inside M3U8 tags
// =============================================================

function rewriteUriInTag(
  line,
  baseUrl
) {
  return line.replace(
    /URI="([^"]+)"/g,
    (match, uri) => {

      if (
        uri.startsWith("data:") ||
        uri.startsWith("skd:")
      ) {
        return match;
      }

      const resolved =
        resolveUrl(
          uri,
          baseUrl
        );

      return (
        `URI="${proxyUrl(resolved)}"`
      );
    }
  );
}


// =============================================================
// Resolve relative M3U8 URLs
// =============================================================

function resolveUrl(
  value,
  base
) {
  if (
    value.startsWith(
      "http://"
    ) ||
    value.startsWith(
      "https://"
    )
  ) {
    return value;
  }

  try {
    return new URL(
      value,
      base
    ).href;

  } catch {
    return value;
  }
}


// =============================================================
// Convert upstream URL to Worker /stream URL
// =============================================================

function proxyUrl(url) {
  return (
    "/stream?url=" +
    encodeURIComponent(url)
  );
}


// =============================================================
// Read only a small diagnostic body
// =============================================================

async function readSmallBody(
  response,
  maxBytes
) {
  try {
    if (!response.body) {
      return "";
    }

    const reader =
      response.body.getReader();

    const decoder =
      new TextDecoder();

    let result = "";
    let total = 0;

    while (
      total < maxBytes
    ) {

      const {
        value,
        done,
      } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const remaining =
        maxBytes - total;

      const chunk =
        value.slice(
          0,
          remaining
        );

      result +=
        decoder.decode(
          chunk,
          {
            stream: true,
          }
        );

      total +=
        chunk.byteLength;

      if (
        total >= maxBytes
      ) {
        break;
      }
    }

    return result;

  } catch (err) {
    return (
      "[Unable to read body: " +
      (err?.message ||
        String(err)) +
      "]"
    );
  }
}


// =============================================================
// JSON RESPONSE
// =============================================================

function jsonResponse(
  data,
  status,
  corsHeaders
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        ...corsHeaders,

        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-cache, no-store, must-revalidate",

        "Pragma":
          "no-cache",
      },
    }
  );
}
