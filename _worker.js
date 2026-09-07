import { connect } from "cloudflare:sockets";

// ============================================================
// CLOUDFLARE WORKER
// ============================================================

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

const ORIGIN_HOST = "origin.raxson.online";

const ALLOWED_STREAM_HOSTS = new Set([
  "barqtv.website",
  "barqtvclg.shop",
  ORIGIN_HOST,
]);

const MAX_REDIRECTS = 8;

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
        "Cache-Control":
          "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
      },
    });
  } catch (err) {
    console.error(
      "[API ERROR]",
      err?.message || String(err)
    );

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
  const target =
    url.searchParams.get("url")?.trim();

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

    const hostname =
      parsed.hostname.toLowerCase();

    /*
     * Initial requests normally use one of the
     * configured upstream hostnames.
     *
     * Direct public IPv4 is also allowed because
     * HLS playlists may contain redirected URLs
     * pointing directly to the streaming server.
     */
    if (
      !ALLOWED_STREAM_HOSTS.has(hostname) &&
      !isPublicIpv4Address(hostname)
    ) {
      return json(
        {
          error: "Host not allowed",
          host: parsed.hostname,
        },
        403,
        cors
      );
    }

    /*
     * Direct IPv4 is intentionally restricted
     * to HTTP port 80.
     */
    if (
      isIpv4Address(hostname) &&
      (
        parsed.protocol !== "http:" ||
        parsed.port &&
        parsed.port !== "80"
      )
    ) {
      return json(
        {
          error: "Direct IPv4 requires HTTP port 80",
          host: parsed.hostname,
          port: parsed.port || "80",
        },
        403,
        cors
      );
    }
  } catch (err) {
    return json(
      {
        error: "Invalid URL",
        details:
          err?.message || String(err),
      },
      400,
      cors
    );
  }

  const requestHeaders =
    buildUpstreamHeaders(
      request,
      target
    );

  try {
    const result =
      await followRedirects(
        parsed.href,
        request.method,
        requestHeaders
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

    console.log("[STREAM]", {
      status:
        response.status,
      finalHost:
        safeHost(finalUrl),
      redirected:
        result.hops > 0,
      hops:
        result.hops,
    });

    /*
     * Cloudflare 1003 diagnostic.
     */
    if (
      response.status === 403 &&
      (
        response.headers
          .get("content-type") ||
        ""
      )
        .toLowerCase()
        .includes("text/plain")
    ) {
      const errorText =
        await response.text();

      if (
        errorText.includes(
          "error code: 1003"
        ) ||
        errorText.includes("1003")
      ) {
        return json(
          {
            error:
              "UPSTREAM_DIRECT_IP_1003",
            message:
              "The upstream redirected to a direct IP and the request was rejected.",
            finalHost:
              safeHost(finalUrl),
            bodyPreview:
              safeBodyPreview(
                errorText
              ),
          },
          502,
          cors
        );
      }

      return new Response(
        errorText,
        {
          status:
            response.status,
          headers: {
            ...cors,
            "Content-Type":
              response.headers.get(
                "Content-Type"
              ) ||
              "text/plain; charset=UTF-8",
          },
        }
      );
    }

    if (!response.ok) {
      return await upstreamErrorResponse(
        response,
        cors
      );
    }

    if (
      isM3u8Response(
        response,
        finalUrl
      )
    ) {
      return await handleM3U8(
        response,
        finalUrl,
        request,
        cors
      );
    }

    return buildBinaryResponse(
      response,
      cors
    );
  } catch (err) {
    console.error(
      "[STREAM ERROR]",
      err?.message || String(err)
    );

    return json(
      {
        error:
          "Stream fetch failed",
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
// M3U8
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
    lines.map((line) => {
      const trimmed =
        line.trim();

      if (!trimmed) {
        return line;
      }

      /*
       * HLS tags such as:
       * #EXT-X-KEY:URI="..."
       * #EXT-X-MAP:URI="..."
       * etc.
       */
      if (
        trimmed.startsWith("#")
      ) {
        return rewriteHlsTag(
          line,
          base.href,
          request
        );
      }

      /*
       * Normal segment / playlist URL.
       */
      try {
        const absolute =
          new URL(
            trimmed,
            base.href
          ).href;

        return makeProxyUrl(
          request,
          absolute
        );
      } catch (_) {
        return line;
      }
    });

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

// ============================================================
// HLS URI REWRITE
// ============================================================

function rewriteHlsTag(
  line,
  baseUrl,
  request
) {
  return line.replace(
    /URI="([^"]+)"/gi,
    (match, uri) => {
      try {
        const absolute =
          new URL(
            uri,
            baseUrl
          ).href;

        return `URI="${makeProxyUrl(
          request,
          absolute
        )}"`;
      } catch (_) {
        return match;
      }
    }
  );
}

// ============================================================
// PROXY URL
// ============================================================

function makeProxyUrl(
  request,
  targetUrl
) {
  const workerUrl =
    new URL(request.url);

  workerUrl.pathname =
    "/stream";

  workerUrl.search = "";

  workerUrl.searchParams.set(
    "url",
    targetUrl
  );

  return workerUrl.href;
}

// ============================================================
// REDIRECT FOLLOWING
// ============================================================

async function followRedirects(
  initialUrl,
  method,
  headers
) {
  let current =
    initialUrl;

  let hops = 0;

  while (
    hops < MAX_REDIRECTS
  ) {
    let response;

    /*
     * If current URL is a direct public
     * IPv4 address, do NOT use fetch().
     *
     * Cloudflare Workers blocks direct IP
     * subrequests through fetch().
     *
     * Instead use an outbound TCP socket.
     */
    try {
      const currentUrl =
        new URL(current);

      if (
        isIpv4Address(
          currentUrl.hostname
        )
      ) {
        response =
          await fetchIpv4Http(
            currentUrl,
            method,
            headers
          );
      } else {
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
      }
    } catch (error) {
      throw new Error(
        `Upstream connection failed: ${
          error?.message ||
          String(error)
        }`
      );
    }

    const location =
      response.headers.get(
        "Location"
      );

    const redirect =
      response.status >= 300 &&
      response.status < 400 &&
      !!location;

    if (!redirect) {
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
        response,
        finalUrl:
          current,
        hops,
      };
    }

    console.log(
      "[REDIRECT]",
      {
        status:
          response.status,
        from:
          safeHost(current),
        to:
          safeHost(
            nextUrl.href
          ),
      }
    );

    if (
      nextUrl.protocol !==
        "http:" &&
      nextUrl.protocol !==
        "https:"
    ) {
      console.error(
        "[REDIRECT BLOCKED PROTOCOL]",
        nextUrl.protocol
      );

      await cancelResponseBody(
        response
      );

      return {
        response,
        finalUrl:
          current,
        hops,
      };
    }

    const nextHost =
      nextUrl.hostname
        .toLowerCase();

    /*
     * DIRECT IPv4 REDIRECT
     *
     * Example:
     *
     * 302
     * Location:
     * http://37.49.230.24:80/auth/TOKEN
     *
     * We keep the exact path and query.
     */
    if (
      isIpv4Address(
        nextHost
      )
    ) {
      if (
        !isPublicIpv4Address(
          nextHost
        )
      ) {
        console.error(
          "[REDIRECT BLOCKED PRIVATE IP]",
          nextHost
        );

        await cancelResponseBody(
          response
        );

        return {
          response,
          finalUrl:
            current,
          hops,
        };
      }

      /*
       * The current solution uses raw HTTP
       * over TCP for direct IPv4.
       */
      if (
        nextUrl.protocol !==
          "http:" ||
        (
          nextUrl.port &&
          nextUrl.port !==
            "80"
        )
      ) {
        console.error(
          "[REDIRECT BLOCKED DIRECT IP PORT]",
          nextUrl.href
        );

        await cancelResponseBody(
          response
        );

        return {
          response,
          finalUrl:
            current,
          hops,
        };
      }

      console.log(
        "[REDIRECT IP TCP]",
        {
          ip:
            nextHost,
          path:
            nextUrl.pathname,
          hasQuery:
            !!nextUrl.search,
        }
      );

      await cancelResponseBody(
        response
      );

      current =
        nextUrl.href;

      hops++;

      continue;
    }

    /*
     * Normal hostname redirect.
     */
    if (
      !ALLOWED_STREAM_HOSTS.has(
        nextHost
      )
    ) {
      console.error(
        "[REDIRECT BLOCKED HOST]",
        nextHost
      );

      await cancelResponseBody(
        response
      );

      return {
        response,
        finalUrl:
          current,
        hops,
      };
    }

    await cancelResponseBody(
      response
    );

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
// DIRECT IPv4 HTTP THROUGH TCP SOCKET
// ============================================================

async function fetchIpv4Http(
  url,
  method,
  headers
) {
  if (
    url.protocol !==
    "http:"
  ) {
    throw new Error(
      "Direct IPv4 HTTPS is not supported by this TCP HTTP fallback."
    );
  }

  if (
    !isIpv4Address(
      url.hostname
    )
  ) {
    throw new Error(
      "Invalid IPv4 address."
    );
  }

  if (
    !isPublicIpv4Address(
      url.hostname
    )
  ) {
    throw new Error(
      "Private or reserved IPv4 address is not allowed."
    );
  }

  const port =
    url.port
      ? Number(url.port)
      : 80;

  if (
    port !== 80
  ) {
    throw new Error(
      "Direct IPv4 HTTP is restricted to port 80."
    );
  }

  const socket =
    connect({
      hostname:
        url.hostname,
      port,
    });

  const writer =
    socket.writable.getWriter();

  const requestHeaders =
    new Headers(headers);

  /*
   * The upstream virtual host may need the
   * original IP as Host, because the redirect
   * explicitly points to the IP.
   */
  if (
    !requestHeaders.has(
      "Host"
    )
  ) {
    requestHeaders.set(
      "Host",
      url.hostname
    );
  }

  /*
   * Do not send hop-by-hop headers.
   */
  requestHeaders.delete(
    "Connection"
  );

  requestHeaders.delete(
    "Proxy-Connection"
  );

  requestHeaders.delete(
    "Transfer-Encoding"
  );

  requestHeaders.delete(
    "Content-Length"
  );

  requestHeaders.set(
    "Connection",
    "close"
  );

  let requestText =
    `${method} ${
      url.pathname ||
      "/"
    }${
      url.search || ""
    } HTTP/1.1\r\n`;

  for (
    const [name, value]
      of requestHeaders
  ) {
    requestText +=
      `${name}: ${value}\r\n`;
  }

  requestText +=
    "\r\n";

  try {
    await writer.write(
      new TextEncoder().encode(
        requestText
      )
    );
  } finally {
    writer.releaseLock();
  }

  const reader =
    socket.readable.getReader();

  try {
    const head =
      await readHttpHead(
        reader
      );

    const statusLine =
      head.statusLine;

    const statusMatch =
      statusLine.match(
        /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i
      );

    if (!statusMatch) {
      throw new Error(
        `Invalid upstream HTTP status: ${statusLine}`
      );
    }

    const status =
      Number(
        statusMatch[1]
      );

    const statusText =
      statusMatch[2] ||
      "";

    const responseHeaders =
      new Headers();

    for (
      const [name, value]
        of head.headers
    ) {
      /*
       * Hop-by-hop response headers
       * should not be forwarded.
       */
      if (
        isHopByHopHeader(
          name
        )
      ) {
        continue;
      }

      responseHeaders.append(
        name,
        value
      );
    }

    const transferEncoding =
      (
        responseHeaders.get(
          "Transfer-Encoding"
        ) || ""
      ).toLowerCase();

    const contentLength =
      responseHeaders.get(
        "Content-Length"
      );

    /*
     * Remove Transfer-Encoding because
     * the Worker stream exposes decoded body.
     */
    responseHeaders.delete(
      "Transfer-Encoding"
    );

    let body;

    if (
      method === "HEAD" ||
      status === 204 ||
      status === 304
    ) {
      body =
        createSocketBodyStream(
          reader,
          socket,
          "none"
        );
    } else if (
      transferEncoding.includes(
        "chunked"
      )
    ) {
      body =
        createSocketBodyStream(
          reader,
          socket,
          "chunked"
        );
    } else if (
      contentLength !==
        null &&
      /^\d+$/.test(
        contentLength.trim()
      )
    ) {
      body =
        createSocketBodyStream(
          reader,
          socket,
          "length",
          Number(
            contentLength.trim()
          )
        );
    } else {
      /*
       * No Content-Length means the body
       * ends when the server closes the socket.
       */
      body =
        createSocketBodyStream(
          reader,
          socket,
          "close"
        );
    }

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
      reader.releaseLock();
    } catch (_) {}

    try {
      socket.close();
    } catch (_) {}

    throw error;
  }
}

// ============================================================
// HTTP RESPONSE HEADER READER
// ============================================================

async function readHttpHead(
  reader
) {
  let buffer =
    new Uint8Array(0);

  const delimiter =
    new TextEncoder().encode(
      "\r\n\r\n"
    );

  while (
    buffer.length <
    128 * 1024
  ) {
    const result =
      await reader.read();

    if (
      result.done
    ) {
      throw new Error(
        "Upstream closed connection before HTTP headers were received."
      );
    }

    if (
      result.value &&
      result.value.length
    ) {
      buffer =
        concatBytes(
          buffer,
          result.value
        );
    }

    const index =
      indexOfBytes(
        buffer,
        delimiter
      );

    if (
      index !== -1
    ) {
      const headBytes =
        buffer.slice(
          0,
          index
        );

      const remaining =
        buffer.slice(
          index +
            delimiter.length
        );

      const text =
        new TextDecoder().decode(
          headBytes
        );

      const lines =
        text.split(
          "\r\n"
        );

      const statusLine =
        lines.shift() ||
        "";

      const headers =
        [];

      for (
        const line
          of lines
      ) {
        const separator =
          line.indexOf(
            ":"
          );

        if (
          separator <= 0
        ) {
          continue;
        }

        const name =
          line.slice(
            0,
            separator
          ).trim();

        const value =
          line.slice(
            separator + 1
          ).trim();

        headers.push([
          name,
          value,
        ]);
      }

      return {
        statusLine,
        headers,
        initialBody:
          remaining,
      };
    }
  }

  throw new Error(
    "Upstream HTTP headers are too large."
  );
}

// ============================================================
// SOCKET BODY STREAM
// ============================================================

function createSocketBodyStream(
  reader,
  socket,
  mode,
  length = 0
) {
  let buffer =
    new Uint8Array(0);

  let remaining =
    length;

  let state =
    mode === "chunked"
      ? "size"
      : mode === "length"
        ? "length"
        : mode === "none"
          ? "none"
          : "close";

  let closed =
    false;

  async function closeSocket() {
    if (closed) {
      return;
    }

    closed = true;

    try {
      reader.releaseLock();
    } catch (_) {}

    try {
      socket.close();
    } catch (_) {}
  }

  async function readMore() {
    const result =
      await reader.read();

    if (
      result.done
    ) {
      return false;
    }

    if (
      result.value &&
      result.value.length
    ) {
      buffer =
        concatBytes(
          buffer,
          result.value
        );
    }

    return true;
  }

  async function readLine() {
    const delimiter =
      new Uint8Array([
        13,
        10,
      ]);

    while (true) {
      const index =
        indexOfBytes(
          buffer,
          delimiter
        );

      if (
        index !== -1
      ) {
        const lineBytes =
          buffer.slice(
            0,
            index
          );

        buffer =
          buffer.slice(
            index +
              2
          );

        return new TextDecoder()
          .decode(
            lineBytes
          );
      }

      const more =
        await readMore();

      if (!more) {
        throw new Error(
          "Unexpected end of HTTP body."
        );
      }
    }
  }

  async function readExactly(
    count
  ) {
    while (
      buffer.length <
      count
    ) {
      const more =
        await readMore();

      if (!more) {
        throw new Error(
          "Unexpected end of HTTP body."
        );
      }
    }

    const output =
      buffer.slice(
        0,
        count
      );

    buffer =
      buffer.slice(
        count
      );

    return output;
  }

  const stream =
    new ReadableStream({
      async pull(controller) {
        try {
          /*
           * No body.
           */
          if (
            state === "none"
          ) {
            controller.close();
            await closeSocket();
            return;
          }

          /*
           * Content-Length body.
           */
          if (
            state === "length"
          ) {
            if (
              remaining <= 0
            ) {
              controller.close();
              await closeSocket();
              return;
            }

            if (
              buffer.length === 0
            ) {
              const more =
                await readMore();

              if (!more) {
                controller.close();
                await closeSocket();
                return;
              }
            }

            const count =
              Math.min(
                remaining,
                buffer.length
              );

            const chunk =
              buffer.slice(
                0,
                count
              );

            buffer =
              buffer.slice(
                count
              );

            remaining -=
              count;

            controller.enqueue(
              chunk
            );

            if (
              remaining <= 0
            ) {
              controller.close();
              await closeSocket();
            }

            return;
          }

          /*
           * Chunked Transfer-Encoding.
           */
          if (
            state ===
            "chunked"
          ) {
            while (true) {
              /*
               * Read chunk size.
               */
              if (
                state ===
                "size"
              ) {
                const line =
                  await readLine();

                const sizeText =
                  line
                    .split(";")[0]
                    .trim();

                const size =
                  parseInt(
                    sizeText,
                    16
                  );

                if (
                  !Number.isFinite(
                    size
                  ) ||
                  size < 0
                ) {
                  throw new Error(
                    "Invalid chunk size."
                  );
                }

                if (
                  size === 0
                ) {
                  /*
                   * Consume trailers until
                   * the empty line.
                   */
                  while (true) {
                    const trailer =
                      await readLine();

                    if (
                      trailer === ""
                    ) {
                      break;
                    }
                  }

                  controller.close();
                  await closeSocket();
                  return;
                }

                remaining =
                  size;

                state =
                  "chunk-data";
              }

              /*
               * Read chunk data.
               */
              if (
                state ===
                "chunk-data"
              ) {
                const chunk =
                  await readExactly(
                    remaining
                  );

                remaining = 0;

                state =
                  "chunk-crlf";

                controller.enqueue(
                  chunk
                );

                return;
              }

              /*
               * Consume CRLF after chunk.
               */
              if (
                state ===
                "chunk-crlf"
              ) {
                const crlf =
                  await readExactly(
                    2
                  );

                if (
                  crlf[0] !==
                    13 ||
                  crlf[1] !==
                    10
                ) {
                  throw new Error(
                    "Invalid chunk terminator."
                  );
                }

                state =
                  "size";

                continue;
              }
            }
          }

          /*
           * Connection-close body.
           */
          if (
            state === "close"
          ) {
            if (
              buffer.length
            ) {
              const chunk =
                buffer;

              buffer =
                new Uint8Array(0);

              controller.enqueue(
                chunk
              );

              return;
            }

            const result =
              await reader.read();

            if (
              result.done
            ) {
              controller.close();
              await closeSocket();
              return;
            }

            if (
              result.value &&
              result.value.length
            ) {
              controller.enqueue(
                result.value
              );
            }

            return;
          }
        } catch (error) {
          console.error(
            "[TCP BODY ERROR]",
            error?.message ||
              String(error)
          );

          controller.error(
            error
          );

          await closeSocket();
        }
      },

      async cancel() {
        await closeSocket();
      },
    });

  return stream;
}

// ============================================================
// HTTP HEADER HELPERS
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
      "upgrade" ||
    value ===
      "proxy-connection"
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

  headers.set(
    "User-Agent",
    request.headers.get(
      "User-Agent"
    ) ||
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0"
  );

  headers.set(
    "Accept",
    request.headers.get(
      "Accept"
    ) ||
      "*/*"
  );

  headers.set(
    "Accept-Language",
    request.headers.get(
      "Accept-Language"
    ) ||
      "ar,en;q=0.9"
  );

  headers.set(
    "Referer",
    getOrigin(
      targetUrl
    ) + "/"
  );

  const range =
    request.headers.get(
      "Range"
    );

  if (range) {
    headers.set(
      "Range",
      range
    );
  }

  /*
   * Preserve authorization if the
   * player sends one.
   */
  const authorization =
    request.headers.get(
      "Authorization"
    );

  if (authorization) {
    headers.set(
      "Authorization",
      authorization
    );
  }

  return headers;
}

// ============================================================
// M3U8 DETECTION
// ============================================================

function isM3u8Response(
  response,
  finalUrl
) {
  const type =
    (
      response.headers.get(
        "Content-Type"
      ) || ""
    ).toLowerCase();

  return (
    type.includes(
      "mpegurl"
    ) ||
    type.includes(
      "vnd.apple.mpegurl"
    ) ||
    /\.m3u8(?:$|\?)/i.test(
      finalUrl
    )
  );
}

// ============================================================
// BINARY RESPONSE
// ============================================================

function buildBinaryResponse(
  response,
  cors
) {
  const headers =
    copyResponseHeaders(
      response,
      cors
    );

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
// RESPONSE HEADERS
// ============================================================

function copyResponseHeaders(
  source,
  cors
) {
  const headers =
    new Headers(cors);

  const names = [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
    "Content-Disposition",
  ];

  for (
    const name of names
  ) {
    const value =
      source.headers.get(
        name
      );

    if (
      value !== null
    ) {
      headers.set(
        name,
        value
      );
    }
  }

  /*
   * Never cache live stream data.
   */
  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  return headers;
}

// ============================================================
// UPSTREAM ERROR
// ============================================================

async function upstreamErrorResponse(
  response,
  cors
) {
  let body = "";

  try {
    body =
      await response.text();
  } catch (_) {
    body = "";
  }

  return new Response(
    body ||
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

// ============================================================
// DEBUG
// ============================================================

async function handleDebug(
  request,
  url,
  cors
) {
  const target =
    url.searchParams.get(
      "url"
    )?.trim();

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
      parsed.hostname
        .toLowerCase();

    if (
      !ALLOWED_STREAM_HOSTS.has(
        hostname
      ) &&
      !isPublicIpv4Address(
        hostname
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
    new Headers();

  headers.set(
    "User-Agent",
    request.headers.get(
      "User-Agent"
    ) ||
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0"
  );

  headers.set(
    "Accept",
    "*/*"
  );

  headers.set(
    "Referer",
    getOrigin(target) +
      "/"
  );

  const range =
    request.headers.get(
      "Range"
    );

  if (range) {
    headers.set(
      "Range",
      range
    );
  }

  try {
    const result =
      await followRedirects(
        parsed.href,
        "GET",
        headers
      );

    const response =
      result.response;

    let bodyPreview =
      "";

    const contentType =
      response.headers.get(
        "Content-Type"
      ) || "";

    if (
      !response.ok &&
      contentType
        .toLowerCase()
        .includes("text")
    ) {
      try {
        const text =
          await response.text();

        bodyPreview =
          safeBodyPreview(
            text
          );
      } catch (_) {}
    }

    return json(
      {
        status:
          response.status,

        statusText:
          response.statusText,

        finalUrl:
          redactUrl(
            result.finalUrl
          ),

        finalHost:
          safeHost(
            result.finalUrl
          ),

        finalProtocol:
          getProtocol(
            result.finalUrl
          ),

        redirected:
          result.hops > 0,

        hops:
          result.hops,

        contentType,

        contentLength:
          response.headers.get(
            "Content-Length"
          ),

        server:
          response.headers.get(
            "Server"
          ),

        bodyPreview,
      },
      200,
      cors
    );
  } catch (error) {
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
// CANCEL RESPONSE BODY
// ============================================================

async function cancelResponseBody(
  response
) {
  try {
    if (
      response &&
      response.body
    ) {
      await response.body.cancel();
    }
  } catch (_) {}
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
          "no-store, no-cache, must-revalidate",
      },
    }
  );
}

// ============================================================
// URL HELPERS
// ============================================================

function getOrigin(
  value
) {
  try {
    const u =
      new URL(value);

    return `${u.protocol}//${u.host}`;
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
    ).host;
  } catch (_) {
    return "";
  }
}

function getProtocol(
  value
) {
  try {
    return new URL(
      value
    ).protocol;
  } catch (_) {
    return "";
  }
}

// ============================================================
// IPv4 VALIDATION
// ============================================================

function isIpv4Address(
  hostname
) {
  if (!hostname) {
    return false;
  }

  const parts =
    String(
      hostname
    ).split(".");

  if (
    parts.length !== 4
  ) {
    return false;
  }

  return parts.every(
    (part) => {
      if (
        part === "" ||
        !/^\d+$/.test(
          part
        )
      ) {
        return false;
      }

      const number =
        Number(part);

      return (
        number >= 0 &&
        number <= 255
      );
    }
  );
}

// ============================================================
// PUBLIC IPv4 VALIDATION
// ============================================================

function isPublicIpv4Address(
  hostname
) {
  if (
    !isIpv4Address(
      hostname
    )
  ) {
    return false;
  }

  const [
    a,
    b,
    c,
    d,
  ] =
    hostname
      .split(".")
      .map(Number);

  /*
   * 0.0.0.0/8
   */
  if (
    a === 0
  ) {
    return false;
  }

  /*
   * 10.0.0.0/8
   */
  if (
    a === 10
  ) {
    return false;
  }

  /*
   * 100.64.0.0/10
   */
  if (
    a === 100 &&
    b >= 64 &&
    b <= 127
  ) {
    return false;
  }

  /*
   * 127.0.0.0/8
   */
  if (
    a === 127
  ) {
    return false;
  }

  /*
   * 169.254.0.0/16
   */
  if (
    a === 169 &&
    b === 254
  ) {
    return false;
  }

  /*
   * 172.16.0.0/12
   */
  if (
    a === 172 &&
    b >= 16 &&
    b <= 31
  ) {
    return false;
  }

  /*
   * 192.0.0.0/24
   */
  if (
    a === 192 &&
    b === 0 &&
    c === 0
  ) {
    return false;
  }

  /*
   * 192.0.2.0/24 TEST-NET
   */
  if (
    a === 192 &&
    b === 0 &&
    c === 2
  ) {
    return false;
  }

  /*
   * 192.168.0.0/16
   */
  if (
    a === 192 &&
    b === 168
  ) {
    return false;
  }

  /*
   * 192.88.99.0/24
   */
  if (
    a === 192 &&
    b === 88 &&
    c === 99
  ) {
    return false;
  }

  /*
   * 198.18.0.0/15
   */
  if (
    a === 198 &&
    (b === 18 ||
      b === 19)
  ) {
    return false;
  }

  /*
   * 198.51.100.0/24 TEST-NET
   */
  if (
    a === 198 &&
    b === 51 &&
    c === 100
  ) {
    return false;
  }

  /*
   * 203.0.113.0/24 TEST-NET
   */
  if (
    a === 203 &&
    b === 0 &&
    c === 113
  ) {
    return false;
  }

  /*
   * Multicast / reserved:
   * 224.0.0.0/4 and above.
   */
  if (
    a >= 224
  ) {
    return false;
  }

  return true;
}

// ============================================================
// URL REDACTION
// ============================================================

function redactUrl(
  value
) {
  try {
    const u =
      new URL(value);

    const sensitiveNames = [
      "username",
      "user",
      "password",
      "pass",
      "token",
      "auth",
      "key",
      "api_key",
      "apikey",
    ];

    for (
      const name
        of sensitiveNames
    ) {
      if (
        u.searchParams.has(
          name
        )
      ) {
        u.searchParams.set(
          name,
          "***"
        );
      }
    }

    /*
     * Hide unusually long path
     * components, which commonly
     * contain temporary auth tokens.
     */
    const pathParts =
      u.pathname.split(
        "/"
      );

    u.pathname =
      pathParts
        .map(
          (part) => {
            if (
              part.length >
              80
            ) {
              return (
                part.slice(
                  0,
                  12
                ) +
                "...REDACTED..."
              );
            }

            return part;
          }
        )
        .join("/");

    return u.href;
  } catch (_) {
    return "";
  }
}

// ============================================================
// BODY PREVIEW
// ============================================================

function safeBodyPreview(
  value,
  maxLength = 500
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  let text =
    String(value)
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (
    text.length >
    maxLength
  ) {
    text =
      text.slice(
        0,
        maxLength
      ) + "...";
  }

  return text;
}

// ============================================================
// BYTE HELPERS
// ============================================================

function concatBytes(
  a,
  b
) {
  const output =
    new Uint8Array(
      a.length +
        b.length
    );

  output.set(a, 0);
  output.set(
    b,
    a.length
  );

  return output;
}

function indexOfBytes(
  source,
  target
) {
  if (
    target.length === 0
  ) {
    return 0;
  }

  if (
    source.length <
    target.length
  ) {
    return -1;
  }

  outer:
  for (
    let i = 0;
    i <=
      source.length -
        target.length;
    i++
  ) {
    for (
      let j = 0;
      j < target.length;
      j++
    ) {
      if (
        source[i + j] !==
        target[j]
      ) {
        continue outer;
      }
    }

    return i;
  }

  return -1;
}

// ============================================================
// END
// ============================================================
