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

    let response;

    if (isIpv4Address(parsed.hostname)) {
      if (!isPublicIpv4Address(parsed.hostname)) {
        return {
          response: new Response("Blocked private IP", {
            status: 403,
          }),
          finalUrl: current,
          hops,
        };
      }

      // إعادة الـIP إلى hostname الخاص بنا
      // بدل استخدام TCP socket المباشر
      const rewrittenUrl = new URL(current);
      rewrittenUrl.hostname = "origin.raxson.online";

      console.log("[REDIRECT REWRITE]", {
        originalIP: parsed.hostname,
        newHost: rewrittenUrl.hostname,
      });

      current = rewrittenUrl.href;
      hops++;
      continue;
    }

    response = await fetch(current, {
      method,
      headers,
      redirect: "manual",
      cache: "no-store",
    });

    const location = response.headers.get("Location");

    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      !!location;

    if (!isRedirect) {
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
        response,
        finalUrl: current,
        hops,
      };
    }

    console.log("[REDIRECT]", {
      status: response.status,
      from: safeHost(current),
      to: safeHost(nextUrl.href),
    });

    try {
      await response.body?.cancel();
    } catch (_) {}

    if (
      nextUrl.protocol !== "http:" &&
      nextUrl.protocol !== "https:"
    ) {
      return {
        response,
        finalUrl: current,
        hops,
      };
    }

    const nextHost =
      nextUrl.hostname.toLowerCase();

    if (isIpv4Address(nextHost)) {
      if (!isPublicIpv4Address(nextHost)) {
        return {
          response,
          finalUrl: current,
          hops,
        };
      }

      const rewrittenUrl = new URL(nextUrl.href);
      rewrittenUrl.hostname = "origin.raxson.online";

      console.log("[REDIRECT REWRITE]", {
        originalIP: nextHost,
        newHost: rewrittenUrl.hostname,
      });

      current = rewrittenUrl.href;
      hops++;
      continue;
    }

    if (!allowedHosts.has(nextHost)) {
      return {
        response,
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
        headers: {
          "Cache-Control": "no-store",
        },
      }
    ),
    finalUrl: current,
    hops,
  };
}

// ============================================================
// DIRECT IPV4 HTTP VIA WORKERS TCP SOCKETS
// ============================================================

