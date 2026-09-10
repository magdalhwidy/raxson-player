// ============================================================
// RAXSON PLAYER WORKER
// VOD Proxy version
//
// Movies  : /movie/.../*.mp4  -> HTTPS proxy
// Series  : /series/.../*.mp4 -> HTTPS proxy
// Live    : /live/...         -> disabled for now
//
// Important:
// The Worker proxies MP4 bytes instead of returning 302.
// This prevents HTTPS -> HTTP mixed-content problems.
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Range, Origin, Referer, Accept",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Expose-Headers":
        "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    try {
      console.log("[ROUTER]", {
        method: request.method,
        pathname: url.pathname,
        search: url.search,
      });

      // --------------------------------------------------------
      // API
      // --------------------------------------------------------
      if (url.pathname === "/api") {
        return await handleApi(url, cors);
      }

      // --------------------------------------------------------
      // MEDIA / STREAM
      // --------------------------------------------------------
      if (url.pathname === "/stream") {
        return await handleStream(request, url, cors);
      }

      // --------------------------------------------------------
      // TEST
      // --------------------------------------------------------
      if (url.pathname === "/test") {
        return new Response("Worker OK - Raxson VOD Proxy", {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }

      // --------------------------------------------------------
      // DEBUG
      // --------------------------------------------------------
      if (url.pathname === "/debug") {
        return await handleDebug(request, url, cors);
      }

      // --------------------------------------------------------
      // STATIC ASSETS
      // --------------------------------------------------------
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", {
        status: 404,
        headers: cors,
      });
    } catch (error) {
      console.error("[WORKER ERROR]", error);

      return json(
        {
          error: "Worker Error",
          details: error?.message || String(error),
        },
        500,
        cors
      );
    }
  },
};


// ============================================================
// CONFIG
// ============================================================

const ALLOWED_HOSTS = new Set([
  "barqtv.website",
  "barqtvclg.shop",
]);


// ============================================================
// API
// ============================================================

async function handleApi(url, cors) {
  const host = url.searchParams.get("host")?.trim();
  const user = url.searchParams.get("user")?.trim();
  const pass = url.searchParams.get("pass")?.trim();
  const action = url.searchParams.get("action")?.trim();
  const extra = url.searchParams.get("extra") || "";

  if (!host || !user || !pass || !action) {
    return json(
      {
        error: "Missing parameters",
      },
      400,
      cors
    );
  }

  let cleanHost;

  try {
    cleanHost = normalizeHost(host);
  } catch (error) {
    return json(
      {
        error: "Invalid host",
        details: error.message,
      },
      400,
      cors
    );
  }

  const hostUrl = new URL(cleanHost);

  if (!ALLOWED_HOSTS.has(hostUrl.hostname.toLowerCase())) {
    return json(
      {
        error: "Host not allowed",
        host: hostUrl.hostname,
      },
      403,
      cors
    );
  }

  const apiUrl = new URL(
    "/player_api.php",
    cleanHost + "/"
  );

  apiUrl.searchParams.set("username", user);
  apiUrl.searchParams.set("password", pass);
  apiUrl.searchParams.set("action", action);

  // ----------------------------------------------------------
  // Preserve extra parameters used by the existing frontend.
  //
  // Examples:
  // &series_id=347912
  // ?series_id=347912
  // series_id=347912
  // ----------------------------------------------------------

  appendExtraParams(apiUrl, extra);

  console.log("[API REQUEST]", {
    action,
    host: apiUrl.hostname,
    pathname: apiUrl.pathname,
    query: apiUrl.search,
  });

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 60000);

  try {
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,

      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",

        "Accept":
          "application/json, text/plain, */*",

        "Accept-Language":
          "ar,en;q=0.9",

        "Referer":
          cleanHost + "/",
      },
    });

    console.log("[API RESPONSE]", {
      action,
      status: response.status,
      finalUrl: response.url,
      contentType:
        response.headers.get("content-type") || "",
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,

      headers: {
        ...cors,

        "Content-Type":
          response.headers.get("content-type") ||
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-cache, no-store, must-revalidate",

        "Pragma":
          "no-cache",
      },
    });
  } catch (error) {
    console.error("[API ERROR]", {
      action,
      error: error?.message || String(error),
    });

    return json(
      {
        error: "API fetch failed",
        details: error?.message || String(error),
      },
      502,
      cors
    );
  } finally {
    clearTimeout(timeout);
  }
}


// ============================================================
// STREAM / VOD PROXY
// ============================================================

