export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Range, Accept, Origin, Referer",
      "Access-Control-Allow-Methods":
        "GET, HEAD, OPTIONS",
      "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, Content-Disposition",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    try {
      if (url.pathname === "/api") {
        return await handleApi(url, cors);
      }

      if (url.pathname === "/stream") {
        return await handleStream(request, url, cors);
      }

      if (url.pathname === "/debug") {
        return await handleDebug(request, url, cors);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", {
        status: 404,
        headers: cors,
      });
    } catch (err) {
      console.error("[WORKER ERROR]", err);

      return json(
        {
          error: "Worker Error",
          details: err?.message || String(err),
        },
        500,
        cors
      );
    }
  },
};


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
      { error: "Missing parameters" },
      400,
      cors
    );
  }

  const cleanHost = host.replace(/\/+$/, "");

  const target =
    `${cleanHost}/player_api.php` +
    `?username=${encodeURIComponent(user)}` +
    `&password=${encodeURIComponent(pass)}` +
    `&action=${encodeURIComponent(action)}` +
    extra;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",

    "Accept":
      "application/json, text/plain, */*",

    "Accept-Language":
      "ar,en;q=0.9",

    "Referer":
      `${cleanHost}/`,
  };

  try {
    const response = await fetch(target, {
      method: "GET",
      headers,
      redirect: "follow",
      cache: "no-store",
    });

    console.log("[API]", {
      action,
      status: response.status,
      finalUrl: response.url,
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        ...cors,
        "Content-Type":
          response.headers.get("Content-Type") ||
          "application/json; charset=utf-8",
        "Cache-Control":
          "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
      },
    });

  } catch (err) {
    console.error("[API ERROR]", err);

    return json(
      {
        error: "Fetch failed",
        details: err?.message || String(err),
      },
      502,
      cors
    );
  }
}


// ============================================================
// STREAM
// ============================================================

async function handleStream(request, url, cors) {
  const target = url.searchParams.get("url")?.trim();

  if (!target) {
    return json(
      { error: "Missing url parameter" },
      400,
      cors
    );
  }

  let parsed;

  try {
    parsed = new URL(target);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      throw new Error("Invalid protocol");
    }
  } catch {
    return json(
      { error: "Invalid URL" },
      400,
      cors
    );
  }

  const method =
    request.method === "HEAD"
      ? "HEAD"
      : "GET";

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",

    "Accept":
      "*/*",

    "Referer":
      "http://barqtv.website/",
  };

  const range =
    request.headers.get("Range");

  if (range) {
    headers["Range"] = range;
  }

  console.log("[STREAM START]", {
    url: target,
    range: range || null,
  });

  try {
    /*
     * IMPORTANT:
     *
     * We manually follow redirects so we know exactly where
     * barqtv sends the request.
     *
     * We do NOT modify the /auth/... URL returned by the
     * upstream server.
     */

    let result = await followRedirects(
      target,
      method,
      headers
    );

    let response = result.response;
    let finalUrl = result.finalUrl;

    console.log("[STREAM RESULT]", {
      status: response.status,
      finalUrl,
      redirected: finalUrl !== target,
      contentType:
        response.headers.get("Content-Type"),
      server:
        response.headers.get("Server"),
      contentLength:
        response.headers.get("Content-Length"),
      contentRange:
        response.headers.get("Content-Range"),
      acceptRanges:
        response.headers.get("Accept-Ranges"),
    });


    // ========================================================
    // HTTPS FALLBACK
    // ========================================================

    if (
      response.status === 403 &&
      parsed.protocol === "http:"
    ) {
      const https = new URL(target);

      https.protocol = "https:";

      if (https.port === "80") {
        https.port = "";
      }

      console.log(
        "[STREAM] Original HTTP returned 403."
      );

      console.log(
        "[STREAM] Trying HTTPS equivalent:",
        https.href
      );

      try {
        const httpsResult =
          await followRedirects(
            https.href,
            method,
            headers
          );

        console.log(
          "[STREAM HTTPS RESULT]",
          {
            status:
              httpsResult.response.status,

            finalUrl:
              httpsResult.finalUrl,
          }
        );

        /*
         * Prefer HTTPS when it actually succeeds.
         */
        if (
          httpsResult.response.status >= 200 &&
          httpsResult.response.status < 300
        ) {
          result = httpsResult;

          response =
            httpsResult.response;

          finalUrl =
            httpsResult.finalUrl;
        }

      } catch (err) {
        console.error(
          "[STREAM HTTPS ERROR]",
          err?.message || String(err)
        );
      }
    }


    // ========================================================
    // M3U8 DETECTION
    // ========================================================

    const contentType =
      response.headers.get("Content-Type") || "";

    const lowerType =
      contentType.toLowerCase();

    const lowerUrl =
      finalUrl.toLowerCase();

    const isM3U8 =
      lowerType.includes("mpegurl") ||
      lowerType.includes("m3u8") ||
      lowerUrl.includes(".m3u8") ||
      lowerUrl.includes(".m3u");


    // ========================================================
    // M3U8
    // ========================================================

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

      return new Response(
        rewritten,
        {
          status: response.status,

          headers: {
            ...cors,

            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Cache-Control":
              "no-cache, no-store, must-revalidate",

            "Pragma":
              "no-cache",
          },
        }
      );
    }


    // ========================================================
    // BINARY STREAM
    // ========================================================

    const responseHeaders = {
      ...cors,

      "Content-Type":
        contentType ||
        "application/octet-stream",

      "Cache-Control":
        "no-cache, no-store, must-revalidate",

      "Pragma":
        "no-cache",
    };

    const copyHeaders = [
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

    for (const name of copyHeaders) {
      const value =
        response.headers.get(name);

      if (value) {
        responseHeaders[name] = value;
      }
    }

    if (
      response.status === 206 &&
      !responseHeaders["Accept-Ranges"]
    ) {
      responseHeaders["Accept-Ranges"] =
        "bytes";
    }

    /*
     * IMPORTANT:
     *
     * Never call response.text() / arrayBuffer()
     * for video data.
     *
     * Pass the upstream ReadableStream directly.
     */

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
      {
        url: target,
        error:
          err?.message ||
          String(err),
      }
    );

    return json(
      {
        error: "Stream failed",
        details:
          err?.message ||
          String(err),
      },
      502,
      cors
    );
  }
}


