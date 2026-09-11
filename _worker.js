import { connect } from "cloudflare:sockets";

const ALLOWED_HOSTS = new Set([
  "barqtv.website",
  "barqtvclg.shop"
]);

const SOCKET_HEADER_TIMEOUT_MS = 10000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    console.log("[ROUTER]", {
      method: request.method,
      pathname: url.pathname,
      search: url.search
    });

    try {
      if (url.pathname === "/api") {
        return await handleApi(request);
      }

      if (url.pathname === "/stream") {
        return await handleStream(request);
      }

      if (url.pathname === "/test") {
        return new Response(
          JSON.stringify({
            ok: true,
            worker: "raxson-player",
            timestamp: Date.now()
          }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8"
            }
          }
        );
      }

      if (url.pathname === "/debug") {
        return new Response(
          JSON.stringify({
            ok: true,
            pathname: url.pathname,
            timestamp: Date.now()
          }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8"
            }
          }
        );
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error("[WORKER ERROR]", {
        name: error?.name,
        message: error?.message,
        stack: error?.stack
      });

      return new Response("Worker error", {
        status: 500
      });
    }
  }
};


/* =========================================================
   API
========================================================= */

async function handleApi(request) {
  const requestUrl = new URL(request.url);

  const action = requestUrl.searchParams.get("action") || "";

  const upstream = new URL("http://barqtv.website/player_api.php");

  for (const [key, value] of requestUrl.searchParams.entries()) {
    if (key !== "action") {
      upstream.searchParams.set(key, value);
    }
  }

  console.log("[API]", {
    action,
    url: upstream.toString()
  });

  const response = await fetch(upstream.toString(), {
    method: request.method,
    headers: copySafeHeaders(request.headers),
    redirect: "follow"
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}


/* =========================================================
   STREAM ROUTER
========================================================= */

async function handleStream(request) {
  const requestUrl = new URL(request.url);
  const source = requestUrl.searchParams.get("url");

  if (!source) {
    return new Response("Missing url", {
      status: 400
    });
  }

  let sourceUrl;

  try {
    sourceUrl = new URL(source);
  } catch {
    return new Response("Invalid url", {
      status: 400
    });
  }

  if (
    sourceUrl.protocol !== "http:" &&
    sourceUrl.protocol !== "https:"
  ) {
    return new Response("Invalid protocol", {
      status: 400
    });
  }

  const hostname = sourceUrl.hostname.toLowerCase();

  if (!ALLOWED_HOSTS.has(hostname)) {
    console.warn("[BLOCKED HOST]", hostname);

    return new Response("Host not allowed", {
      status: 403
    });
  }

  const pathname = sourceUrl.pathname;

  /*
   * LIVE IS DISABLED
   */
  if (
    pathname.toLowerCase().startsWith("/live/")
  ) {
    console.log("[LIVE BLOCKED]", pathname);

    return new Response("Live streaming disabled", {
      status: 403
    });
  }

  const isMovie = pathname.toLowerCase().startsWith("/movie/");
  const isSeries = pathname.toLowerCase().startsWith("/series/");

  if (!isMovie && !isSeries) {
    console.warn("[VOD BLOCKED PATH]", pathname);

    return new Response("Only movie and series are allowed", {
      status: 403
    });
  }

  return await proxyVod(request, sourceUrl, isMovie ? "movie" : "series");
}


/* =========================================================
   VOD PROXY
========================================================= */

async function proxyVod(request, sourceUrl, type) {
  const range = request.headers.get("Range");

  console.log("[VOD PROXY START]", {
    type,
    host: sourceUrl.hostname,
    path: sourceUrl.pathname,
    range
  });

  /*
   * First request:
   * We deliberately stop at the provider's redirect.
   */
  const firstResponse = await fetch(sourceUrl.toString(), {
    method: "GET",
    headers: buildUpstreamHeaders(request, sourceUrl),
    redirect: "manual"
  });

  const location = firstResponse.headers.get("Location");

  console.log("[VOD FIRST RESPONSE]", {
    status: firstResponse.status,
    location,
    contentType: firstResponse.headers.get("content-type")
  });

  /*
   * Direct VOD response.
   */
  if (firstResponse.status >= 200 && firstResponse.status < 300) {
    console.log("[VOD DIRECT RESPONSE]", {
      status: firstResponse.status
    });

    return makeBrowserResponse(firstResponse);
  }

  /*
   * Redirect.
   */
  if (
    firstResponse.status >= 300 &&
    firstResponse.status < 400 &&
    location
  ) {
    const redirectUrl = new URL(
      location,
      sourceUrl.toString()
    );

    console.log("[VOD REDIRECT]", {
      from: sourceUrl.toString(),
      to: redirectUrl.toString()
    });

    /*
     * Redirect to another hostname.
     */
    if (!isIpAddress(redirectUrl.hostname)) {
      return await fetchHostnameRedirect(
        request,
        redirectUrl
      );
    }

    /*
     * Redirect to IP.
     */
    const port =
      redirectUrl.port ||
      (redirectUrl.protocol === "https:" ? "443" : "80");

    console.log("[VOD IP REDIRECT]", {
      ip: redirectUrl.hostname,
      port,
      protocol: redirectUrl.protocol,
      path: redirectUrl.pathname + redirectUrl.search
    });

    return await proxyIpWithSocket(
      request,
      redirectUrl
    );
  }

  console.error("[VOD UPSTREAM ERROR]", {
    status: firstResponse.status
  });

  return new Response(
    `Upstream returned ${firstResponse.status}`,
    {
      status: 502
    }
  );
}


/* =========================================================
   HOSTNAME REDIRECT
========================================================= */

async function fetchHostnameRedirect(request, redirectUrl) {
  console.log("[HOST REDIRECT FETCH]", {
    url: redirectUrl.toString()
  });

  const response = await fetch(redirectUrl.toString(), {
    method: "GET",
    headers: buildUpstreamHeaders(request, redirectUrl),
    redirect: "follow"
  });

  console.log("[HOST REDIRECT RESPONSE]", {
    status: response.status,
    contentType: response.headers.get("content-type")
  });

  return makeBrowserResponse(response);
}


/* =========================================================
   IP SOCKET PROXY
========================================================= */

async function proxyIpWithSocket(request, redirectUrl) {
  const ip = redirectUrl.hostname;

  const port = Number(
    redirectUrl.port ||
    (redirectUrl.protocol === "https:" ? 443 : 80)
  );

  const path =
    redirectUrl.pathname +
    redirectUrl.search;

  console.log("[SOCKET CONNECT]", {
    ip,
    port,
    path
  });

  let socket;

  try {
    socket = connect({
      hostname: ip,
      port,
      secureTransport:
        redirectUrl.protocol === "https:"
          ? "on"
          : "off",
      allowHalfOpen: true
    });

    await socket.opened;

    console.log("[SOCKET CONNECTED]", {
      ip,
      port
    });

    const writer = socket.writable.getWriter();

    const rawRequest = buildRawHttpRequest(
      request,
      redirectUrl
    );

    console.log("[SOCKET HTTP REQUEST]", {
      host: ip,
      path,
      range: request.headers.get("Range"),
      requestBytes: new TextEncoder().encode(rawRequest).byteLength
    });

    await writer.write(
      new TextEncoder().encode(rawRequest)
    );

    console.log("[SOCKET WRITE OK]");

    /*
     * IMPORTANT:
     *
     * Do NOT close the writer here.
     *
     * We want to test the upstream server while the
     * TCP connection remains fully open.
     */
    writer.releaseLock();

    console.log("[SOCKET WRITE RELEASED]");

    const reader = socket.readable.getReader();

    console.log("[SOCKET WAITING RESPONSE]");

    const headerResult = await readHttpHeadersWithTimeout(
      reader,
      SOCKET_HEADER_TIMEOUT_MS
    );

    if (!headerResult) {
      console.error("[SOCKET NO RESPONSE]", {
        ip,
        port,
        message:
          "Socket ended or timed out before HTTP headers were received"
      });

      try {
        reader.releaseLock();
      } catch {}

      try {
        socket.close();
      } catch {}

      return new Response(
        "Upstream closed connection before HTTP response",
        {
          status: 502
        }
      );
    }

    const {
      headerText,
      initialBody
    } = headerResult;

    console.log("[SOCKET HEADERS RECEIVED]", {
      ip,
      port,
      headers: headerText
    });

    const parsed = parseHttpHeaders(headerText);

    console.log("[SOCKET RESPONSE]", {
      status: parsed.status,
      contentType: parsed.headers.get("content-type"),
      contentLength: parsed.headers.get("content-length"),
      transferEncoding:
        parsed.headers.get("transfer-encoding"),
      acceptRanges:
        parsed.headers.get("accept-ranges")
    });

    /*
     * Handle redirect from the IP endpoint too.
     */
    if (
      parsed.status >= 300 &&
      parsed.status < 400
    ) {
      const location =
        parsed.headers.get("location");

      try {
        reader.releaseLock();
      } catch {}

      try {
        socket.close();
      } catch {}

      if (!location) {
        return new Response(
          "Upstream redirect without Location",
          {
            status: 502
          }
        );
      }

      const nextUrl = new URL(
        location,
        redirectUrl.toString()
      );

      console.log("[SOCKET SECOND REDIRECT]", {
        location: nextUrl.toString()
      });

      if (isIpAddress(nextUrl.hostname)) {
        return await proxyIpWithSocket(
          request,
          nextUrl
        );
      }

      return await fetchHostnameRedirect(
        request,
        nextUrl
      );
    }

    /*
     * HEAD/error response.
     */
    if (
      request.method === "HEAD" ||
      parsed.status < 200 ||
      parsed.status >= 600
    ) {
      try {
        reader.releaseLock();
      } catch {}

      try {
        socket.close();
      } catch {}

      return new Response(null, {
        status: parsed.status,
        headers: filterResponseHeaders(
          parsed.headers
        )
      });
    }

    /*
     * Chunked response.
     */
    const transferEncoding =
      parsed.headers
        .get("transfer-encoding")
        ?.toLowerCase() || "";

    if (
      transferEncoding.includes("chunked")
    ) {
      const body = createChunkedSocketStream(
        socket,
        reader,
        initialBody
      );

      return new Response(body, {
        status: parsed.status,
        headers: filterResponseHeaders(
          parsed.headers
        )
      });
    }

    /*
     * Content-Length response.
     *
     * This is important because Connection: keep-alive
     * means the server may NOT close the TCP connection
     * after sending the MP4.
     */
    const contentLengthHeader =
      parsed.headers.get("content-length");

    if (contentLengthHeader !== null) {
      const contentLength =
        Number(contentLengthHeader);

      if (
        Number.isFinite(contentLength) &&
        contentLength >= 0
      ) {
        const body =
          createLengthSocketStream(
            socket,
            reader,
            initialBody,
            contentLength
          );

        return new Response(body, {
          status: parsed.status,
          headers: filterResponseHeaders(
            parsed.headers
          )
        });
      }
    }

    /*
     * No Content-Length.
     * Fall back to reading until EOF.
     */
    const body =
      createUntilCloseSocketStream(
        socket,
        reader,
        initialBody
      );

    return new Response(body, {
      status: parsed.status,
      headers: filterResponseHeaders(
        parsed.headers
      )
    });

  } catch (error) {
    console.error("[SOCKET ERROR]", {
      ip,
      port,
      name: error?.name,
      message: error?.message,
      stack: error?.stack
    });

    try {
      socket?.close();
    } catch {}

    return new Response(
      "Socket upstream error",
      {
        status: 502
      }
    );
  }
}


/* =========================================================
   RAW HTTP REQUEST
========================================================= */

function buildRawHttpRequest(request, redirectUrl) {
  const lines = [];

  lines.push(
    `GET ${redirectUrl.pathname}${redirectUrl.search} HTTP/1.1`
  );

  /*
   * Keep Host equal to the actual redirect IP.
   * This matches normal browser behavior when the
   * browser follows http://IP/...
   */
  lines.push(
    `Host: ${redirectUrl.hostname}${
      redirectUrl.port
        ? `:${redirectUrl.port}`
        : ""
    }`
  );

  /*
   * Important change:
   * Do not ask the server to close immediately.
   */
  lines.push("Connection: keep-alive");

  lines.push(
    "Accept: video/mp4,video/*,*/*;q=0.8"
  );

  /*
   * Avoid gzip/br transformations for video.
   */
  lines.push(
    "Accept-Encoding: identity"
  );

  const language =
    request.headers.get("Accept-Language");

  if (language) {
    lines.push(
      `Accept-Language: ${language}`
    );
  }

  const userAgent =
    request.headers.get("User-Agent");

  if (userAgent) {
    lines.push(
      `User-Agent: ${userAgent}`
    );
  } else {
    lines.push(
      "User-Agent: Mozilla/5.0"
    );
  }

  /*
   * Preserve the original referring page.
   */
  const referer =
    request.headers.get("Referer");

  if (referer) {
    lines.push(`Referer: ${referer}`);
  }

  /*
   * Preserve video byte-range request.
   */
  const range =
    request.headers.get("Range");

  if (range) {
    lines.push(`Range: ${range}`);
  }

  /*
   * Forward conditional headers when present.
   */
  const ifRange =
    request.headers.get("If-Range");

  if (ifRange) {
    lines.push(`If-Range: ${ifRange}`);
  }

  const ifNoneMatch =
    request.headers.get("If-None-Match");

  if (ifNoneMatch) {
    lines.push(
      `If-None-Match: ${ifNoneMatch}`
    );
  }

  const ifModifiedSince =
    request.headers.get("If-Modified-Since");

  if (ifModifiedSince) {
    lines.push(
      `If-Modified-Since: ${ifModifiedSince}`
    );
  }

  /*
   * End HTTP headers.
   */
  lines.push("");

  lines.push("");

  return lines.join("\r\n");
}


/* =========================================================
   HTTP HEADER READER
========================================================= */

async function readHttpHeadersWithTimeout(
  reader,
  timeoutMs
) {
  const chunks = [];
  let total = 0;

  while (true) {
    let result;

    try {
      result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `Timeout waiting for upstream HTTP headers after ${timeoutMs}ms`
              )
            );
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      console.error(
        "[SOCKET HEADER READ ERROR]",
        {
          name: error?.name,
          message: error?.message
        }
      );

      return null;
    }

    if (result.done) {
      return null;
    }

    if (result.value) {
      chunks.push(result.value);
      total += result.value.byteLength;
    }

    const combined =
      combineUint8Arrays(chunks, total);

    const marker =
      findHeaderEnd(combined);

    if (marker !== -1) {
      const headerBytes =
        combined.slice(
          0,
          marker
        );

      const bodyBytes =
        combined.slice(
          marker + 4
        );

      return {
        headerText:
          new TextDecoder().decode(
            headerBytes
          ),
        initialBody: bodyBytes
      };
    }

    /*
     * Prevent unlimited header growth.
     */
    if (total > 1024 * 1024) {
      console.error(
        "[SOCKET HEADER TOO LARGE]"
      );

      return null;
    }
  }
}


