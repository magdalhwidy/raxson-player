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
      console.log("[ROUTER]", { pathname: url.pathname, search: url.search });

      if (url.pathname === "/api") {
        return await handleApi(url, cors);
      }

      if (url.pathname === "/stream") {
        console.log("[STREAM ROUTE MATCHED]");
        return await handleStream(request, url, cors, env);
      }

      if (url.pathname === "/debug") {
        return await handleDebug(request, url, cors, env);
      }

      if (url.pathname === "/test") {
        return new Response("Worker OK", { status: 200, headers: cors });
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", {
        status: 404,
        headers: cors,
      });
    } catch (err) {
      console.error("[WORKER ERROR]", err?.message || String(err));

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

const ALLOWED_STREAM_HOSTS = new Set([
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
    return json({ error: "Missing parameters" }, 400, cors);
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
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ar,en;q=0.9",
    "Referer": origin + "/",
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
      finalHost: safeHost(response.url),
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        ...cors,
        "Content-Type":
          response.headers.get("Content-Type") ||
          "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
      },
    });
  } catch (err) {
    console.error("[API ERROR]", err?.message || String(err));

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

async function handleStream(request, url, cors, env) {
  console.log("[HANDLE_STREAM START]", { url: url.href });
  const target = url.searchParams.get("url")?.trim();
  const forcedHost = url.searchParams.get("host")?.trim();

  if (!target) {
    console.log("[HANDLE_STREAM] Missing url param");
    return json({ error: "Missing url parameter" }, 400, cors);
  }

  let parsed;

  try {
    parsed = new URL(target);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Invalid protocol");
    }

    if (!ALLOWED_STREAM_HOSTS.has(parsed.hostname.toLowerCase())) {
      return json(
        {
          error: "Host not allowed",
          host: parsed.hostname,
        },
        403,
        cors
      );
    }
  } catch (err) {
    return json(
      {
        error: "Invalid URL",
        details: err?.message || String(err),
      },
      400,
      cors
    );
  }

  const requestHeaders = buildUpstreamHeaders(request, parsed.href);

  try {
    const result = await followRedirects(
      parsed.href,
      request.method,
      requestHeaders,
      env,
      forcedHost
    );

    if (!result?.response) {
      return json({ error: "Upstream request failed" }, 502, cors);
    }

    const response = result.response;
    const finalUrl = result.finalUrl || parsed.href;
    const contentType = (
      response.headers.get("Content-Type") || ""
    ).toLowerCase();

    console.log("[STREAM]", {
      status: response.status,
      finalHost: safeHost(finalUrl),
      redirected: result.hops > 0,
      hops: result.hops,
      contentType,
      contentLength: response.headers.get("Content-Length") || "",
      transferEncoding: response.headers.get("Transfer-Encoding") || "",
    });

    if (!response.ok) {
      const errorText = await safeReadText(response);

      if (errorText.includes("1003")) {
        return json(
          {
            error: "UPSTREAM_DIRECT_IP_1003",
            message:
              "Upstream redirected to a direct IP and the direct connection failed.",
            finalHost: safeHost(finalUrl),
            bodyPreview: safeBodyPreview(errorText),
          },
          502,
          cors
        );
      }

      return new Response(
        errorText || `Upstream HTTP ${response.status}`,
        {
          status: response.status,
          statusText: response.statusText,
          headers: {
            ...cors,
            "Content-Type":
              response.headers.get("Content-Type") ||
              "text/plain; charset=UTF-8",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    const isPlaylist =
      contentType.includes("mpegurl") ||
      contentType.includes("vnd.apple.mpegurl") ||
      /\.m3u8(?:$|\?)/i.test(finalUrl);

    if (isPlaylist) {
      return await handleM3U8(
        response,
        finalUrl,
        request,
        cors
      );
    }

    /*
     * Movies / series / direct media:
     * do NOT proxy the media bytes through the Worker.
     * The Worker only resolves the redirect, then tells
     * the browser to fetch the final media URL directly.
     */
    if (isSafeFinalMediaUrl(new URL(finalUrl))) {
      try {
        await response.body?.cancel();
      } catch (_) {}

      const headers = new Headers(cors);

      headers.set("Location", finalUrl);
      headers.set("Cache-Control", "no-store");

      return new Response(null, {
        status: 302,
        headers,
      });
    }

    return buildBinaryResponse(response, cors);
  } catch (err) {
    console.error("[STREAM ERROR]", err?.message || String(err));

    return json(
      {
        error: "Stream fetch failed",
        details: err?.message || String(err),
      },
      502,
      cors
    );
  }
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (_) {
    return "";
  }
}

function isSafeFinalMediaUrl(url) {
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    return false;
  }

  if (isIpv4Address(url.hostname)) {
    if (!isPublicIpv4Address(url.hostname)) {
      return false;
    }

    return (
      !url.port ||
      url.port === "80" ||
      url.port === "443"
    );
  }

  return ALLOWED_STREAM_HOSTS.has(
    url.hostname.toLowerCase()
  );
}

// ============================================================
// M3U8
// ============================================================

async function handleM3U8(
  response,
  finalUrl,
  request,
  cors
) {
  const text = await response.text();

  const base = new URL(finalUrl);

  const lines = text.split(/\r?\n/);

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return line;
    }

    if (trimmed.startsWith("#")) {
      return rewriteUriAttribute(
        line,
        base,
        request
      );
    }

    try {
      const absolute = new URL(
        trimmed,
        base.href
      ).href;

      return buildStreamProxyUrl(
        absolute,
        request,
        base.hostname
      );
    } catch (_) {
      return line;
    }
  });

  const headers = new Headers(cors);

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
      status: response.status,
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
    (match, uri) => {
      try {
        const absolute = new URL(
          uri,
          base.href
        ).href;

        return `URI="${buildStreamProxyUrl(
          absolute,
          request,
          base.hostname
        )}"`;
      } catch (_) {
        return match;
      }
    }
  );
}

