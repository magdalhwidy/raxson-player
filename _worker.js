import { connect } from "cloudflare:sockets";

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
      if (url.pathname === "/api") {
        return await handleApi(url, cors);
      }

      if (url.pathname === "/stream") {
        return await handleStream(request, url, cors, env);
      }

      if (url.pathname === "/debug") {
        return await handleDebug(request, url, cors, env);
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

const ORIGIN_HOST = "origin.raxson.online";

const ALLOWED_STREAM_HOSTS = new Set([
  "barqtv.website",
  "barqtvclg.shop",
  ORIGIN_HOST,
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
  const target = url.searchParams.get("url")?.trim();

  if (!target) {
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
      env
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
        request
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
          request
        )}"`;
      } catch (_) {
        return match;
      }
    }
  );
}

function buildStreamProxyUrl(
  absoluteUrl,
  request
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

  return workerUrl.href;
}

// ============================================================
// DNS AUTO UPDATE
// ============================================================

async function updateOriginDns(ip, env) {
  if (!env?.CF_API_TOKEN || !env?.CF_ZONE_ID) {
    throw new Error("Missing CF_API_TOKEN or CF_ZONE_ID");
  }

  if (!isPublicIpv4Address(ip)) {
    throw new Error("Invalid public IPv4: " + ip);
  }

  const apiBase =
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`;

  const authHeaders = {
    "Authorization": `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  const lookupUrl =
    `${apiBase}?type=A&name=origin.raxson.online`;

  const lookupResponse = await fetch(lookupUrl, {
    method: "GET",
    headers: authHeaders,
    cache: "no-store",
  });

  const lookupData = await lookupResponse.json();

  if (!lookupData.success) {
    throw new Error(
      "Cloudflare DNS lookup failed: " +
      JSON.stringify(lookupData.errors)
    );
  }

  const record = lookupData.result?.[0];

  const body = {
    type: "A",
    name: "origin.raxson.online",
    content: ip,
    ttl: 60,
    proxied: false,
  };

  if (record?.id) {
    const updateUrl = `${apiBase}/${record.id}`;

    const updateResponse = await fetch(updateUrl, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(body),
    });

    const updateData = await updateResponse.json();

    if (!updateData.success) {
      throw new Error(
        "Cloudflare DNS update failed: " +
        JSON.stringify(updateData.errors)
      );
    }

    console.log("[DNS UPDATED]", {
      hostname: ORIGIN_HOST,
      ip,
      recordId: record.id,
    });

    return updateData;
  }

  const createResponse = await fetch(apiBase, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });

  const createData = await createResponse.json();

  if (!createData.success) {
    throw new Error(
      "Cloudflare DNS create failed: " +
      JSON.stringify(createData.errors)
    );
  }

  console.log("[DNS CREATED]", {
    hostname: ORIGIN_HOST,
    ip,
    recordId: createData.result?.id,
  });

  return createData;
}
// ============================================================
// REDIRECT FOLLOWING
// ============================================================