async function handleStream(request, url, cors) {
  const target = url.searchParams.get("url")?.trim();

  if (!target) {
    return json(
      {
        error: "Missing url parameter",
      },
      400,
      cors
    );
  }

  let targetUrl;

  try {
    targetUrl = new URL(target);
  } catch (error) {
    return json(
      {
        error: "Invalid media URL",
      },
      400,
      cors
    );
  }

  // ----------------------------------------------------------
  // Only HTTP/HTTPS
  // ----------------------------------------------------------

  if (
    targetUrl.protocol !== "http:" &&
    targetUrl.protocol !== "https:"
  ) {
    return json(
      {
        error: "Unsupported protocol",
      },
      403,
      cors
    );
  }

  const hostname =
    targetUrl.hostname.toLowerCase();

  // ----------------------------------------------------------
  // Only known media hosts
  // ----------------------------------------------------------

  if (!ALLOWED_HOSTS.has(hostname)) {
    return json(
      {
        error: "Media host not allowed",
        host: hostname,
      },
      403,
      cors
    );
  }

  // ----------------------------------------------------------
  // LIVE IS DISABLED FOR NOW
  // ----------------------------------------------------------

  if (
    /^\/live(?:\/|$)/i.test(
      targetUrl.pathname
    )
  ) {
    console.log("[STREAM] Live disabled:", targetUrl.pathname);

    return json(
      {
        error: "Live streaming is currently disabled",
        type: "live",
      },
      403,
      cors
    );
  }

  // ----------------------------------------------------------
  // Only VOD movie / series paths are accepted
  // ----------------------------------------------------------

  const isMovie =
    /^\/movie(?:\/|$)/i.test(
      targetUrl.pathname
    );

  const isSeries =
    /^\/series(?:\/|$)/i.test(
      targetUrl.pathname
    );

  if (!isMovie && !isSeries) {
    return json(
      {
        error: "Only movie and series media are allowed",
        path: targetUrl.pathname,
      },
      403,
      cors
    );
  }

  console.log("[VOD PROXY START]", {
    type: isMovie ? "movie" : "series",
    host: hostname,
    path: targetUrl.pathname,
    range:
      request.headers.get("Range") || "",
  });

  // ----------------------------------------------------------
  // Build upstream request
  // ----------------------------------------------------------

  const upstreamHeaders =
    new Headers();

  upstreamHeaders.set(
    "User-Agent",
    request.headers.get("User-Agent") ||
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36"
  );

  upstreamHeaders.set(
    "Accept",
    request.headers.get("Accept") ||
      "video/mp4,video/*,*/*;q=0.8"
  );

  upstreamHeaders.set(
    "Accept-Language",
    request.headers.get("Accept-Language") ||
      "ar,en;q=0.9"
  );

  upstreamHeaders.set(
    "Referer",
    getOrigin(targetUrl.toString()) + "/"
  );

  // ----------------------------------------------------------
  // VERY IMPORTANT:
  // Forward Range so the HTML5 video player can seek/load
  // portions of the MP4.
  // ----------------------------------------------------------

  const range =
    request.headers.get("Range");

  if (range) {
    upstreamHeaders.set(
      "Range",
      range
    );
  }

  // Useful conditional headers
  copyRequestHeader(
    request,
    upstreamHeaders,
    "If-Range"
  );

  copyRequestHeader(
    request,
    upstreamHeaders,
    "If-None-Match"
  );

  copyRequestHeader(
    request,
    upstreamHeaders,
    "If-Modified-Since"
  );

  try {
    const upstreamResponse =
      await fetch(
        targetUrl.toString(),
        {
          method:
            request.method === "HEAD"
              ? "HEAD"
              : "GET",

          headers: upstreamHeaders,

          redirect: "follow",

          cache: "no-store",
        }
      );

    console.log("[VOD UPSTREAM RESPONSE]", {
      status:
        upstreamResponse.status,

      contentType:
        upstreamResponse.headers.get(
          "content-type"
        ) || "",

      contentLength:
        upstreamResponse.headers.get(
          "content-length"
        ) || "",

      contentRange:
        upstreamResponse.headers.get(
          "content-range"
        ) || "",

      acceptRanges:
        upstreamResponse.headers.get(
          "accept-ranges"
        ) || "",

      finalUrl:
        upstreamResponse.url,
    });

    // --------------------------------------------------------
    // Upstream failure
    // --------------------------------------------------------

    if (
      !upstreamResponse.ok &&
      upstreamResponse.status !== 206
    ) {
      const errorText =
        await safeReadText(
          upstreamResponse
        );

      console.error(
        "[VOD UPSTREAM ERROR]",
        {
          status:
            upstreamResponse.status,

          body:
            errorText.substring(0, 500),
        }
      );

      return new Response(
        errorText ||
          `Upstream HTTP ${upstreamResponse.status}`,
        {
          status:
            upstreamResponse.status,

          headers: {
            ...cors,

            "Content-Type":
              upstreamResponse.headers.get(
                "content-type"
              ) ||
              "text/plain; charset=utf-8",

            "Cache-Control":
              "no-store",
          },
        }
      );
    }

    // --------------------------------------------------------
    // Create browser-facing response
    // --------------------------------------------------------

    const responseHeaders =
      new Headers(cors);

    // Content type
    const upstreamType =
      upstreamResponse.headers.get(
        "content-type"
      );

    responseHeaders.set(
      "Content-Type",
      upstreamType &&
      upstreamType !== "application/octet-stream"
        ? upstreamType
        : "video/mp4"
    );

    // Range support
    responseHeaders.set(
      "Accept-Ranges",
      upstreamResponse.headers.get(
        "accept-ranges"
      ) || "bytes"
    );

    // Content length
    const contentLength =
      upstreamResponse.headers.get(
        "content-length"
      );

    if (contentLength) {
      responseHeaders.set(
        "Content-Length",
        contentLength
      );
    }

    // Content-Range for 206
    const contentRange =
      upstreamResponse.headers.get(
        "content-range"
      );

    if (contentRange) {
      responseHeaders.set(
        "Content-Range",
        contentRange
      );
    }

    // ETag
    const etag =
      upstreamResponse.headers.get(
        "etag"
      );

    if (etag) {
      responseHeaders.set(
        "ETag",
        etag
      );
    }

    // Last-Modified
    const lastModified =
      upstreamResponse.headers.get(
        "last-modified"
      );

    if (lastModified) {
      responseHeaders.set(
        "Last-Modified",
        lastModified
      );
    }

    // Never cache the user's VOD request
    responseHeaders.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    responseHeaders.set(
      "Pragma",
      "no-cache"
    );

    // --------------------------------------------------------
    // HEAD
    // --------------------------------------------------------

    if (request.method === "HEAD") {
      return new Response(
        null,
        {
          status:
            upstreamResponse.status,

          headers:
            responseHeaders,
        }
      );
    }

    // --------------------------------------------------------
    // GET
    //
    // IMPORTANT:
    // Stream upstream body directly.
    // Do NOT redirect.
    // --------------------------------------------------------

    return new Response(
      upstreamResponse.body,
      {
        status:
          upstreamResponse.status,

        statusText:
          upstreamResponse.statusText,

        headers:
          responseHeaders,
      }
    );
  } catch (error) {
    console.error("[VOD PROXY ERROR]", {
      message:
        error?.message ||
        String(error),

      target:
        targetUrl.toString(),
    });

    return json(
      {
        error: "VOD proxy failed",
        details:
          error?.message ||
          String(error),
      },
      502,
      cors
    );
  }
}