/* =========================================================
   HTTP HEADER PARSER
========================================================= */

function parseHttpHeaders(headerText) {
  const lines =
    headerText.split("\r\n");

  const statusLine =
    lines.shift() || "";

  const statusMatch =
    statusLine.match(
      /^HTTP\/\d(?:\.\d)?\s+(\d{3})/
    );

  const status =
    statusMatch
      ? Number(statusMatch[1])
      : 502;

  const headers =
    new Headers();

  for (const line of lines) {
    const index =
      line.indexOf(":");

    if (index <= 0) {
      continue;
    }

    const name =
      line.slice(0, index).trim();

    const value =
      line.slice(index + 1).trim();

    try {
      headers.append(name, value);
    } catch {}
  }

  return {
    status,
    headers
  };
}


/* =========================================================
   CONTENT-LENGTH STREAM
========================================================= */

function createLengthSocketStream(
  socket,
  reader,
  initialBody,
  contentLength
) {
  let initialOffset = 0;
  let remaining =
    contentLength;

  return new ReadableStream({
    async pull(controller) {
      try {
        if (remaining <= 0) {
          controller.close();

          try {
            reader.releaseLock();
          } catch {}

          try {
            socket.close();
          } catch {}

          return;
        }

        /*
         * First consume bytes already received
         * together with the HTTP headers.
         */
        if (
          initialBody &&
          initialOffset <
            initialBody.byteLength
        ) {
          const available =
            initialBody.byteLength -
            initialOffset;

          const take =
            Math.min(
              available,
              remaining
            );

          controller.enqueue(
            initialBody.slice(
              initialOffset,
              initialOffset + take
            )
          );

          initialOffset += take;
          remaining -= take;

          if (remaining <= 0) {
            controller.close();

            try {
              reader.releaseLock();
            } catch {}

            try {
              socket.close();
            } catch {}

            return;
          }

          return;
        }

        const result =
          await reader.read();

        if (result.done) {
          controller.close();

          try {
            reader.releaseLock();
          } catch {}

          try {
            socket.close();
          } catch {}

          return;
        }

        const value =
          result.value;

        if (!value || value.byteLength === 0) {
          return;
        }

        const take =
          Math.min(
            value.byteLength,
            remaining
          );

        controller.enqueue(
          value.slice(0, take)
        );

        remaining -= take;

        /*
         * If upstream gave us more than Content-Length,
         * ignore anything beyond the declared body.
         */
        if (remaining <= 0) {
          controller.close();

          try {
            reader.releaseLock();
          } catch {}

          try {
            socket.close();
          } catch {}
        }

      } catch (error) {
        console.error(
          "[SOCKET CONTENT-LENGTH STREAM ERROR]",
          {
            message: error?.message
          }
        );

        controller.error(error);

        try {
          reader.releaseLock();
        } catch {}

        try {
          socket.close();
        } catch {}
      }
    },

    async cancel() {
      try {
        reader.releaseLock();
      } catch {}

      try {
        socket.close();
      } catch {}
    }
  });
}