function buildStreamProxyUrl(
  absoluteUrl,
  request,
  baseHostname
) {
  const workerUrl = new URL(
    request.url
  );

  workerUrl.pathname = "/stream";

  workerUrl.search = "";

  workerUrl.searchParams.set(
    "url",
    absoluteUrl
  );

  if (baseHostname) {
    workerUrl.searchParams.set(
      "host",
      baseHostname
    );
  }

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
  forcedHost,
  allowedHosts = ALLOWED_STREAM_HOSTS
) {
  console.log("[FOLLOW_REDIRECTS START]", { initialUrl, forcedHost });
  let current = initialUrl;
  let hops = 0;
  const maxHops = 8;

  const initialParsed = new URL(initialUrl);
  let sniHostname = forcedHost?.toLowerCase() || initialParsed.hostname.toLowerCase();
  console.log("[FOLLOW_REDICTS] initial sniHostname:", sniHostname);

  while (hops < maxHops) {
    const parsed = new URL(current);
    const hostname = parsed.hostname.toLowerCase();

    console.log("[FOLLOW] hop", hops, {
      currentUrl: current,
      hostname,
      pathname: parsed.pathname,
      search: parsed.search,
      sniHostname,
    });

    if (isIpv4Address(hostname)) {
      if (!isPublicIpv4Address(hostname)) {
        return {
          response: new Response("Blocked private IP", {
            status: 403,
          }),
          finalUrl: current,
          hops,
        };
      }

      const ipAddress = hostname;
      const fetchUrl = new URL(current);
      fetchUrl.hostname = sniHostname;

      console.log("[IP REDIRECT → resolveOverride]", {
        ip: ipAddress,
        fetchUrl: fetchUrl.href,
        sniHostname,
      });

      const fetchHeaders = new Headers(headers);
      fetchHeaders.set("Host", sniHostname);

      let response;
      try {
        response = await fetch(fetchUrl.href, {
          method,
          headers: fetchHeaders,
          redirect: "manual",
          cache: "no-store",
          cf: {
            resolveOverride: ipAddress,
          },
        });
      } catch (error) {
        return {
          response: new Response(
            "Upstream fetch failed: " +
              (error?.message || String(error)),
            {
              status: 502,
            }
          ),
          finalUrl: current,
          hops,
        };
      }

      const isRedirect =
        response.status >= 300 && response.status < 400;

      console.log("[FOLLOW] response", {
        status: response.status,
        statusText: response.statusText,
        isRedirect,
        contentType: response.headers.get("Content-Type"),
        location: response.headers.get("Location"),
      });

      if (!isRedirect) {
        return {
          response,
          finalUrl: current,
          hops,
        };
      }

      const location = response.headers.get("Location");
      if (!location) {
        return {
          response,
          finalUrl: current,
          hops,
        };
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, current);
      } catch (_) {
        return {
          response: new Response("Invalid upstream redirect", {
            status: 502,
          }),
          finalUrl: current,
          hops,
        };
      }

      console.log("[FOLLOW] redirect", {
        locationHeader: location,
        nextUrl: nextUrl.href,
        nextHostname: nextUrl.hostname,
        nextPathname: nextUrl.pathname,
        nextSearch: nextUrl.search,
      });

      if (
        nextUrl.protocol !== "http:" &&
        nextUrl.protocol !== "https:"
      ) {
        return {
          response: new Response("Unsupported redirect protocol", {
            status: 403,
          }),
          finalUrl: current,
          hops,
        };
      }

      const nextHost = nextUrl.hostname.toLowerCase();

      if (!isIpv4Address(nextHost) && !allowedHosts.has(nextHost)) {
        return {
          response: new Response("Redirect host not allowed", {
            status: 403,
          }),
          finalUrl: current,
          hops,
        };
      }

      if (!isIpv4Address(nextHost)) {
        sniHostname = nextHost;
      }

      current = nextUrl.href;
      hops++;
      continue;
    }

    if (!allowedHosts.has(hostname)) {
      return {
        response: new Response(
          "Redirect host not allowed",
          {
            status: 403,
          }
        ),
        finalUrl: current,
        hops,
      };
    }

    let response;

    try {
      response = await fetch(current, {
        method,
        headers,
        redirect: "manual",
        cache: "no-store",
      });
    } catch (error) {
      return {
        response: new Response(
          "Upstream fetch failed: " +
            (error?.message || String(error)),
          {
            status: 502,
          }
        ),
        finalUrl: current,
        hops,
      };
    }

    const isRedirect =
      response.status >= 300 &&
      response.status < 400;

    if (!isRedirect) {
      return {
        response,
        finalUrl: current,
        hops,
      };
    }

    const location =
      response.headers.get("Location");

    if (!location) {
      return {
        response,
        finalUrl: current,
        hops,
      };
    }

    let nextUrl;

    try {
      nextUrl = new URL(
        location,
        current
      );
    } catch (_) {
      return {
        response: new Response(
          "Invalid upstream redirect",
          {
            status: 502,
          }
        ),
        finalUrl: current,
        hops,
      };
    }

    if (
      nextUrl.protocol !== "http:" &&
      nextUrl.protocol !== "https:"
    ) {
      return {
        response: new Response(
          "Unsupported redirect protocol",
          {
            status: 403,
          }
        ),
        finalUrl: current,
        hops,
      };
    }

    const nextHost =
      nextUrl.hostname.toLowerCase();

    if (
      !isIpv4Address(nextHost) &&
      !allowedHosts.has(nextHost)
    ) {
      return {
        response: new Response(
          "Redirect host not allowed",
          {
            status: 403,
          }
        ),
        finalUrl: current,
        hops,
      };
    }

    current = nextUrl.href;
    hops++;
  }

  return {
    response: new Response(
      "Too many redirects",
      {
        status: 508,
      }
    ),
    finalUrl: current,
    hops,
  };
}

