export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Range, Accept, Origin, Referer",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
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
      console.log("[ROUTER]", {
        pathname: url.pathname,
        search: url.search,
      });

      // ======================================================
      // API - Movies / Series / Account
      // ======================================================

      if (url.pathname === "/api") {
        return await handleApi(url, cors);
      }

      // ======================================================
      // MEDIA
      // Only MOVIE and SERIES playback is enabled.
      // LIVE playback is intentionally disabled.
      // ======================================================

      if (url.pathname === "/stream") {
        return await handleMedia(request, url, cors, env);
      }

      // ======================================================
      // TEST
      // ======================================================

      if (url.pathname === "/test") {
        return new Response("Worker OK", {
          status: 200,
          headers: cors,
        });
      }

      // ======================================================
      // DEBUG
      // ======================================================

      if (url.pathname === "/debug") {
        return await handleDebug(request, url, cors, env);
      }

      // ======================================================
      // ASSETS
      // ======================================================

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", {
        status: 404,
        headers: cors,
      });
    } catch (err) {
      console.error(
        "[WORKER ERROR]",
        err?.message || String(err)
      );

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
  const extraRaw = url.searchParams.get("extra") || "";

  if (!host || !user || !pass || !action) {
    return json(
      {
        error: "Missing parameters",
        required: [
          "host",
          "user",
          "pass",
          "action",
        ],
      },
      400,
      cors
    );
  }

  let parsedHost;

  try {
    parsedHost = new URL(
      host.replace(/\/+$/, "")
    );

    if (
      parsedHost.protocol !== "http:" &&
      parsedHost.protocol !== "https:"
    ) {
      throw new Error(
        "Unsupported protocol"
      );
    }
  } catch (err) {
    return json(
      {
        error: "Invalid host",
        details:
          err?.message || String(err),
      },
      400,
      cors
    );
  }

  const hostname =
    parsedHost.hostname.toLowerCase();

  /*
   * API is allowed only to the configured
   * Xtream servers.
   */
  if (!ALLOWED_HOSTS.has(hostname)) {
    return json(
      {
        error: "API host not allowed",
        host: hostname,
      },
      403,
      cors
    );
  }

  const cleanHost =
    parsedHost.origin;

  /*
   * Build player_api.php safely.
   */
  const targetUrl = new URL(
    "/player_api.php",
    cleanHost
  );

  targetUrl.searchParams.set(
    "username",
    user
  );

  targetUrl.searchParams.set(
    "password",
    pass
  );

  targetUrl.searchParams.set(
    "action",
    action
  );

  /*
   * index.html sends extra like:
   *
   * &series_id=123
   *
   * or:
   *
   * &category_id=5
   *
   * Decode and append those parameters
   * correctly.
   */
  appendExtraParams(
    targetUrl,
    extraRaw
  );

  const headers = new Headers();

  headers.set(
    "User-Agent",
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
  );

  headers.set(
    "Accept",
    "application/json, text/plain, */*"
  );

  headers.set(
    "Accept-Language",
    "ar,en;q=0.9"
  );

  headers.set(
    "Referer",
    cleanHost + "/"
  );

  headers.set(
    "Origin",
    cleanHost
  );

  console.log("[API START]", {
    action,
    host: hostname,
    hasExtra: !!extraRaw,
  });

  try {
    const response = await fetch(
      targetUrl.href,
      {
        method: "GET",
        headers,
        redirect: "follow",
        cache: "no-store",
      }
    );

    const finalHost =
      safeHost(response.url);

    console.log("[API RESPONSE]", {
      action,
      status: response.status,
      finalHost,
      contentType:
        response.headers.get(
          "Content-Type"
        ) || "",
    });

    const body =
      await response.text();

    /*
     * Empty API responses should not crash
     * the frontend.
     */
    if (!body.trim()) {
      console.warn(
        "[API EMPTY]",
        {
          action,
          status: response.status,
        }
      );

      return new Response("[]", {
        status: response.ok
          ? 200
          : response.status,

        headers: {
          ...cors,
          "Content-Type":
            "application/json; charset=utf-8",
          "Cache-Control":
            "no-cache, no-store, must-revalidate",
          "Pragma":
            "no-cache",
        },
      });
    }

    /*
     * Verify JSON.
     *
     * The original index.html calls res.json().
     * If the upstream sends HTML instead,
     * expose the actual problem.
     */
    let parsed;

    try {
      parsed = JSON.parse(body);
    } catch (_) {
      console.error(
        "[API NON JSON]",
        {
          action,
          status: response.status,
          finalHost,
          preview:
            safeBodyPreview(
              body,
              800
            ),
        }
      );

      return json(
        {
          error:
            "API returned non-JSON",
          upstreamStatus:
            response.status,
          upstreamHost:
            finalHost,
          bodyPreview:
            safeBodyPreview(
              body,
              800
            ),
        },
        response.ok
          ? 502
          : response.status,
        cors
      );
    }

    console.log("[API JSON OK]", {
      action,
      status: response.status,
      type: Array.isArray(parsed)
        ? "array"
        : typeof parsed,

      length:
        Array.isArray(parsed)
          ? parsed.length
          : undefined,

      keys:
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
          ? Object.keys(parsed).slice(
              0,
              20
            )
          : undefined,
    });

    /*
     * Return the original JSON body
     * without changing Xtream fields.
     */
    return new Response(body, {
      status: response.status,
      statusText:
        response.statusText,

      headers: {
        ...cors,
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-cache, no-store, must-revalidate",

        "Pragma":
          "no-cache",
      },
    });
  } catch (err) {
    console.error(
      "[API ERROR]",
      {
        action,
        host: hostname,
        error:
          err?.message ||
          String(err),
      }
    );

    return json(
      {
        error: "Fetch failed",
        action,
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
// EXTRA QUERY PARAMETERS
// ============================================================

function appendExtraParams(
  targetUrl,
  extraRaw
) {
  if (!extraRaw) {
    return;
  }

  let extra = extraRaw.trim();

  /*
   * Remove leading ? or &
   */
  extra = extra.replace(
    /^[?&]+/,
    ""
  );

  if (!extra) {
    return;
  }

  /*
   * Parse using URLSearchParams.
   *
   * Example:
   * series_id=123&category_id=5
   */
  try {
    const params =
      new URLSearchParams(
        extra
      );

    for (
      const [key, value]
      of params.entries()
    ) {
      if (!key) continue;

      targetUrl.searchParams.set(
        key,
        value
      );
    }
  } catch (err) {
    console.warn(
      "[API EXTRA PARSE ERROR]",
      err?.message ||
        String(err)
    );
  }
}

// ============================================================
// MEDIA
// Movies + Series ONLY
// ============================================================

async function handleMedia(
  request,
  url,
  cors,
  env
) {
  const target =
    url.searchParams
      .get("url")
      ?.trim();

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
      parsed.protocol !==
        "http:" &&
      parsed.protocol !==
        "https:"
    ) {
      throw new Error(
        "Invalid protocol"
      );
    }

    const hostname =
      parsed.hostname.toLowerCase();

    if (
      !ALLOWED_HOSTS.has(
        hostname
      )
    ) {
      return json(
        {
          error:
            "Host not allowed",
          host:
            hostname,
        },
        403,
        cors
      );
    }
  } catch (err) {
    return json(
      {
        error:
          "Invalid URL",
        details:
          err?.message ||
          String(err),
      },
      400,
      cors
    );
  }

  /*
   * IMPORTANT:
   *
   * Live streams are disabled.
   *
   * Movies:
   * /movie/user/pass/id.mp4
   *
   * Series:
   * /series/user/pass/id.mp4
   */
  const mediaPath =
    parsed.pathname
      .toLowerCase();

  const isMovie =
    mediaPath.includes(
      "/movie/"
    );

  const isSeries =
    mediaPath.includes(
      "/series/"
    );

  const isLive =
    mediaPath.includes(
      "/live/"
    );

  if (isLive) {
    console.log(
      "[LIVE DISABLED]",
      parsed.pathname
    );

    return json(
      {
        error:
          "Live streaming is disabled",
      },
      403,
      cors
    );
  }

  if (!isMovie && !isSeries) {
    return json(
      {
        error:
          "Only movie and series media are allowed",
        path:
          parsed.pathname,
      },
      403,
      cors
    );
  }

  console.log(
    "[MEDIA ROUTE]",
    {
      type:
        isMovie
          ? "movie"
          : "series",

      path:
        parsed.pathname,
    }
  );

  const requestHeaders =
    buildUpstreamHeaders(
      request,
      parsed.href
    );

  try {
    const result =
      await followRedirects(
        parsed.href,
        request.method,
        requestHeaders,
        env
      );

    if (
      !result ||
      !result.response
    ) {
      return json(
        {
          error:
            "Upstream request failed",
        },
        502,
        cors
      );
    }

    const response =
      result.response;

    const finalUrl =
      result.finalUrl ||
      parsed.href;

    const finalParsed =
      new URL(finalUrl);

    const contentType =
      (
        response.headers.get(
          "Content-Type"
        ) || ""
      ).toLowerCase();

    console.log(
      "[MEDIA RESPONSE]",
      {
        type:
          isMovie
            ? "movie"
            : "series",

        status:
          response.status,

        finalHost:
          finalParsed.hostname,

        redirected:
          result.hops > 0,

        hops:
          result.hops,

        contentType,

        contentLength:
          response.headers.get(
            "Content-Length"
          ) || "",
      }
    );

    if (!response.ok) {
      const errorText =
        await safeReadText(
          response
        );

      return new Response(
        errorText ||
          `Upstream HTTP ${response.status}`,
        {
          status:
            response.status,

          statusText:
            response.statusText,

          headers: {
            ...cors,

            "Content-Type":
              response.headers.get(
                "Content-Type"
              ) ||
              "text/plain; charset=UTF-8",

            "Cache-Control":
              "no-store",
          },
        }
      );
    }

    /*
     * Movies and series are normally MP4.
     *
     * If an upstream VOD URL happens to return
     * HLS, keep the M3U8 handling available.
     */
    const isPlaylist =
      contentType.includes(
        "mpegurl"
      ) ||
      contentType.includes(
        "vnd.apple.mpegurl"
      ) ||
      /\.m3u8(?:$|\?)/i.test(
        finalUrl
      );

    if (isPlaylist) {
      return await handleM3U8(
        response,
        finalUrl,
        request,
        cors
      );
    }

    /*
     * For VOD media, redirect the browser to
     * the resolved final media URL when possible.
     *
     * This avoids sending the entire movie file
     * through the Worker.
     */
    if (
      isSafeFinalMediaUrl(
        finalParsed
      )
    ) {
      try {
        await response.body?.cancel();
      } catch (_) {}

      const headers =
        new Headers(cors);

      headers.set(
        "Location",
        finalUrl
      );

      headers.set(
        "Cache-Control",
        "no-store"
      );

      return new Response(
        null,
        {
          status: 302,
          headers,
        }
      );
    }

    /*
     * Fallback: proxy binary data.
     */
    return buildBinaryResponse(
      response,
      cors
    );
  } catch (err) {
    console.error(
      "[MEDIA ERROR]",
      err?.message ||
        String(err)
    );

    return json(
      {
        error:
          "Media fetch failed",
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
// SAFE FINAL MEDIA URL
// ============================================================

function isSafeFinalMediaUrl(
  url
) {
  if (
    !url ||
    (
      url.protocol !==
        "http:" &&
      url.protocol !==
        "https:"
    )
  ) {
    return false;
  }

  if (
    isIpv4Address(
      url.hostname
    )
  ) {
    if (
      !isPublicIpv4Address(
        url.hostname
      )
    ) {
      return false;
    }

    return (
      !url.port ||
      url.port === "80" ||
      url.port === "443"
    );
  }

  return ALLOWED_HOSTS.has(
    url.hostname.toLowerCase()
  );
}

// ============================================================
// M3U8
// Kept only in case VOD returns HLS.
// ============================================================

async function handleM3U8(
  response,
  finalUrl,
  request,
  cors
) {
  const text =
    await response.text();

  const base =
    new URL(finalUrl);

  const lines =
    text.split(/\r?\n/);

  const rewritten =
    lines.map(
      (line) => {
        const trimmed =
          line.trim();

        if (!trimmed) {
          return line;
        }

        if (
          trimmed.startsWith(
            "#"
          )
        ) {
          return rewriteUriAttribute(
            line,
            base,
            request
          );
        }

        try {
          const absolute =
            new URL(
              trimmed,
              base.href
            ).href;

          return buildMediaProxyUrl(
            absolute,
            request
          );
        } catch (_) {
          return line;
        }
      }
    );

  const headers =
    new Headers(cors);

  headers.set(
    "Content-Type",
    "application/vnd.apple.mpegurl"
  );

  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  return new Response(
    rewritten.join("\n"),
    {
      status:
        response.status,
      headers,
    }
  );
}

function rewriteUriAttribute(
  line,
  base,
  request
) {
  return line.replace(
    /URI="([^"]+)"/gi,
    (
      match,
      uri
    ) => {
      try {
        const absolute =
          new URL(
            uri,
            base.href
          ).href;

        return `URI="${buildMediaProxyUrl(
          absolute,
          request
        )}"`;
      } catch (_) {
        return match;
      }
    }
  );
}

function buildMediaProxyUrl(
  absoluteUrl,
  request
) {
  const workerUrl =
    new URL(
      request.url
    );

  workerUrl.pathname =
    "/stream";

  workerUrl.search = "";

  workerUrl.searchParams.set(
    "url",
    absoluteUrl
  );

  return workerUrl.href;
}

// ============================================================
// REDIRECT FOLLOWING
// ============================================================

async function followRedirects(
  initialUrl,
  method,
  headers,
  _env,
  forcedHost
) {
  let current =
    initialUrl;

  let hops = 0;

  const maxHops = 8;

  const initialParsed =
    new URL(
      initialUrl
    );

  let sniHostname =
    forcedHost?.toLowerCase() ||
    initialParsed.hostname.toLowerCase();

  while (
    hops < maxHops
  ) {
    const parsed =
      new URL(current);

    const hostname =
      parsed.hostname.toLowerCase();

    // ========================================================
    // IP REDIRECT
    // ========================================================

    if (
      isIpv4Address(
        hostname
      )
    ) {
      if (
        !isPublicIpv4Address(
          hostname
        )
      ) {
        return {
          response:
            new Response(
              "Blocked private IP",
              {
                status: 403,
              }
            ),

          finalUrl:
            current,

          hops,
        };
      }

      const ipAddress =
        hostname;

      const fetchUrl =
        new URL(current);

      fetchUrl.hostname =
        sniHostname;

      console.log(
        "[IP REDIRECT]",
        {
          ip:
            ipAddress,

          sniHostname,

          path:
            fetchUrl.pathname +
            fetchUrl.search,
        }
      );

      let response;

      try {
        response =
          await fetch(
            fetchUrl.href,
            {
              method,
              headers,
              redirect:
                "manual",
              cache:
                "no-store",

              cf: {
                resolveOverride:
                  ipAddress,
              },
            }
          );
      } catch (error) {
        return {
          response:
            new Response(
              "Upstream fetch failed: " +
                (
                  error?.message ||
                  String(error)
                ),
              {
                status: 502,
              }
            ),

          finalUrl:
            current,

          hops,
        };
      }

      const isRedirect =
        response.status >=
          300 &&
        response.status <
          400;

      if (!isRedirect) {
        return {
          response,
          finalUrl:
            current,
          hops,
        };
      }

      const location =
        response.headers.get(
          "Location"
        );

      if (!location) {
        return {
          response,
          finalUrl:
            current,
          hops,
        };
      }

      let nextUrl;

      try {
        nextUrl =
          new URL(
            location,
            current
          );
      } catch (_) {
        return {
          response:
            new Response(
              "Invalid upstream redirect",
              {
                status: 502,
              }
            ),

          finalUrl:
            current,

          hops,
        };
      }

      if (
        nextUrl.protocol !==
          "http:" &&
        nextUrl.protocol !==
          "https:"
      ) {
        return {
          response:
            new Response(
              "Unsupported redirect protocol",
              {
                status: 403,
              }
            ),

          finalUrl:
            current,

          hops,
        };
      }

      const nextHost =
        nextUrl.hostname.toLowerCase();

      if (
        !isIpv4Address(
          nextHost
        ) &&
        !ALLOWED_HOSTS.has(
          nextHost
        )
      ) {
        return {
          response:
            new Response(
              "Redirect host not allowed",
              {
                status: 403,
              }
            ),

          finalUrl:
            current,

          hops,
        };
      }

      if (
        !isIpv4Address(
          nextHost
        )
      ) {
        sniHostname =
          nextHost;
      }

      current =
        nextUrl.href;

      hops++;

      continue;
    }

    // ========================================================
    // NORMAL HOST
    // ========================================================

    if (
      !ALLOWED_HOSTS.has(
        hostname
      )
    ) {
      return {
        response:
          new Response(
            "Redirect host not allowed",
            {
              status: 403,
            }
          ),

        finalUrl:
          current,

        hops,
      };
    }

    let response;

    try {
      response =
        await fetch(
          current,
          {
            method,
            headers,
            redirect:
              "manual",
            cache:
              "no-store",
          }
        );
    } catch (error) {
      return {
        response:
          new Response(
            "Upstream fetch failed: " +
              (
                error?.message ||
                String(error)
              ),
            {
              status: 502,
            }
          ),

        finalUrl:
          current,

        hops,
      };
    }

    const isRedirect =
      response.status >=
        300 &&
      response.status <
        400;

    if (!isRedirect) {
      return {
        response,
        finalUrl:
          current,
        hops,
      };
    }

    const location =
      response.headers.get(
        "Location"
      );

    if (!location) {
      return {
        response,
        finalUrl:
          current,
        hops,
      };
    }

    let nextUrl;

    try {
      nextUrl =
        new URL(
          location,
          current
        );
    } catch (_) {
      return {
        response:
          new Response(
            "Invalid upstream redirect",
            {
              status: 502,
            }
          ),

        finalUrl:
          current,

        hops,
      };
    }

    if (
      nextUrl.protocol !==
        "http:" &&
      nextUrl.protocol !==
        "https:"
    ) {
      return {
        response:
          new Response(
            "Unsupported redirect protocol",
            {
              status: 403,
            }
          ),

        finalUrl:
          current,

        hops,
      };
    }

    const nextHost =
      nextUrl.hostname.toLowerCase();

    if (
      !isIpv4Address(
        nextHost
      ) &&
      !ALLOWED_HOSTS.has(
        nextHost
      )
    ) {
      return {
        response:
          new Response(
            "Redirect host not allowed",
            {
              status: 403,
            }
          ),

        finalUrl:
          current,

        hops,
      };
    }

    if (
      !isIpv4Address(
        nextHost
      )
    ) {
      sniHostname =
        nextHost;
    }

    current =
      nextUrl.href;

    hops++;
  }

  return {
    response:
      new Response(
        "Too many redirects",
        {
          status: 508,
        }
      ),

    finalUrl:
      current,

    hops,
  };
}

// ============================================================
// UPSTREAM HEADERS
// ============================================================

function buildUpstreamHeaders(
  request,
  targetUrl
) {
  const headers =
    new Headers();

  const copyHeaders = [
    "Accept",
    "Accept-Language",
    "Authorization",
    "Range",
    "User-Agent",
  ];

  for (
    const name of copyHeaders
  ) {
    const value =
      request.headers.get(
        name
      );

    if (value) {
      headers.set(
        name,
        value
      );
    }
  }

  if (
    !headers.has(
      "User-Agent"
    )
  ) {
    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0"
    );
  }

  if (
    !headers.has(
      "Accept"
    )
  ) {
    headers.set(
      "Accept",
      "*/*"
    );
  }

  try {
    const origin =
      getOrigin(
        targetUrl
      );

    headers.set(
      "Referer",
      origin + "/"
    );

    headers.set(
      "Origin",
      origin
    );
  } catch (_) {}

  return headers;
}

// ============================================================
// BINARY RESPONSE
// ============================================================

function buildBinaryResponse(
  response,
  cors
) {
  const headers =
    new Headers(cors);

  const copyHeaders = [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
    "Content-Disposition",
  ];

  for (
    const name of copyHeaders
  ) {
    const value =
      response.headers.get(
        name
      );

    if (value) {
      headers.set(
        name,
        value
      );
    }
  }

  headers.set(
    "Cache-Control",
    "no-store"
  );

  return new Response(
    response.body,
    {
      status:
        response.status,

      statusText:
        response.statusText,

      headers,
    }
  );
}

// ============================================================
// DEBUG
// ============================================================

async function handleDebug(
  request,
  url,
  cors,
  env
) {
  const target =
    url.searchParams
      .get("url")
      ?.trim();

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
      parsed.protocol !==
        "http:" &&
      parsed.protocol !==
        "https:"
    ) {
      throw new Error(
        "Invalid protocol"
      );
    }

    if (
      !ALLOWED_HOSTS.has(
        parsed.hostname.toLowerCase()
      )
    ) {
      return json(
        {
          error:
            "Host not allowed",
        },
        403,
        cors
      );
    }
  } catch (err) {
    return json(
      {
        error:
          "Invalid URL",
        details:
          err?.message ||
          String(err),
      },
      400,
      cors
    );
  }

  const headers =
    buildUpstreamHeaders(
      request,
      parsed.href
    );

  try {
    const result =
      await followRedirects(
        parsed.href,
        request.method,
        headers,
        env
      );

    const response =
      result?.response;

    if (!response) {
      return json(
        {
          error:
            "No upstream response",
        },
        502,
        cors
      );
    }

    const body =
      await safeReadText(
        response
      );

    return json(
      {
        status:
          response.status,

        statusText:
          response.statusText,

        finalUrl:
          result.finalUrl ||
          parsed.href,

        finalHost:
          safeHost(
            result.finalUrl ||
              parsed.href
          ),

        redirected:
          result.hops > 0,

        hops:
          result.hops,

        contentType:
          response.headers.get(
            "Content-Type"
          ) || "",

        contentLength:
          response.headers.get(
            "Content-Length"
          ) || "",

        server:
          response.headers.get(
            "Server"
          ) || "",

        location:
          response.headers.get(
            "Location"
          ) || "",

        bodyPreview:
          safeBodyPreview(
            body
          ),
      },
      200,
      cors
    );
  } catch (error) {
    console.error(
      "[DEBUG ERROR]",
      error?.message ||
        String(error)
    );

    return json(
      {
        error:
          "Debug failed",
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
// HELPERS
// ============================================================

async function safeReadText(
  response
) {
  try {
    return await response.text();
  } catch (_) {
    return "";
  }
}

function safeHost(
  value
) {
  try {
    return new URL(
      value
    ).hostname;
  } catch (_) {
    return "";
  }
}

function getOrigin(
  value
) {
  try {
    return new URL(
      value
    ).origin;
  } catch (_) {
    return value;
  }
}

function safeBodyPreview(
  text,
  maxLength = 500
) {
  if (
    typeof text !==
    "string"
  ) {
    return "";
  }

  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(
      0,
      maxLength
    );
}

function json(
  data,
  status = 200,
  cors = {}
) {
  return new Response(
    JSON.stringify(data),
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

// ============================================================
// IPV4
// ============================================================

function isIpv4Address(
  value
) {
  if (
    typeof value !==
      "string" ||
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(
      value
    )
  ) {
    return false;
  }

  const parts =
    value.split(".");

  return parts.every(
    part => {
      const n =
        Number(part);

      return (
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 255
      );
    }
  );
}

function isPublicIpv4Address(
  ip
) {
  if (
    !isIpv4Address(ip)
  ) {
    return false;
  }

  const parts =
    ip.split(".").map(Number);

  const a = parts[0];
  const b = parts[1];

  if (a === 10)
    return false;

  if (a === 127)
    return false;

  if (
    a === 169 &&
    b === 254
  )
    return false;

  if (
    a === 172 &&
    b >= 16 &&
    b <= 31
  )
    return false;

  if (
    a === 192 &&
    b === 168
  )
    return false;

  if (a === 0)
    return false;

  if (
    a === 100 &&
    b >= 64 &&
    b <= 127
  )
    return false;

  if (
    a === 192 &&
    b === 0
  )
    return false;

  if (
    a === 198 &&
    (b === 18 ||
      b === 19)
  )
    return false;

  if (
    a === 198 &&
    b === 51
  )
    return false;

  if (
    a === 203 &&
    b === 0 &&
    parts[2] === 113
  )
    return false;

  if (a >= 224)
    return false;

  return true;
}
