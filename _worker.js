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
      {
        error: "Missing parameters",
      },
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

  const origin = getOrigin(cleanHost);

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",

    "Accept":
      "application/json, text/plain, */*",

    "Accept-Language":
      "ar,en;q=0.9",

    "Referer":
      origin + "/",
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
      {
        error: "Missing url parameter",
      },
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
      {
        error: "Invalid URL",
      },
      400,
      cors
    );
  }

  const method =
    request.method === "HEAD"
      ? "HEAD"
      : "GET";

  const range =
    request.headers.get("Range");

  const headers = buildStreamHeaders(parsed);

  if (range) {
    headers["Range"] = range;
  }

  console.log("[STREAM START]", {
    target,
    method,
    range: range || null,
  });

  try {
    /*
     * ========================================================
     * IMPORTANT:
     *
     * If the original URL is HTTP, HTTPS is tested FIRST.
     *
     * This is important because the HTTP endpoint may redirect
     * to a Cloudflare-protected IP.
     * ========================================================
     */

    let result;

    if (parsed.protocol === "http:") {
      const httpsUrl = makeHttpsUrl(target);

      console.log(
        "[STREAM] Trying HTTPS first:",
        httpsUrl
      );

      try {
        const httpsResult = await followRedirects(
          httpsUrl,
          method,
          headers
        );

        console.log("[STREAM HTTPS RESULT]", {
          status: httpsResult.response.status,
          finalUrl: httpsResult.finalUrl,
          redirected:
            httpsResult.finalUrl !== httpsUrl,
        });

        /*
         * Use HTTPS if it gives us a usable response.
         *
         * 2xx = definitely usable.
         *
         * We also keep a 3xx/4xx result temporarily so that
         * we can report/fallback correctly.
         */
        if (
          httpsResult.response.status >= 200 &&
          httpsResult.response.status < 300
        ) {
          result = httpsResult;
        }

      } catch (err) {
        console.error(
          "[STREAM HTTPS ERROR]",
          err?.message || String(err)
        );
      }
    }

    /*
     * ========================================================
     * HTTP FALLBACK
     * ========================================================
     */

    if (!result) {
      console.log(
        "[STREAM] Trying original URL:",
        target
      );

      const directResponse = await fetch(target, {
  method,
  headers: {
    ...headers,
  },
  redirect: "follow",
  cache: "no-store",
});

const location = directResponse.headers.get("Location");

if (
  location &&
  [301, 302, 303, 307, 308].includes(directResponse.status)
) {
  return new Response(null, {
    status: directResponse.status,
    headers: {
      ...cors,
      "Location": location,
      "Cache-Control": "no-store",
    },
  });
}

result = {
  response: directResponse,
  finalUrl: target,
};
    }

    let response = result.response;
    let finalUrl = result.finalUrl;

    console.log("[STREAM FINAL]", {
      status: response.status,
      finalUrl,
      redirected: finalUrl !== target,
      contentType:
        response.headers.get("Content-Type"),
      contentLength:
        response.headers.get("Content-Length"),
      contentRange:
        response.headers.get("Content-Range"),
      acceptRanges:
        response.headers.get("Accept-Ranges"),
      server:
        response.headers.get("Server"),
    });


    // ========================================================
    // EXPLICIT CLOUDFLARE 1003 DIAGNOSIS
    // ========================================================

    if (
      response.status === 403 &&
      finalUrl
    ) {
      const finalParsed = new URL(finalUrl);

      const bodyPreview = "";

      if (
        isIpAddress(finalParsed.hostname) &&
        bodyPreview.includes("1003")
      ) {
        return json(
          {
            error:
              "Upstream redirected to a direct IP and Cloudflare rejected it.",

            code: "CLOUDFLARE_1003",

            originalUrl: target,

            finalUrl,

            message:
              "The upstream server is redirecting the stream to a direct IP address. This cannot be fixed by the Worker unless the upstream provides a valid hostname/stream URL.",

            bodyPreview,
          },
          502,
          cors
        );
      }

      /*
       * We consumed the body above only for a diagnostic 1003
       * check. For normal 403 responses do not consume it.
       *
       * Therefore the body is only consumed when it actually
       * looks like Cloudflare 1003.
       */
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

console.log(
  "[M3U8 OUTPUT]",
  rewritten.substring(0, 500)
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
    // BINARY VIDEO
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
     * NEVER convert video to text/arrayBuffer.
     *
     * Stream the upstream ReadableStream directly.
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
        target,
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
// STREAM HEADERS
// ============================================================

function buildStreamHeaders(parsed) {
  /*
   * Use the source origin as Referer rather than a hard-coded
   * unrelated domain.
   */

  const origin =
    `${parsed.protocol}//${parsed.host}`;

  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",

    "Accept":
      "*/*",

    "Accept-Language":
      "en-US,en;q=0.9",

    "Referer":
      origin + "/",

    "Origin":
      origin,
  };
}


// ============================================================
// HTTPS URL
// ============================================================

function makeHttpsUrl(value) {
  const u = new URL(value);

  u.protocol = "https:";

  /*
   * HTTP port 80 should not remain when switching to HTTPS.
   */

  if (u.port === "80") {
    u.port = "";
  }

  return u.href;
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

  const hops = [];

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

    const location =
      response.headers.get("Location");

    hops.push({
      attempt: attempt + 1,

      url: current,

      status:
        response.status,

      statusText:
        response.statusText,

      location:
        location || null,

      server:
        response.headers.get("Server") ||
        null,

      contentType:
        response.headers.get("Content-Type") ||
        null,
    });

    if (!isRedirect(response.status)) {
      return {
        response,
        finalUrl: current,
        hops,
      };
    }

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
        hops,
      };
    }

    if (
      attempt >= maxRedirects
    ) {
      return {
        response,
        finalUrl: current,
        hops,
      };
    }

    let nextUrl =
      new URL(
        location,
        current
      );

    /*
     * ========================================================
     * CLOUDFLARE WORKER IP REDIRECT FIX
     *
     * The authorized upstream redirects the stream to:
     *
     * 37.49.230.120
     *
     * Cloudflare Workers cannot fetch a direct IP.
     *
     * We created:
     *
     * origin.raxson.online
     *        ↓
     * 37.49.230.120
     *
     * DNS Only.
     *
     * Therefore change ONLY the hostname while preserving
     * the original path, query string and authentication token.
     * ========================================================
     */

    if (
  nextUrl.hostname === "37.49.230.120" ||
  nextUrl.hostname === "37.49.230.121"
) {
  console.log(
    "[REDIRECT REWRITE DISABLED - DIRECT IP]",
    {
      ip: nextUrl.hostname,
    }
  );
}

    current =
      nextUrl.href;
  }

  throw new Error(
    "Too many redirects"
  );
}