function isPublicIpv4Address(
  ip
) {
  if (!isIpv4Address(ip)) {
    return false;
  }

  const parts =
    ip.split(".").map(Number);

  const a = parts[0];
  const b = parts[1];

  // 10.0.0.0/8
  if (a === 10) {
    return false;
  }

  // 127.0.0.0/8
  if (a === 127) {
    return false;
  }

  // 169.254.0.0/16
  if (
    a === 169 &&
    b === 254
  ) {
    return false;
  }

  // 172.16.0.0/12
  if (
    a === 172 &&
    b >= 16 &&
    b <= 31
  ) {
    return false;
  }

  // 192.168.0.0/16
  if (
    a === 192 &&
    b === 168
  ) {
    return false;
  }

  // 0.0.0.0/8
  if (a === 0) {
    return false;
  }

  // 100.64.0.0/10
  if (
    a === 100 &&
    b >= 64 &&
    b <= 127
  ) {
    return false;
  }

  // 192.0.0.0/24
  if (
    a === 192 &&
    b === 0
  ) {
    return false;
  }

  // 198.18.0.0/15
  if (
    a === 198 &&
    (b === 18 || b === 19)
  ) {
    return false;
  }

  // 198.51.100.0/24
  if (
    a === 198 &&
    b === 51
  ) {
    return false;
  }

  // 203.0.113.0/24
  if (
    a === 203 &&
    b === 0 &&
    parts[2] === 113
  ) {
    return false;
  }

  // 224.0.0.0/4 multicast
  if (a >= 224) {
    return false;
  }

  return true;
}