// ============================================================
// REDIRECT HANDLING
// ============================================================

async function followRedirects(
  initialUrl,
  method,
  headers
) {
  let current = initialUrl;

  const maxRedirects = 5;

  for (
    let attempt = 0;
    attempt <= maxRedirects;
    attempt++
  ) {

    console.log(
      "[UPSTREAM]",
      {
        attempt: attempt + 1,
        url: current,
      }
    );

    const response =
      await fetch(
        current,
        {
          method,

          headers: {
            ...headers,
          },

          redirect: "manual",

          cache: "no-store",
        }
      );

    if (
      !isRedirect(response.status)
    ) {
      return {
        response,
        finalUrl: current,
      };
    }

    const location =
      response.headers.get(
        "Location"
      );

    console.log(
      "[REDIRECT]",
      {
        status: response.status,
        from: current,
        location,
      }
    );

    if (!location) {
      return {
        response,
        finalUrl: current,
      };
    }

    if (
      attempt >= maxRedirects
    ) {
      return {
        response,
        finalUrl: current,
      };
    }

    /*
     * Resolve relative Location correctly.
     */
    current =
      new URL(
        location,
        current
      ).href;
  }

  throw new Error(
    "Too many redirects"
  );
}


function isRedirect(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}


// ============================================================
// M3U8 REWRITE
// ============================================================

function rewriteM3U8(
  text,
  baseUrl
) {
  const lines =
    text.split("\n");

  const output = [];

  for (const originalLine of lines) {
    let line =
      originalLine;

    if (
      line.startsWith("#")
    ) {
      line =
        rewriteTagUri(
          line,
          baseUrl
        );

      output.push(line);
      continue;
    }

    const value =
      line.trim();

    if (!value) {
      output.push(line);
      continue;
    }

    const resolved =
      resolveUrl(
        value,
        baseUrl
      );

    output.push(
      toProxyUrl(resolved)
    );
  }

  return output.join("\n");
}


function rewriteTagUri(
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
        `URI="${toProxyUrl(resolved)}"`
      );
    }
  );
}


function resolveUrl(
  value,
  base
) {
  if (
    value.startsWith("http://") ||
    value.startsWith("https://")
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


function toProxyUrl(url) {
  return (
    "/stream?url=" +
    encodeURIComponent(url)
  );
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
        error:
          "Missing url parameter",
      },
      400,
      cors
    );
  }

  let parsed;

  try {
    parsed =
      new URL(target);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      throw new Error(
        "Invalid protocol"
      );
    }
  } catch {
    return json(
      {
        error:
          "Invalid URL",
      },
      400,
      cors
    );
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",

    "Accept":
      "*/*",

    "Referer":
      "http://barqtv.website/",
  };

  const range =
    request.headers.get("Range");

  if (range) {
    headers["Range"] = range;
  }

  try {
    const result =
      await followRedirects(
        target,
        "GET",
        headers
      );

    const response =
      result.response;

    let bodyPreview = "";

    /*
     * Only read a tiny diagnostic body.
     */
    if (response.body) {
      try {
        const reader =
          response.body.getReader();

        const decoder =
          new TextDecoder();

        const { value } =
          await reader.read();

        if (value) {
          bodyPreview =
            decoder.decode(
              value
            ).slice(0, 4096);
        }

        try {
          await reader.cancel();
        } catch {}
      } catch (err) {
        bodyPreview =
          "[body read failed] " +
          (err?.message ||
            String(err));
      }
    }

    return json(
      {
        request: {
          url: target,
          protocol:
            parsed.protocol,
          range:
            range || null,
        },

        response: {
          status:
            response.status,

          statusText:
            response.statusText,

          finalUrl:
            result.finalUrl,

          redirected:
            result.finalUrl !== target,

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

            wwwAuthenticate:
              response.headers.get(
                "WWW-Authenticate"
              ),

            cacheControl:
              response.headers.get(
                "Cache-Control"
              ),

            cfRay:
              response.headers.get(
                "CF-Ray"
              ),
          },

          bodyPreview,
        },
      },
      200,
      cors
    );

  } catch (err) {
    return json(
      {
        error:
          "Debug fetch failed",

        details:
          err?.message ||
          String(err),

        url: target,
      },
      502,
      cors
    );
  }
}


// ============================================================
// JSON
// ============================================================

function json(
  data,
  status,
  cors
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
        ...cors,

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