/* =========================================================
   READ UNTIL SOCKET CLOSE
========================================================= */

function createUntilCloseSocketStream(
  socket,
  reader,
  initialBody
) {
  let sentInitial = false;

  return new ReadableStream({
    async pull(controller) {
      try {
        if (
          !sentInitial &&
          initialBody &&
          initialBody.byteLength > 0
        ) {
          sentInitial = true;

          controller.enqueue(
            initialBody
          );

          return;
        }

        sentInitial = true;

        const result =
          await reader.read();

        if (result.done) {
          controller.close();

          try {
            reader.releaseLock();
          } catch {}

          try {
            socket.close();
          } catch {}

          return;
        }

        if (
          result.value &&
          result.value.byteLength > 0
        ) {
          controller.enqueue(
            result.value
          );
        }

      } catch (error) {
        console.error(
          "[SOCKET STREAM ERROR]",
          {
            message: error?.message
          }
        );

        controller.error(error);

        try {
          reader.releaseLock();
        } catch {}

        try {
          socket.close();
        } catch {}
      }
    },

    async cancel() {
      try {
        reader.releaseLock();
      } catch {}

      try {
        socket.close();
      } catch {}
    }
  });
}


/* =========================================================
   CHUNKED STREAM
========================================================= */

function createChunkedSocketStream(
  socket,
  reader,
  initialBody
) {
  let buffer =
    initialBody
      ? new Uint8Array(initialBody)
      : new Uint8Array(0);

  let finished = false;

  function appendBytes(a, b) {
    const result =
      new Uint8Array(
        a.byteLength +
        b.byteLength
      );

    result.set(a, 0);
    result.set(b, a.byteLength);

    return result;
  }

  function findCRLF(bytes, start) {
    for (
      let i = start;
      i + 1 < bytes.length;
      i++
    ) {
      if (
        bytes[i] === 13 &&
        bytes[i + 1] === 10
      ) {
        return i;
      }
    }

    return -1;
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        while (!finished) {
          const lineEnd =
            findCRLF(buffer, 0);

          if (lineEnd === -1) {
            const result =
              await reader.read();

            if (result.done) {
              finished = true;
              controller.close();

              try {
                reader.releaseLock();
              } catch {}

              try {
                socket.close();
              } catch {}

              return;
            }

            if (result.value) {
              buffer =
                appendBytes(
                  buffer,
                  result.value
                );
            }

            continue;
          }

          const sizeText =
            new TextDecoder()
              .decode(
                buffer.slice(
                  0,
                  lineEnd
                )
              )
              .split(";")[0]
              .trim();

          const chunkSize =
            parseInt(
              sizeText,
              16
            );

          if (
            !Number.isFinite(chunkSize)
          ) {
            throw new Error(
              "Invalid chunk size"
            );
          }

          /*
           * Remove size line + CRLF.
           */
          buffer =
            buffer.slice(
              lineEnd + 2
            );

          /*
           * Zero chunk = end.
           */
          if (chunkSize === 0) {
            finished = true;

            controller.close();

            try {
              reader.releaseLock();
            } catch {}

            try {
              socket.close();
            } catch {}

            return;
          }

          /*
           * Need chunk bytes + trailing CRLF.
           */
          while (
            buffer.byteLength <
            chunkSize + 2
          ) {
            const result =
              await reader.read();

            if (result.done) {
              throw new Error(
                "Socket ended inside chunk"
              );
            }

            if (result.value) {
              buffer =
                appendBytes(
                  buffer,
                  result.value
                );
            }
          }

          const chunk =
            buffer.slice(
              0,
              chunkSize
            );

          buffer =
            buffer.slice(
              chunkSize + 2
            );

          controller.enqueue(chunk);

          return;
        }

      } catch (error) {
        console.error(
          "[SOCKET CHUNKED STREAM ERROR]",
          {
            message: error?.message
          }
        );

        controller.error(error);

        try {
          reader.releaseLock();
        } catch {}

        try {
          socket.close();
        } catch {}
      }
    },

    async cancel() {
      try {
        reader.releaseLock();
      } catch {}

      try {
        socket.close();
      } catch {}
    }
  });
}