// ============================================================
// URL / HOST HELPERS
// ============================================================

function safeHost(
  value
) {
  try {
    return new URL(value).hostname;
  } catch (_) {
    return "";
  }
}

function getOrigin(
  value
) {
  try {
    return new URL(value).origin;
  } catch (_) {
    return value;
  }
}

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
    !headers.has("Accept")
  ) {
    headers.set(
      "Accept",
      "*/*"
    );
  }

  try {
    const origin =
      getOrigin(targetUrl);

    headers.set(
      "Referer",
      origin + "/"
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
// JSON
// ============================================================

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
// BODY PREVIEW
// ============================================================

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
  const forcedHost = url.searchParams.get("host")?.trim();

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
      !ALLOWED_STREAM_HOSTS.has(
        parsed.hostname.toLowerCase()
      )
    ) {
      return json(
        {
          error:
            "Host not allowed",
          host:
            parsed.hostname,
        },
        403,
        cors
      );
    }
  } catch (error) {
    return json(
      {
        error:
          "Invalid URL",
        details:
          error?.message ||
          String(error),
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
        env,
        forcedHost
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

    const contentType =
      response.headers.get(
        "Content-Type"
      ) || "";

    const body =
      response.ok
        ? await safeReadText(
            response
          )
        : await safeReadText(
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

        finalProtocol:
          (() => {
            try {
              return new URL(
                result.finalUrl ||
                  parsed.href
              ).protocol;
            } catch (_) {
              return "";
            }
          })(),

        redirected:
          result.hops > 0,

        hops:
          result.hops,

        contentType,

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
// IPV4 VALIDATION
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

// ============================================================
// M3U8 / CONTENT HELPERS
// ============================================================

function looksLikeM3u8(
  contentType,
  text
) {
  const type =
    (
      contentType || ""
    ).toLowerCase();

  if (
    type.includes(
      "mpegurl"
    ) ||
    type.includes(
      "vnd.apple.mpegurl"
    )
  ) {
    return true;
  }

  const sample =
    (
      text || ""
    )
      .trimStart()
      .slice(
        0,
        500
      );

  return (
    sample.startsWith(
      "#EXTM3U"
    )
  );
}

function absoluteUrl(
  value,
  base
) {
  try {
    return new URL(
      value,
      base
    ).href;
  } catch (_) {
    return null;
  }
}

// ============================================================
// M3U8 URI REWRITE
// ============================================================

function rewriteM3u8(
  text,
  baseUrl,
  requestUrl
) {
  const lines =
    text.split(/\r?\n/);

  const output = [];

  for (
    const line of lines
  ) {
    const trimmed =
      line.trim();

    if (
      !trimmed
    ) {
      output.push(line);
      continue;
    }

    if (
      trimmed.startsWith(
        "#"
      )
    ) {
      output.push(
        rewriteUriAttribute(
          line,
          baseUrl,
          requestUrl
        )
      );
      continue;
    }

    const absolute =
      absoluteUrl(
        trimmed,
        baseUrl
      );

    if (!absolute) {
      output.push(line);
      continue;
    }

    output.push(
      buildStreamProxyUrl(
        absolute,
        requestUrl,
        baseUrl.hostname
      )
    );
  }

  return output.join(
    "\n"
  );
}

// ============================================================
// CORS
// ============================================================

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "GET,HEAD,POST,OPTIONS",

    "Access-Control-Allow-Headers":
      "*",

    "Access-Control-Expose-Headers":
      "Content-Length,Content-Range,Accept-Ranges,Content-Type",

    "Access-Control-Max-Age":
      "86400",
  };
}

// ============================================================
// OPTIONS
// ============================================================

function handleOptions(
  cors
) {
  return new Response(
    null,
    {
      status: 204,
      headers: cors,
    }
  );
}

// ============================================================
// ERROR RESPONSE
// ============================================================

function errorResponse(
  message,
  status,
  cors
) {
  return new Response(
    JSON.stringify({
      error: message,
    }),
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
// GENERIC UPSTREAM FETCH
// ============================================================

async function fetchUpstream(
  request,
  targetUrl,
  env
) {
  const parsed =
    new URL(targetUrl);

  const hostname =
    parsed.hostname.toLowerCase();

  if (
    !ALLOWED_STREAM_HOSTS.has(
      hostname
    ) &&
    !isIpv4Address(
      hostname
    )
  ) {
    return {
      response:
        new Response(
          "Host not allowed",
          {
            status: 403,
          }
        ),
      finalUrl:
        targetUrl,
      hops: 0,
    };
  }

  const headers =
    buildUpstreamHeaders(
      request,
      targetUrl
    );

  return await followRedirects(
    targetUrl,
    request.method,
    headers,
    env
  );
}

// ============================================================
// MAIN STREAM HANDLER
// ============================================================



// ============================================================
// API FALLBACK
// ============================================================

async function proxyApiRequest(
  request,
  url,
  cors
) {
  const target =
    url.searchParams.get(
      "target"
    );

  if (!target) {
    return errorResponse(
      "Missing target",
      400,
      cors
    );
  }

  let parsed;

  try {
    parsed =
      new URL(target);
  } catch (_) {
    return errorResponse(
      "Invalid target",
      400,
      cors
    );
  }

  const hostname =
    parsed.hostname.toLowerCase();

  if (
    !ALLOWED_STREAM_HOSTS.has(
      hostname
    )
  ) {
    return errorResponse(
      "API host not allowed",
      403,
      cors
    );
  }

  try {
    const headers =
      buildUpstreamHeaders(
        request,
        parsed.href
      );

    const response =
      await fetch(
        parsed.href,
        {
          method:
            request.method,
          headers,
          redirect:
            "follow",
          cache:
            "no-store",
        }
      );

    const body =
      await response.text();

    const responseHeaders =
      new Headers(cors);

    responseHeaders.set(
      "Content-Type",
      response.headers.get(
        "Content-Type"
      ) ||
        "application/json; charset=utf-8"
    );

    responseHeaders.set(
      "Cache-Control",
      "no-store"
    );

    return new Response(
      body,
      {
        status:
          response.status,
        statusText:
          response.statusText,
        headers:
          responseHeaders,
      }
    );
  } catch (error) {
    return errorResponse(
      "API request failed: " +
        (
          error?.message ||
          String(error)
        ),
      502,
      cors
    );
  }
}

// ============================================================
// FINAL FALLBACK
// ============================================================

async function serveAssets(
  request,
  env
) {
  if (
    env &&
    env.ASSETS
  ) {
    return await env.ASSETS.fetch(
      request
    );
  }

  return new Response(
    "Not Found",
    {
      status: 404,
    }
  );
}

// ============================================================
// END
// ============================================================