// ============================================================
// DEBUG
// ============================================================

async function handleDebug(
  request,
  url,
  cors
) {
  const target =
    url.searchParams.get("url")?.trim();

  if (!target) {
    return json(
      {
        worker: "Raxson Player",
        status: "OK",
        routes: [
          "/api",
          "/stream",
          "/test",
          "/debug",
        ],
        vod: "enabled",
        live: "disabled",
      },
      200,
      cors
    );
  }

  try {
    const parsed =
      new URL(target);

    return json(
      {
        valid: true,

        protocol:
          parsed.protocol,

        hostname:
          parsed.hostname,

        pathname:
          parsed.pathname,

        movie:
          /^\/movie(?:\/|$)/i.test(
            parsed.pathname
          ),

        series:
          /^\/series(?:\/|$)/i.test(
            parsed.pathname
          ),

        live:
          /^\/live(?:\/|$)/i.test(
            parsed.pathname
          ),

        allowedHost:
          ALLOWED_HOSTS.has(
            parsed.hostname.toLowerCase()
          ),
      },
      200,
      cors
    );
  } catch (error) {
    return json(
      {
        valid: false,
        error:
          error?.message ||
          String(error),
      },
      400,
      cors
    );
  }
}


// ============================================================
// HELPERS
// ============================================================

function json(
  data,
  status = 200,
  cors = {}
) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,

      headers: {
        ...cors,

        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",
      },
    }
  );
}


function normalizeHost(host) {
  let value =
    String(host).trim();

  if (!/^https?:\/\//i.test(value)) {
    value =
      "http://" + value;
  }

  const parsed =
    new URL(value);

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw new Error(
      "Only HTTP and HTTPS are supported"
    );
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";

  return parsed.origin;
}


function appendExtraParams(
  targetUrl,
  extra
) {
  if (!extra) {
    return;
  }

  let value =
    String(extra).trim();

  value =
    value.replace(
      /^[?&]+/,
      ""
    );

  if (!value) {
    return;
  }

  try {
    const params =
      new URLSearchParams(value);

    for (
      const [key, val]
      of params.entries()
    ) {
      if (key) {
        targetUrl.searchParams.set(
          key,
          val
        );
      }
    }
  } catch (error) {
    console.warn(
      "[API EXTRA PARAMS ERROR]",
      error?.message ||
        String(error)
    );
  }
}


function copyRequestHeader(
  request,
  target,
  name
) {
  const value =
    request.headers.get(name);

  if (value) {
    target.set(name, value);
  }
}


async function safeReadText(
  response
) {
  try {
    return await response.text();
  } catch (_) {
    return "";
  }
}


function getOrigin(value) {
  try {
    return new URL(value).origin;
  } catch (_) {
    return "";
  }
}