// ============================================================
// REDIRECT CHECK
// ============================================================

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
    text.split(/\r?\n/);

  const output = [];

  for (const originalLine of lines) {
    let line =
      originalLine;

    /*
     * HLS tags may contain URI="..."
     */

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

    /*
     * Every media/playlist URL is resolved against the
     * final upstream URL and then proxied.
     */

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


// ============================================================
// HLS TAG URI
// ============================================================

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


// ============================================================
// URL RESOLUTION
// ============================================================

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


// ============================================================
// PROXY URL
// ============================================================

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

  const range =
    request.headers.get("Range");

  const headers =
    buildStreamHeaders(parsed);

  if (range) {
    headers["Range"] = range;
  }

  /*
   * ========================================================
   * DEBUG BOTH PROTOCOLS
   *
   * This is the important change.
   *
   * If the supplied URL is HTTP, we test:
   *
   * 1. HTTPS
   * 2. HTTP
   *
   * If supplied URL is HTTPS, we test HTTPS only.
   * ========================================================
   */

  const tests = [];

  if (parsed.protocol === "http:") {
    tests.push({
      name: "HTTPS",
      url: makeHttpsUrl(target),
    });

    tests.push({
      name: "HTTP",
      url: target,
    });

  } else {
    tests.push({
      name: "HTTPS",
      url: target,
    });
  }

  const results = [];

  for (const test of tests) {
    try {
      const result =
        await followRedirects(
          test.url,
          "GET",
          headers
        );

      const response =
        result.response;

      const preview =
        await safeBodyPreview(
          response
        );

      let finalHost = null;
      let finalProtocol = null;
      let redirectedToIp = false;

      try {
        const finalParsed =
          new URL(result.finalUrl);

        finalHost =
          finalParsed.hostname;

        finalProtocol =
          finalParsed.protocol;

        redirectedToIp =
          isIpAddress(
            finalParsed.hostname
          );

      } catch {}

      results.push({
        name: test.name,

        requestUrl:
          test.url,

        status:
          response.status,

        statusText:
          response.statusText,

        finalUrl:
          result.finalUrl,

        finalHost,

        finalProtocol,

        redirected:
          result.finalUrl !== test.url,

        redirectedToIp,

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

        cfRay:
          response.headers.get(
            "CF-Ray"
          ),

        bodyPreview:
          preview,

        hops:
          result.hops,
      });

    } catch (err) {
      results.push({
        name: test.name,

        requestUrl:
          test.url,

        error:
          err?.message ||
          String(err),
      });
    }
  }

  /*
   * ========================================================
   * DIAGNOSIS
   * ========================================================
   */

  const working =
    results.find(
      r =>
        r.status >= 200 &&
        r.status < 300 &&
        !r.error
    );

  const cloudflare1003 =
    results.filter(
      r =>
        r.status === 403 &&
        r.redirectedToIp &&
        String(
          r.bodyPreview || ""
        ).includes("1003")
    );

  let diagnosis;

  if (working) {
    diagnosis = {
      status: "WORKING_PATH_FOUND",

      message:
        `${working.name} returned a successful upstream response.`,

      workingUrl:
        working.requestUrl,

      finalUrl:
        working.finalUrl,

      contentType:
        working.contentType,
    };

  } else if (
    cloudflare1003.length ===
    results.length
  ) {
    diagnosis = {
      status:
        "UPSTREAM_DIRECT_IP_1003",

      message:
        "Both tested paths redirect to a direct IP and Cloudflare returns error 1003.",

      explanation:
        "The upstream stream URL needs to be corrected by the source/provider. A Worker cannot legitimately turn the Cloudflare direct-IP rejection into a working hostname.",
    };

  } else {
    diagnosis = {
      status:
        "NO_WORKING_PATH",

      message:
        "Neither tested protocol returned a successful stream response.",

      explanation:
        "Check the individual HTTP/HTTPS results above.",
    };
  }

  return json(
    {
      test:
        "http-and-https-stream-diagnostic",

      request: {
        url: target,

        protocol:
          parsed.protocol,

        range:
          range || null,
      },

      results,

      diagnosis,
    },
    200,
    cors
  );
}