/* =========================================================
   RESPONSE HEADERS
========================================================= */

function filterResponseHeaders(headers) {
  const output =
    new Headers();

  const allowed = [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "content-disposition",
    "etag",
    "expires",
    "last-modified"
  ];

  for (const name of allowed) {
    const value =
      headers.get(name);

    if (value !== null) {
      output.set(name, value);
    }
  }

  /*
   * Required for browser video playback.
   */
  output.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  output.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Type"
  );

  return output;
}


/* =========================================================
   BROWSER RESPONSE
========================================================= */

function makeBrowserResponse(response) {
  const headers =
    new Headers();

  for (const [key, value] of response.headers) {
    headers.set(key, value);
  }

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Type"
  );

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers
    }
  );
}


/* =========================================================
   UPSTREAM REQUEST HEADERS
========================================================= */

function buildUpstreamHeaders(
  request,
  sourceUrl
) {
  const headers =
    new Headers();

  headers.set(
    "Accept",
    "video/mp4,video/*,*/*;q=0.8"
  );

  headers.set(
    "Accept-Encoding",
    "identity"
  );

  const userAgent =
    request.headers.get("User-Agent");

  if (userAgent) {
    headers.set(
      "User-Agent",
      userAgent
    );
  }

  const language =
    request.headers.get(
      "Accept-Language"
    );

  if (language) {
    headers.set(
      "Accept-Language",
      language
    );
  }

  const referer =
    request.headers.get("Referer");

  if (referer) {
    headers.set(
      "Referer",
      referer
    );
  }

  const range =
    request.headers.get("Range");

  if (range) {
    headers.set(
      "Range",
      range
    );
  }

  const ifRange =
    request.headers.get("If-Range");

  if (ifRange) {
    headers.set(
      "If-Range",
      ifRange
    );
  }

  const ifNoneMatch =
    request.headers.get(
      "If-None-Match"
    );

  if (ifNoneMatch) {
    headers.set(
      "If-None-Match",
      ifNoneMatch
    );
  }

  const ifModifiedSince =
    request.headers.get(
      "If-Modified-Since"
    );

  if (ifModifiedSince) {
    headers.set(
      "If-Modified-Since",
      ifModifiedSince
    );
  }

  return headers;
}