async function followRedirects(
  initialUrl,
  method,
  headers,
  _env,
  allowedHosts = ALLOWED_STREAM_HOSTS
) {
  let current = initialUrl;
  let hops = 0;
  const maxHops = 8;

  while (hops < maxHops) {
    const parsed = new URL(current);
    const hostname = parsed.hostname.toLowerCase();

    // Upstream may redirect to a literal public IPv4.
    // Point our DNS-only origin hostname at that IP, then fetch
    // the same path through the hostname instead of the IP.
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

      try {
        await updateOriginDns(hostname, _env);
      } catch (error) {
        return {
          response: new Response(
            "Origin DNS update failed: " +
              (error?.message || String(error)),
            {
              status: 502,
            }
          ),
          finalUrl: current,
          hops,
        };
      }

      const rewrittenUrl = new URL(current);

      rewrittenUrl.hostname = ORIGIN_HOST;

      console.log("[IP → ORIGIN]", {
        ip: hostname,
        host: ORIGIN_HOST,
      });

      current = rewrittenUrl.href;
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

// ============================================================
// HTTP HEAD READER
// ============================================================

async function readHttpHead(
  reader
) {
  const marker =
    new Uint8Array([
      13,
      10,
      13,
      10,
    ]);

  const decoder =
    new TextDecoder(
      "latin1"
    );

  let buffer =
    new Uint8Array(0);

  const maxHeaderBytes =
    64 * 1024;

  while (
    buffer.length <=
    maxHeaderBytes
  ) {
    const markerIndex =
      indexOfBytes(
        buffer,
        marker
      );

    if (markerIndex !== -1) {
      return {
        headerText:
          decoder.decode(
            buffer.slice(
              0,
              markerIndex
            )
          ),

        rest:
          buffer.slice(
            markerIndex +
              marker.length
          ),
      };
    }

    const result =
      await reader.read();

    if (result.done) {
      throw new Error(
        "Upstream closed before HTTP headers were received"
      );
    }

    if (
      result.value?.length
    ) {
      buffer =
        concatBytes(
          buffer,
          result.value
        );
    }
  }

  throw new Error(
    "Upstream HTTP headers are too large"
  );
}

// ============================================================
// HTTP BODY STREAMS
// ============================================================

function createHttpBodyStream({
  reader,
  initialBody,
  contentLength,
  chunked,
  socket,
}) {
  if (chunked) {
    return createChunkedBodyStream(
      reader,
      initialBody,
      socket
    );
  }

  if (contentLength !== null) {
    return createFixedLengthBodyStream(
      reader,
      initialBody,
      contentLength,
      socket
    );
  }

  return createUntilCloseBodyStream(
    reader,
    initialBody,
    socket
  );
}

function createFixedLengthBodyStream(
  reader,
  initialBody,
  contentLength,
  socket
) {
  let pending =
    initialBody ||
    new Uint8Array(0);

  let remaining =
    contentLength;

  let closed = false;

  return new ReadableStream({
    async pull(controller) {
      if (closed) {
        return;
      }

      try {
        if (remaining <= 0) {
          closed = true;

          controller.close();

          cleanupSocketReader(
            reader,
            socket
          );

          return;
        }

        let chunk =
          pending;

        pending =
          new Uint8Array(0);

        while (
          !chunk ||
          chunk.length === 0
        ) {
          const result =
            await reader.read();

          if (result.done) {
            throw new Error(
              "Upstream ended before Content-Length was satisfied"
            );
          }

          chunk =
            result.value;
        }

        const take =
          Math.min(
            chunk.length,
            remaining
          );

        const output =
          take === chunk.length
            ? chunk
            : chunk.slice(
                0,
                take
              );

        remaining -= take;

        controller.enqueue(
          output
        );

        if (
          remaining <= 0
        ) {
          closed = true;

          controller.close();

          cleanupSocketReader(
            reader,
            socket
          );
        }
      } catch (error) {
        closed = true;

        controller.error(
          error
        );

        cleanupSocketReader(
          reader,
          socket
        );
      }
    },

    async cancel() {
      closed = true;

      try {
        await reader.cancel();
      } catch (_) {}

      cleanupSocketReader(
        reader,
        socket
      );
    },
  });
}

function createUntilCloseBodyStream(
  reader,
  initialBody,
  socket
) {
  let pending =
    initialBody ||
    new Uint8Array(0);

  let closed = false;

  return new ReadableStream({
    async pull(controller) {
      if (closed) {
        return;
      }

      try {
        if (pending.length) {
          const chunk =
            pending;

          pending =
            new Uint8Array(0);

          controller.enqueue(
            chunk
          );

          return;
        }

        const result =
          await reader.read();

        if (result.done) {
          closed = true;

          controller.close();

          cleanupSocketReader(
            reader,
            socket
          );

          return;
        }

        if (
          result.value?.length
        ) {
          controller.enqueue(
            result.value
          );
        }
      } catch (error) {
        closed = true;

        controller.error(
          error
        );

        cleanupSocketReader(
          reader,
          socket
        );
      }
    },

    async cancel() {
      closed = true;

      try {
        await reader.cancel();
      } catch (_) {}

      cleanupSocketReader(
        reader,
        socket
      );
    },
  });
}

function createChunkedBodyStream(
  reader,
  initialBody,
  socket
) {
  let buffer =
    initialBody ||
    new Uint8Array(0);

  let remaining = null;
  let closed = false;

  return new ReadableStream({
    async pull(controller) {
      if (closed) {
        return;
      }

      try {
        while (true) {
          if (
            remaining === 0
          ) {
            const separator =
              await readExactBytes(
                reader,
                buffer,
                2
              );

            buffer =
              separator.rest;

            remaining = null;
          }

          if (
            remaining === null
          ) {
            const lineResult =
              await readLineBytes(
                reader,
                buffer
              );

            buffer =
              lineResult.rest;

            const line =
              new TextDecoder(
                "latin1"
              ).decode(
                lineResult.line
              ).trim();

            const semicolon =
              line.indexOf(";");

            const sizeText =
              semicolon === -1
                ? line
                : line.slice(
                    0,
                    semicolon
                  );

            const size =
              parseInt(
                sizeText,
                16
              );

            if (
              !Number.isFinite(size)
            ) {
              throw new Error(
                "Invalid chunk size"
              );
            }

            if (size === 0) {
              closed = true;

              controller.close();

              cleanupSocketReader(
                reader,
                socket
              );

              return;
            }

            remaining = size;
          }

          if (
            buffer.length === 0
          ) {
            const result =
              await reader.read();

            if (result.done) {
              throw new Error(
                "Upstream ended during chunked body"
              );
            }

            buffer =
              result.value;

            continue;
          }

          const take =
            Math.min(
              buffer.length,
              remaining
            );

          const output =
            buffer.slice(
              0,
              take
            );

          buffer =
            buffer.slice(
              take
            );

          remaining -= take;

          controller.enqueue(
            output
          );

          return;
        }
      } catch (error) {
        closed = true;

        controller.error(
          error
        );

        cleanupSocketReader(
          reader,
          socket
        );
      }
    },

    async cancel() {
      closed = true;

      try {
        await reader.cancel();
      } catch (_) {}

      cleanupSocketReader(
        reader,
        socket
      );
    },
  });
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
// SOCKET HTTP
// ============================================================

async function fetchIpv4Http(
  url,
  request,
  cors
) {
  const parsed =
    new URL(url);

  const hostname =
    parsed.hostname;

  const port =
    Number(
      parsed.port ||
        (
          parsed.protocol ===
          "https:"
            ? 443
            : 80
        )
    );

  if (
    !isIpv4Address(
      hostname
    )
  ) {
    throw new Error(
      "fetchIpv4Http requires an IPv4 address"
    );
  }

  if (
    !isPublicIpv4Address(
      hostname
    )
  ) {
    throw new Error(
      "Blocked private IPv4 address"
    );
  }

  const socket =
    connect({
      hostname,
      port,
    });

  const writer =
    socket.writable.getWriter();

  const reader =
    socket.readable.getReader();

  try {
    const requestHeaders =
      buildUpstreamHeaders(
        request,
        url
      );

    requestHeaders.set(
      "Host",
      parsed.host
    );

    requestHeaders.set(
      "Connection",
      "close"
    );

    let requestText =
      `${request.method} ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`;

    for (
      const [
        name,
        value,
      ] of requestHeaders
    ) {
      requestText +=
        `${name}: ${value}\r\n`;
    }

    requestText +=
      "\r\n";

    await writer.write(
      new TextEncoder().encode(
        requestText
      )
    );

    writer.releaseLock();

    const head =
      await readHttpHead(
        reader
      );

    const parsedHead =
      parseHttpResponseHead(
        head.headerText
      );

    const bodyStream =
      createHttpBodyStream({
        reader,
        initialBody:
          head.rest,
        contentLength:
          parsedHead.contentLength,
        chunked:
          parsedHead.chunked,
        socket,
      });

    const headers =
      new Headers(cors);

    for (
      const [
        name,
        value,
      ] of parsedHead.headers
    ) {
      if (
        name.toLowerCase() ===
          "connection" ||
        name.toLowerCase() ===
          "transfer-encoding"
      ) {
        continue;
      }

      headers.set(
        name,
        value
      );
    }

    return new Response(
      bodyStream,
      {
        status:
          parsedHead.status,
        statusText:
          parsedHead.statusText,
        headers,
      }
    );
  } catch (error) {
    try {
      reader.releaseLock();
    } catch (_) {}

    try {
      writer.releaseLock();
    } catch (_) {}

    try {
      socket.close();
    } catch (_) {}

    throw error;
  }
}

// ============================================================
// HTTP RESPONSE HEAD PARSER
// ============================================================

function parseHttpResponseHead(
  headerText
) {
  const lines =
    headerText.split(
      "\r\n"
    );

  const statusLine =
    lines.shift() || "";

  const statusMatch =
    statusLine.match(
      /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/
    );

  if (!statusMatch) {
    throw new Error(
      "Invalid HTTP response"
    );
  }

  const status =
    Number(
      statusMatch[1]
    );

  const statusText =
    statusMatch[2] || "";

  const headers =
    new Headers();

  for (
    const line of lines
  ) {
    if (!line) {
      continue;
    }

    const index =
      line.indexOf(":");

    if (index <= 0) {
      continue;
    }

    const name =
      line.slice(
        0,
        index
      ).trim();

    const value =
      line.slice(
        index + 1
      ).trim();

    try {
      headers.append(
        name,
        value
      );
    } catch (_) {}
  }

  const contentLengthHeader =
    headers.get(
      "Content-Length"
    );

  let contentLength =
    null;

  if (
    contentLengthHeader &&
    /^\d+$/.test(
      contentLengthHeader
    )
  ) {
    contentLength =
      Number(
        contentLengthHeader
      );
  }

  const transferEncoding =
    (
      headers.get(
        "Transfer-Encoding"
      ) || ""
    ).toLowerCase();

  const chunked =
    transferEncoding.includes(
      "chunked"
    );

  return {
    status,
    statusText,
    headers,
    contentLength,
    chunked,
  };
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
        requestUrl
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

async function handleStream(
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
    return errorResponse(
      "Missing url parameter",
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
      "Invalid upstream URL",
      400,
      cors
    );
  }

  if (
    parsed.protocol !==
      "http:" &&
    parsed.protocol !==
      "https:"
  ) {
    return errorResponse(
      "Unsupported protocol",
      400,
      cors
    );
  }

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
    return errorResponse(
      "Upstream host not allowed",
      403,
      cors
    );
  }

  try {
    const result =
      await fetchUpstream(
        request,
        parsed.href,
        env
      );

    const response =
      result.response;

    if (!response) {
      return errorResponse(
        "No upstream response",
        502,
        cors
      );
    }

    const contentType =
      (
        response.headers.get(
          "Content-Type"
        ) || ""
      ).toLowerCase();

    const isPlaylist =
      contentType.includes(
        "mpegurl"
      ) ||
      parsed.pathname
        .toLowerCase()
        .endsWith(
          ".m3u8"
        );

    if (
      isPlaylist &&
      response.ok
    ) {
      return await handleM3U8(
        response,
        result.finalUrl,
        request,
        cors
      );
    }

    return buildBinaryResponse(
      response,
      cors
    );
  } catch (error) {
    console.error(
      "[STREAM ERROR]",
      error?.message ||
        String(error)
    );

    return errorResponse(
      "Stream proxy failed: " +
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