async function fetchIpv4Http(
  url,
  method,
  headers
) {
  if (url.protocol !== "http:") {
    throw new Error(
      "Direct IPv4 HTTPS redirects are not supported"
    );
  }

  if (!isPublicIpv4Address(url.hostname)) {
    throw new Error(
      "Direct IPv4 address is not public"
    );
  }

  const port = url.port
    ? Number(url.port)
    : 80;

  if (port !== 80) {
    throw new Error(
      "Direct IPv4 redirect uses unsupported port " +
        port
    );
  }

  const socket = connect({
    hostname: url.hostname,
    port,
  });

  await socket.opened;

  const outbound = new Headers(
    headers
  );

  outbound.set(
    "Host",
    url.host
  );

  outbound.set(
    "Connection",
    "close"
  );

  outbound.delete(
    "Proxy-Connection"
  );

  outbound.delete(
    "Transfer-Encoding"
  );

  outbound.delete(
    "Content-Length"
  );

  const requestTarget =
    url.pathname +
    (url.search || "");

  const requestText = [
    `${method} ${
      requestTarget || "/"
    } HTTP/1.1`,
    ...Array.from(
      outbound,
      ([name, value]) =>
        `${name}: ${value}`
    ),
    "",
    "",
  ].join("\r\n");

  try {
    const writer =
      socket.writable.getWriter();

    try {
      await writer.write(
        new TextEncoder().encode(
          requestText
        )
      );
    } finally {
      try {
        await writer.close();
      } catch (_) {}
    }

    const reader =
      socket.readable.getReader();

    try {
      const head =
        await readHttpHead(reader);

      const headerLines =
        head.headerText.split(
          "\r\n"
        );

      const statusLine =
        headerLines.shift() || "";

      const statusMatch =
        statusLine.match(
          /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i
        );

      if (!statusMatch) {
        throw new Error(
          "Invalid upstream HTTP status line: " +
            statusLine
        );
      }

      const status =
        Number(statusMatch[1]);

      const statusText =
        statusMatch[2] || "";

      const responseHeaders =
        new Headers();

      for (
        const line of headerLines
      ) {
        const index =
          line.indexOf(":");

        if (index <= 0) {
          continue;
        }

        try {
          responseHeaders.append(
            line
              .slice(0, index)
              .trim(),
            line
              .slice(index + 1)
              .trim()
          );
        } catch (_) {}
      }

      const transferEncoding =
        (
          responseHeaders.get(
            "Transfer-Encoding"
          ) || ""
        ).toLowerCase();

      const contentLengthHeader =
        responseHeaders.get(
          "Content-Length"
        );

      const contentLength =
        contentLengthHeader !== null &&
        /^\d+$/.test(
          contentLengthHeader.trim()
        )
          ? Number(
              contentLengthHeader.trim()
            )
          : null;

      console.log(
        "[DIRECT IPV4 HTTP]",
        {
          url:
            `${url.protocol}//${url.host}${url.pathname}`,
          status,
          contentLength,
          transferEncoding,
          initialBodyBytes:
            head.rest.length,
        }
      );

      if (
        method === "HEAD" ||
        status === 204 ||
        status === 304
      ) {
        try {
          await reader.cancel();
        } catch (_) {}

        try {
          socket.close();
        } catch (_) {}

        return new Response(
          null,
          {
            status,
            statusText,
            headers:
              responseHeaders,
          }
        );
      }

      const body =
        createHttpBodyStream({
          reader,
          initialBody:
            head.rest,
          contentLength,
          chunked:
            transferEncoding
              .split(",")
              .some(
                (v) =>
                  v.trim() ===
                  "chunked"
              ),
          socket,
        });

      return new Response(
        body,
        {
          status,
          statusText,
          headers:
            responseHeaders,
        }
      );
    } catch (error) {
      try {
        await reader.cancel();
      } catch (_) {}

      try {
        reader.releaseLock();
      } catch (_) {}

      try {
        socket.close();
      } catch (_) {}

      throw error;
    }
  } catch (error) {
    try {
      socket.close();
    } catch (_) {}

    throw error;
  }
}

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

  let state = "size";

  let remaining = 0;

  let closed = false;

  const decoder =
    new TextDecoder(
      "latin1"
    );

  async function ensureBytes(
    count
  ) {
    while (
      buffer.length <
      count
    ) {
      const result =
        await reader.read();

      if (result.done) {
        return false;
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

    return true;
  }

  async function readLine() {
    while (true) {
      for (
        let i = 0;
        i + 1 <
        buffer.length;
        i++
      ) {
        if (
          buffer[i] === 13 &&
          buffer[i + 1] === 10
        ) {
          const line =
            decoder.decode(
              buffer.slice(
                0,
                i
              )
            );

          buffer =
            buffer.slice(
              i + 2
            );

          return line;
        }
      }

      const result =
        await reader.read();

      if (result.done) {
        return null;
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

      if (
        buffer.length >
        64 * 1024
      ) {
        throw new Error(
          "Chunked response line is too large"
        );
      }
    }
  }

  return new ReadableStream({
    async pull(controller) {
      if (closed) {
        return;
      }

      try {
        while (true) {
          if (
            state === "size"
          ) {
            const line =
              await readLine();

            if (line === null) {
              throw new Error(
                "Unexpected end of chunked response"
              );
            }

            const sizeText =
              line
                .split(
                  ";",
                  1
                )[0]
                .trim();

            if (
              !/^[0-9a-fA-F]+$/.test(
                sizeText
              )
            ) {
              throw new Error(
                "Invalid chunk size"
              );
            }

            remaining =
              parseInt(
                sizeText,
                16
              );

            if (
              remaining === 0
            ) {
              while (true) {
                const trailer =
                  await readLine();

                if (
                  trailer ===
                    null ||
                  trailer === ""
                ) {
                  break;
                }
              }

              closed = true;

              controller.close();

              cleanupSocketReader(
                reader,
                socket
              );

              return;
            }

            state = "data";
          }

          if (
            state === "data"
          ) {
            if (
              !(await ensureBytes(
                1
              ))
            ) {
              throw new Error(
                "Unexpected end of chunk data"
              );
            }

            const take =
              Math.min(
                remaining,
                buffer.length
              );

            if (take > 0) {
              controller.enqueue(
                buffer.slice(
                  0,
                  take
                )
              );

              buffer =
                buffer.slice(
                  take
                );

              remaining -=
                take;

              if (
                remaining > 0
              ) {
                return;
              }

              state = "crlf";

              return;
            }
          }

          if (
            state === "crlf"
          ) {
            if (
              !(await ensureBytes(
                2
              ))
            ) {
              throw new Error(
                "Missing chunk terminator"
              );
            }

            if (
              buffer[0] !== 13 ||
              buffer[1] !== 10
            ) {
              throw new Error(
                "Invalid chunk terminator"
              );
            }

            buffer =
              buffer.slice(
                2
              );

            state = "size";
          }
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

function cleanupSocketReader(
  reader,
  socket
) {
  try {
    reader.releaseLock();
  } catch (_) {}

  try {
    socket.close();
  } catch (_) {}
}

function concatBytes(
  a,
  b
) {
  if (!a || !a.length) {
    return b || new Uint8Array(0);
  }

  if (!b || !b.length) {
    return a;
  }

  const result =
    new Uint8Array(
      a.length + b.length
    );

  result.set(a, 0);
  result.set(b, a.length);

  return result;
}

function indexOfBytes(
  haystack,
  needle
) {
  if (
    !haystack ||
    !needle ||
    needle.length === 0
  ) {
    return -1;
  }

  outer:
  for (
    let i = 0;
    i <=
      haystack.length -
        needle.length;
    i++
  ) {
    for (
      let j = 0;
      j < needle.length;
      j++
    ) {
      if (
        haystack[i + j] !==
        needle[j]
      ) {
        continue outer;
      }
    }

    return i;
  }

  return -1;
}

// ============================================================
// IP VALIDATION
// ============================================================

function isIpv4Address(
  value
) {
  if (
    typeof value !==
    "string"
  ) {
    return false;
  }

  const parts =
    value.split(".");

  if (parts.length !== 4) {
    return false;
  }

  return parts.every(
    (part) => {
      if (
        part === "" ||
        !/^\d+$/.test(part)
      ) {
        return false;
      }

      const n =
        Number(part);

      return (
        n >= 0 &&
        n <= 255
      );
    }
  );
}

function isPublicIpv4Address(
  ip
) {
  if (!isIpv4Address(ip)) {
    return false;
  }

  const [
    a,
    b,
    c,
    d,
  ] = ip
    .split(".")
    .map(Number);

  // 0.0.0.0/8
  if (a === 0) {
    return false;
  }

  // 10.0.0.0/8
  if (a === 10) {
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

  // 192.0.0.0/24
  if (
    a === 192 &&
    b === 0 &&
    c === 0
  ) {
    return false;
  }

  // 192.0.2.0/24
  if (
    a === 192 &&
    b === 0 &&
    c === 2
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

  // 198.18.0.0/15
  if (
    a === 198 &&
    (b === 18 ||
      b === 19)
  ) {
    return false;
  }

  // 198.51.100.0/24
  if (
    a === 198 &&
    b === 51 &&
    c === 100
  ) {
    return false;
  }

  // 203.0.113.0/24
  if (
    a === 203 &&
    b === 0 &&
    c === 113
  ) {
    return false;
  }

  // 224.0.0.0/4 multicast
  if (a >= 224) {
    return false;
  }

  // 255.255.255.255
  if (
    a === 255 &&
    b === 255 &&
    c === 255 &&
    d === 255
  ) {
    return false;
  }

  return true;
}

// ============================================================
// BINARY RESPONSE
// ============================================================

function buildBinaryResponse(
  response,
  cors
) {
  const headers =
    new Headers();

  for (
    const [name, value] of
    response.headers
  ) {
    if (
      isHopByHopHeader(name)
    ) {
      continue;
    }

    try {
      headers.set(
        name,
        value
      );
    } catch (_) {}
  }

  for (
    const [name, value] of
    Object.entries(cors)
  ) {
    headers.set(
      name,
      value
    );
  }

  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
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
// UPSTREAM HEADERS
// ============================================================

function buildUpstreamHeaders(
  request,
  targetUrl
) {
  const headers =
    new Headers();

  const incomingNames = [
    "Accept",
    "Accept-Language",
    "Authorization",
    "Range",
    "If-None-Match",
    "If-Modified-Since",
  ];

  for (
    const name of
    incomingNames
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

  headers.set(
    "User-Agent",
    request.headers.get(
      "User-Agent"
    ) ||
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0"
  );

  headers.set(
    "Accept",
    headers.get(
      "Accept"
    ) ||
      "*/*"
  );

  try {
    const target =
      new URL(targetUrl);

    headers.set(
      "Referer",
      target.origin + "/"
    );

    headers.set(
      "Origin",
      target.origin
    );
  } catch (_) {}

  headers.delete(
    "Host"
  );

  headers.delete(
    "Content-Length"
  );

  headers.delete(
    "Transfer-Encoding"
  );

  headers.delete(
    "Connection"
  );

  return headers;
}

// ============================================================
// HEADER HELPERS
// ============================================================

function isHopByHopHeader(
  name
) {
  const value =
    name.toLowerCase();

  return (
    value ===
      "connection" ||
    value ===
      "keep-alive" ||
    value ===
      "proxy-authenticate" ||
    value ===
      "proxy-authorization" ||
    value ===
      "te" ||
    value ===
      "trailer" ||
    value ===
      "transfer-encoding" ||
    value ===
      "upgrade"
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
    url.searchParams.get(
      "url"
    );

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
        "GET",
        headers,
        env
      );

    const response =
      result.response;

    const contentType =
      response.headers.get(
        "Content-Type"
      );

    const contentLength =
      response.headers.get(
        "Content-Length"
      );

    const transferEncoding =
      response.headers.get(
        "Transfer-Encoding"
      );

    let preview = "";

    if (
      contentType &&
      (
        contentType.includes(
          "text"
        ) ||
        contentType.includes(
          "mpegurl"
        ) ||
        contentType.includes(
          "json"
        )
      )
    ) {
      preview =
        safeBodyPreview(
          await safeReadText(
            response
          )
        );
    } else {
      try {
        await response.body?.cancel();
      } catch (_) {}
    }

    return json(
      {
        ok:
          response.ok,
        status:
          response.status,
        statusText:
          response.statusText,
        initialUrl:
          parsed.href,
        finalUrl:
          result.finalUrl,
        finalHost:
          safeHost(
            result.finalUrl
          ),
        hops:
          result.hops,
        contentType,
        contentLength,
        transferEncoding,
        location:
          response.headers.get(
            "Location"
          ),
        preview,
      },
      200,
      cors
    );
  } catch (err) {
    return json(
      {
        error:
          "Debug request failed",
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
// URL / HOST HELPERS
// ============================================================

function safeHost(
  value
) {
  try {
    const parsed =
      new URL(value);

    return parsed.host;
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
  max = 1000
) {
  if (
    typeof text !==
    "string"
  ) {
    return "";
  }

  return text
    .replace(
      /[\r\n]+/g,
      " "
    )
    .slice(0, max);
}

// ============================================================
// JSON
// ============================================================

function json(
  data,
  status = 200,
  cors = {}
) {
  const headers =
    new Headers({
      ...cors,
      "Content-Type":
        "application/json; charset=utf-8",
      "Cache-Control":
        "no-store, no-cache, must-revalidate",
      Pragma:
        "no-cache",
    });

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers,
    }
  );
}