/* =========================================================
   SAFE API HEADERS
========================================================= */

function copySafeHeaders(input) {
  const headers =
    new Headers();

  const allowed = [
    "Accept",
    "Accept-Language",
    "User-Agent",
    "Content-Type"
  ];

  for (const name of allowed) {
    const value =
      input.get(name);

    if (value !== null) {
      headers.set(name, value);
    }
  }

  return headers;
}


/* =========================================================
   IP DETECTION
========================================================= */

function isIpAddress(hostname) {
  /*
   * IPv4
   */
  if (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(
      hostname
    )
  ) {
    return true;
  }

  /*
   * Basic IPv6 detection.
   */
  if (hostname.includes(":")) {
    return true;
  }

  return false;
}


/* =========================================================
   BYTE HELPERS
========================================================= */

function findHeaderEnd(bytes) {
  for (
    let i = 0;
    i + 3 < bytes.length;
    i++
  ) {
    if (
      bytes[i] === 13 &&
      bytes[i + 1] === 10 &&
      bytes[i + 2] === 13 &&
      bytes[i + 3] === 10
    ) {
      return i;
    }
  }

  return -1;
}


function combineUint8Arrays(
  chunks,
  total
) {
  const result =
    new Uint8Array(total);

  let offset = 0;

  for (const chunk of chunks) {
    result.set(
      chunk,
      offset
    );

    offset += chunk.byteLength;
  }

  return result;
}