// ============================================================
// BODY PREVIEW
// ============================================================

async function safeBodyPreview(
  response
) {
  /*
   * Only use this for small diagnostic/error bodies.
   *
   * Never call this on successful video streams.
   */

  const contentType =
    response.headers.get(
      "Content-Type"
    ) || "";

  const contentLength =
    Number(
      response.headers.get(
        "Content-Length"
      ) || "0"
    );

  /*
   * Only inspect likely text/error responses.
   */

  const looksText =
    contentType.includes("text") ||
    contentType.includes("json") ||
    contentType.includes("plain");

  if (
    !looksText &&
    contentLength > 4096
  ) {
    return "";
  }

  if (!response.body) {
    return "";
  }

  try {
    const reader =
      response.body.getReader();

    const decoder =
      new TextDecoder();

    const { value } =
      await reader.read();

    try {
      await reader.cancel();
    } catch {}

    if (!value) {
      return "";
    }

    return decoder
      .decode(value)
      .slice(0, 4096);

  } catch {
    return "";
  }
}


// ============================================================
// IP CHECK
// ============================================================

function isIpAddress(hostname) {
  /*
   * IPv4
   */

  if (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(
      hostname
    )
  ) {
    return true;
  }

  /*
   * IPv6
   */

  if (
    hostname.includes(":")
  ) {
    return true;
  }

  return false;
}


// ============================================================
// ORIGIN
// ============================================================

function getOrigin(host) {
  try {
    const u =
      new URL(host);

    return (
      `${u.protocol}//${u.host}`
    );

  } catch {
    return host.replace(
      /\/+$/,
      ""
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
