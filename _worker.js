

import { connect } from "cloudflare:sockets";



export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",

      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Range, Origin, Referer, Accept, If-Range, If-None-Match, If-Modified-Since",

      "Access-Control-Allow-Methods":
        "GET, HEAD, OPTIONS",

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


      // --------------------------------------------------
      // API
      // --------------------------------------------------

      if (url.pathname === "/api") {

        return await handleApi(
          url,
          cors
        );
      }


      // --------------------------------------------------------
      // VOD STREAM
      // --------------------------------------------------------

      if (url.pathname === "/stream") {

        return await handleStream(
          request,
          url,
          cors
        );
      }


      // --------------------------------------------------------
      // TEST
      // --------------------------------------------------------

      if (url.pathname === "/test") {

        return new Response(
          "Worker OK - Raxson FINAL VOD Proxy",
          {
            status: 200,

            headers: {
              ...cors,

              "Content-Type":
                "text/plain; charset=utf-8",
            },
          }
        );
      }


      // --------------------------------------------------------
      // DEBUG
      // --------------------------------------------------------

      if (url.pathname === "/debug") {

        return await handleDebug(
          request,
          url,
          cors
        );
      }


      // --------------------------------------------------------
      // PHASE 1 - LOCAL SUBSCRIPTIONS (isolated, additive only)
      //
      // New paths only. The existing /api and /stream handlers
      // below are untouched.
      // --------------------------------------------------------

      if (url.pathname === "/subscriptions.json") {

        return json(
          {
            error:
              "Not Found",
          },

          404,

          cors
        );
      }


      if (url.pathname === "/api/local-login") {

        return await handleLocalLogin(
          request,
          env,
          cors
        );
      }


      if (url.pathname === "/api/local-logout") {

        return await handleLocalLogout(
          request,
          env,
          cors
        );
      }


      if (url.pathname === "/api/local") {

        return await handleLocalApi(
          request,
          url,
          env,
          cors
        );
      }


      if (url.pathname === "/local/stream") {

        return await handleLocalStream(
          request,
          url,
          env,
          cors
        );
      }


      if (url.pathname === "/local/seg") {

        return await handleLocalSeg(
          request,
          url,
          env,
          cors
        );
      }


      if (url.pathname === "/api/admin/subs") {

        return await handleLocalAdmin(
          request,
          url,
          env,
          cors
        );
      }


      // --------------------------------------------------------
      // STATIC ASSETS
      // --------------------------------------------------------

      if (env.ASSETS) {

        return env.ASSETS.fetch(
          request
        );
      }


      return new Response(
        "Not Found",
        {
          status: 404,
          headers: cors,
        }
      );

    } catch (error) {

      console.error(
        "[WORKER ERROR]",
        {
          message:
            error?.message ||
            String(error),

          stack:
            error?.stack || "",
        }
      );


      return json(
        {
          error:
            "Worker Error",

          details:
            error?.message ||
            String(error),
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

async function handleApi(
  url,
  cors
) {

  const host =
    url.searchParams
      .get("host")
      ?.trim();


  const user =
    url.searchParams
      .get("user")
      ?.trim();


  const pass =
    url.searchParams
      .get("pass")
      ?.trim();


  const action =
    url.searchParams
      .get("action")
      ?.trim();


  const extra =
    url.searchParams.get("extra") ||
    "";


  if (
    !host ||
    !user ||
    !pass ||
    !action
  ) {

    return json(
      {
        error:
          "Missing parameters",
      },

      400,

      cors
    );
  }


  let cleanHost;


  try {

    cleanHost =
      normalizeHost(host);

  } catch (error) {

    return json(
      {
        error:
          "Invalid host",

        details:
          error.message,
      },

      400,

      cors
    );
  }


  const hostUrl =
    new URL(cleanHost);


  if (
    !ALLOWED_HOSTS.has(
      hostUrl.hostname.toLowerCase()
    )
  ) {

    return json(
      {
        error:
          "Host not allowed",

        host:
          hostUrl.hostname,
      },

      403,

      cors
    );
  }


  const apiUrl =
    new URL(
      "/player_api.php",
      cleanHost + "/"
    );


  apiUrl.searchParams.set(
    "username",
    user
  );


  apiUrl.searchParams.set(
    "password",
    pass
  );


  apiUrl.searchParams.set(
    "action",
    action
  );


  appendExtraParams(
    apiUrl,
    extra
  );


  console.log(
    "[API REQUEST]",
    {
      action,

      host:
        apiUrl.hostname,

      pathname:
        apiUrl.pathname,

      query:
        apiUrl.search,
    }
  );


  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () => controller.abort(),
      60000
    );


  try {

    const response =
      await fetch(
        apiUrl.toString(),
        {
          method: "GET",

          redirect: "follow",

          cache: "no-store",

          signal:
            controller.signal,

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
        }
      );


    console.log(
      "[API RESPONSE]",
      {
        action,

        status:
          response.status,

        finalUrl:
          response.url,

        contentType:
          response.headers.get(
            "content-type"
          ) || "",
      }
    );


    const body =
      await response.text();


    return new Response(
      body,
      {
        status:
          response.status,

        headers: {

          ...cors,

          "Content-Type":
            response.headers.get(
              "content-type"
            ) ||
            "application/json; charset=utf-8",

          "Cache-Control":
            "no-cache, no-store, must-revalidate",

          "Pragma":
            "no-cache",
        },
      }
    );


  } catch (error) {

    console.error(
      "[API ERROR]",
      {
        action,

        error:
          error?.message ||
          String(error),
      }
    );


    return json(
      {
        error:
          "API fetch failed",

        details:
          error?.message ||
          String(error),
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

async function handleStream(
  request,
  url,
  cors
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


  let targetUrl;


  try {

    targetUrl =
      new URL(target);

  } catch (_) {

    return json(
      {
        error:
          "Invalid media URL",
      },

      400,

      cors
    );
  }


  // ----------------------------------------------------------
  // Protocol
  // ----------------------------------------------------------

  if (
    targetUrl.protocol !== "http:" &&
    targetUrl.protocol !== "https:"
  ) {

    return json(
      {
        error:
          "Unsupported protocol",
      },

      403,

      cors
    );
  }


  const hostname =
    targetUrl.hostname.toLowerCase();


  // ----------------------------------------------------------
  // Allowed host
  //
  // Normal requests must use an allowed provider hostname.
  // Live HLS segment requests are allowed only when:
  // 1. hls=1 is present
  // 2. target is an IP
  // 3. path starts with /hls/
  // ----------------------------------------------------------

  const isLiveHlsSegment =
    url.searchParams.get("hls") === "1" &&
    isIpAddress(hostname) &&
    /^\/hls(?:\/|$)/i.test(
      targetUrl.pathname
    );


  if (
    !ALLOWED_HOSTS.has(
      hostname
    ) &&
    !isLiveHlsSegment
  ) {

    return json(
      {
        error:
          "Media host not allowed",

        host:
          hostname,
      },

      403,

      cors
    );
  }


  // ----------------------------------------------------------
  // LIVE INTERNAL MEDIA SEGMENTS
  //
  // Rewritten /hls/... URLs point to the provider IP.
  // Only /hls/ paths on an IP are allowed here.
  // ----------------------------------------------------------

    if (
    url.searchParams.get("hls") === "1" &&
    isIpAddress(hostname) &&
    /^\/hls(?:\/|$)/i.test(
      targetUrl.pathname
    )
  ) {

    console.log(
      "[LIVE HLS SEGMENT]",
      {
        ip:
          hostname,

        path:
          targetUrl.pathname,
      }
    );


    return await proxyIpWithSocket(
      request,
      targetUrl,
      cors
    );
  }


    // ----------------------------------------------------------
  // LIVE HLS
  // ----------------------------------------------------------

  if (
    /^\/live(?:\/|$)/i.test(
      targetUrl.pathname
    )
  ) {

    console.log(
      "[LIVE PROXY START]",
      {
        host:
          hostname,

        path:
          targetUrl.pathname,
      }
    );

    return await handleLiveStream(
      request,
      targetUrl,
      cors
    );
  }

  // ----------------------------------------------------------
  // Only movie / series
  // ----------------------------------------------------------

  const isMovie =
    /^\/movie(?:\/|$)/i.test(
      targetUrl.pathname
    );


  const isSeries =
    /^\/series(?:\/|$)/i.test(
      targetUrl.pathname
    );


  if (
    !isMovie &&
    !isSeries
  ) {

    return json(
      {
        error:
          "Only movie and series media are allowed",

        path:
          targetUrl.pathname,
      },

      403,

      cors
    );
  }


  console.log(
    "[VOD PROXY START]",
    {
      type:
        isMovie
          ? "movie"
          : "series",

      host:
        hostname,

      path:
        targetUrl.pathname,

      range:
        request.headers.get(
          "Range"
        ) || "",
    }
  );


  // ----------------------------------------------------------
  // Original provider headers
  // ----------------------------------------------------------

  const upstreamHeaders =
    buildUpstreamHeaders(
      request,
      targetUrl
    );


  try {

    const firstResponse =
      await fetch(
        targetUrl.toString(),
        {
          method:
            request.method === "HEAD"
              ? "HEAD"
              : "GET",

          headers:
            upstreamHeaders,

          redirect:
            "manual",

          cache:
            "no-store",
        }
      );


    console.log(
      "[VOD FIRST RESPONSE]",
      {
        status:
          firstResponse.status,

        location:
          firstResponse.headers.get(
            "location"
          ) || "",

        contentType:
          firstResponse.headers.get(
            "content-type"
          ) || "",
      }
    );


    // --------------------------------------------------------
    // Direct response
    // --------------------------------------------------------

    if (
      firstResponse.status >= 200 &&
      firstResponse.status < 300
    ) {

      return makeBrowserResponse(
        firstResponse,
        request,
        cors
      );
    }


    // --------------------------------------------------------
    // Redirect
    // --------------------------------------------------------

    if (
      firstResponse.status >= 300 &&
      firstResponse.status < 400
    ) {

      const location =
        firstResponse.headers.get(
          "location"
        );


      if (!location) {

        return json(
          {
            error:
              "VOD redirect without Location",

            status:
              firstResponse.status,
          },

          502,

          cors
        );
      }


      const redirectUrl =
        new URL(
          location,
          targetUrl.toString()
        );


      console.log(
        "[VOD REDIRECT]",
        {
          from:
            targetUrl.toString(),

          to:
            redirectUrl.toString(),
        }
      );


      // ------------------------------------------------------
      // Hostname redirect
      // ------------------------------------------------------

      if (
        !isIpAddress(
          redirectUrl.hostname
        )
      ) {

        return await fetchHostnameRedirect(
          request,
          redirectUrl,
          upstreamHeaders,
          cors
        );
      }


      // ------------------------------------------------------
      // PUBLIC IP REDIRECT
      // ------------------------------------------------------

      console.log(
        "[VOD IP REDIRECT]",
        {
          ip:
            redirectUrl.hostname,

          port:
            redirectUrl.port ||
            "80",

          protocol:
            redirectUrl.protocol,

          path:
            redirectUrl.pathname +
            redirectUrl.search,
        }
      );


      return await proxyIpWithSocket(
        request,
        redirectUrl,
        cors
      );
    }


    // --------------------------------------------------------
    // Other upstream status
    // --------------------------------------------------------

    const errorText =
      await safeReadText(
        firstResponse
      );


    console.error(
      "[VOD UPSTREAM ERROR]",
      {
        status:
          firstResponse.status,

        body:
          errorText.substring(
            0,
            500
          ),
      }
    );


    return new Response(
      errorText ||
        `Upstream HTTP ${firstResponse.status}`,

      {
        status:
          firstResponse.status,

        headers: {

          ...cors,

          "Content-Type":
            firstResponse.headers.get(
              "content-type"
            ) ||
            "text/plain; charset=utf-8",

          "Cache-Control":
            "no-store",
        },
      }
    );


  } catch (error) {

    console.error(
      "[VOD PROXY ERROR]",
      {
        message:
          error?.message ||
          String(error),

        target:
          targetUrl.toString(),
      }
    );


    return json(
      {
        error:
          "VOD proxy failed",

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
// LIVE HLS PROXY
// ============================================================

async function handleLiveStream(
  request,
  targetUrl,
  cors
) {

  // ----------------------------------------------------------
  // Fetch the original live URL manually.
  // We must NOT follow the redirect automatically because
  // the provider redirects to a public IP.
  // ----------------------------------------------------------

  const upstreamHeaders =
    buildLiveUpstreamHeaders(
      request,
      targetUrl
    );


  let firstResponse;

  try {

    firstResponse =
      await fetch(
        targetUrl.toString(),
        {
          method:
            request.method === "HEAD"
              ? "HEAD"
              : "GET",

          headers:
            upstreamHeaders,

          redirect:
            "manual",

          cache:
            "no-store",
        }
      );

  } catch (error) {

    console.error(
      "[LIVE FIRST FETCH ERROR]",
      {
        message:
          error?.message ||
          String(error),
      }
    );

    return json(
      {
        error:
          "Live provider request failed",

        details:
          error?.message ||
          String(error),
      },

      502,

      cors
    );
  }


  console.log(
    "[LIVE FIRST RESPONSE]",
    {
      status:
        firstResponse.status,

      location:
        firstResponse.headers.get(
          "location"
        ) || "",

      contentType:
        firstResponse.headers.get(
          "content-type"
        ) || "",
    }
  );


  // ----------------------------------------------------------
  // Direct M3U8 response
  // ----------------------------------------------------------

  if (
    firstResponse.status >= 200 &&
    firstResponse.status < 300
  ) {

    const playlist =
      await firstResponse.text();

    return rewriteLivePlaylist(
      playlist,
      targetUrl,
      targetUrl,
      new URL(request.url).origin,
      cors
    );
  }


  // ----------------------------------------------------------
  // Provider redirect
  // ----------------------------------------------------------

  if (
    firstResponse.status >= 300 &&
    firstResponse.status < 400
  ) {

    const location =
      firstResponse.headers.get(
        "location"
      );


    if (!location) {

      return json(
        {
          error:
            "Live redirect without Location",
        },

        502,

        cors
      );
    }


    const redirectUrl =
      new URL(
        location,
        targetUrl.toString()
      );


    console.log(
      "[LIVE REDIRECT]",
      {
        to:
          redirectUrl.toString(),
      }
    );


    // --------------------------------------------------------
    // The tested provider redirects to a public IP.
    // --------------------------------------------------------

    if (
      isIpAddress(
        redirectUrl.hostname
      )
    ) {

      const result =
        await fetchLivePlaylistFromSocket(
          request,
          redirectUrl
        );


      if (!result) {

        return json(
          {
            error:
              "Could not retrieve live playlist",
          },

          502,

          cors
        );
      }


      console.log(
        "[LIVE M3U8 RESPONSE]",
        {
          status:
            result.status,

          contentType:
            result.headers.get(
              "content-type"
            ) || "",

          contentLength:
            result.headers.get(
              "content-length"
            ) || "",
        }
      );


      if (
        result.status < 200 ||
        result.status >= 300
      ) {

        return new Response(
          result.bodyText ||
            `Live upstream HTTP ${result.status}`,

          {
            status:
              result.status,

            headers: {
              ...cors,

              "Content-Type":
                result.headers.get(
                  "content-type"
                ) ||
                "text/plain; charset=utf-8",

              "Cache-Control":
                "no-store",
            },
          }
        );
      }


      return rewriteLivePlaylist(
        result.bodyText,
        redirectUrl,
        targetUrl,
        new URL(request.url).origin,
        cors
      );
    }


    // --------------------------------------------------------
    // Hostname redirect
    // --------------------------------------------------------

    try {

      const response =
        await fetch(
          redirectUrl.toString(),
          {
            method:
              request.method === "HEAD"
                ? "HEAD"
                : "GET",

            headers:
              upstreamHeaders,

            redirect:
              "manual",

            cache:
              "no-store",
          }
        );


      if (
        response.status >= 200 &&
        response.status < 300
      ) {

        const playlist =
          await response.text();

        return rewriteLivePlaylist(
          playlist,
          redirectUrl,
          targetUrl,
          new URL(request.url).origin,
          cors
        );
      }


      return new Response(
        await safeReadText(
          response
        ),

        {
          status:
            response.status,

          headers: {
            ...cors,

            "Content-Type":
              response.headers.get(
                "content-type"
              ) ||
              "text/plain; charset=utf-8",
          },
        }
      );

    } catch (error) {

      console.error(
        "[LIVE HOST REDIRECT ERROR]",
        {
          message:
            error?.message ||
            String(error),
        }
      );

      return json(
        {
          error:
            "Live hostname redirect failed",

          details:
            error?.message ||
            String(error),
        },

        502,

        cors
      );
    }
  }


  return new Response(
    await safeReadText(
      firstResponse
    ),

    {
      status:
        firstResponse.status,

      headers: {
        ...cors,

        "Content-Type":
          firstResponse.headers.get(
            "content-type"
          ) ||
          "text/plain; charset=utf-8",
      },
    }
  );
}


// ============================================================
// LIVE UPSTREAM HEADERS
// ============================================================

function buildLiveUpstreamHeaders(
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

    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  );


  headers.set(
    "Accept",

    "application/vnd.apple.mpegurl,application/x-mpegurl,*/*;q=0.8"
  );


  headers.set(
    "Accept-Encoding",
    "identity"
  );


  headers.set(
    "Accept-Language",

    request.headers.get(
      "Accept-Language"
    ) ||

    "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7"
  );


  headers.set(
    "Referer",

    getOrigin(
      targetUrl.toString()
    ) + "/"
  );


  return headers;
}


// ============================================================
// FETCH LIVE M3U8 THROUGH TCP SOCKET
// ============================================================

async function fetchLivePlaylistFromSocket(
  request,
  targetUrl
) {

  const ip =
    targetUrl.hostname;


  const port =
    Number(
      targetUrl.port ||
      80
    );


  if (
    !isIpAddress(ip)
  ) {

    throw new Error(
      "Live socket target is not an IP"
    );
  }


  if (
    port !== 80
  ) {

    throw new Error(
      "Only HTTP port 80 is supported for Live IP redirect"
    );
  }


  let socket;


  try {

    socket =
      connect({
        hostname:
          ip,

        port:
          port,

        secureTransport:
          "off",

        allowHalfOpen:
          true,
      });


    await socket.opened;


    console.log(
      "[LIVE SOCKET CONNECTED]",
      {
        ip,
        port,
      }
    );

  } catch (error) {

    console.error(
      "[LIVE SOCKET CONNECT ERROR]",
      {
        ip,
        port,

        message:
          error?.message ||
          String(error),
      }
    );

    return null;
  }


  try {

    const writer =
      socket.writable.getWriter();


    const requestText =
      buildLiveRawHttpRequest(
        request,
        targetUrl
      );


    await writer.write(
      new TextEncoder().encode(
        requestText
      )
    );


    console.log(
      "[LIVE SOCKET WRITE OK]"
    );


    // Same proven behavior as the working VOD proxy.
    writer.releaseLock();


    const reader =
      socket.readable.getReader();


    const headerResult =
      await readHttpHeadersWithTimeout(
        reader,
        10000
      );


    if (!headerResult) {

      try {
        reader.releaseLock();
      } catch (_) {}


      try {
        await socket.close();
      } catch (_) {}


      return null;
    }


    const {
      status,
      headers,
      bodyRemainder,
    } =
      headerResult;


    const body =
      await collectHttpBodyForLive(
        reader,
        bodyRemainder,
        headers
      );


    try {
      reader.releaseLock();
    } catch (_) {}


    try {
      await socket.close();
    } catch (_) {}


    return {
      status,

      headers,

      bodyText:
        new TextDecoder().decode(
          body
        ),
    };

  } catch (error) {

    console.error(
      "[LIVE SOCKET ERROR]",
      {
        message:
          error?.message ||
          String(error),
      }
    );


    try {
      await socket.close();
    } catch (_) {}


    return null;
  }
}


// ============================================================
// LIVE RAW HTTP REQUEST
// ============================================================

function buildLiveRawHttpRequest(
  request,
  targetUrl
) {

  const lines = [];


  lines.push(
    `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`
  );


  lines.push(
    `Host: ${targetUrl.hostname}`
  );


  lines.push(
    "Connection: keep-alive"
  );


  lines.push(
    "Accept: application/vnd.apple.mpegurl,application/x-mpegurl,*/*;q=0.8"
  );


  lines.push(
    "Accept-Encoding: identity"
  );


  lines.push(
    "Accept-Language: ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7"
  );


  lines.push(
    "User-Agent: " +
    (
      request.headers.get(
        "User-Agent"
      ) ||

      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    )
  );


  lines.push(
    "Referer: http://barqtv.website/"
  );


  lines.push("");
  lines.push("");


  return lines.join(
    "\r\n"
  );
}


// ============================================================
// COLLECT LIVE HTTP BODY
// ============================================================

async function collectHttpBodyForLive(
  reader,
  initialBytes,
  headers
) {

  const parts = [];


  if (
    initialBytes &&
    initialBytes.length
  ) {

    parts.push(
      initialBytes
    );
  }


  const contentLengthHeader =
    headers.get(
      "content-length"
    );


  const contentLength =
    contentLengthHeader !== null
      ? Number(
          contentLengthHeader
        )
      : NaN;


  if (
    Number.isFinite(
      contentLength
    )
  ) {

    let total =
      initialBytes?.length ||
      0;


    while (
      total <
      contentLength
    ) {

      const result =
        await reader.read();


      if (
        result.done
      ) {

        break;
      }


      if (
        result.value &&
        result.value.length
      ) {

        const remaining =
          contentLength -
          total;


        const take =
          Math.min(
            remaining,
            result.value.length
          );


        parts.push(
          result.value.slice(
            0,
            take
          )
        );


        total +=
          take;
      }
    }


    return concatMany(
      parts
    );
  }


  // ----------------------------------------------------------
  // Chunked response
  // ----------------------------------------------------------

  const transferEncoding =
    (
      headers.get(
        "transfer-encoding"
      ) || ""
    ).toLowerCase();


  if (
    transferEncoding.includes(
      "chunked"
    )
  ) {

    return decodeChunkedBytes(
      reader,
      initialBytes ||
        new Uint8Array(0)
    );
  }


  // ----------------------------------------------------------
  // No Content-Length.
  // Read until EOF.
  // ----------------------------------------------------------

  while (true) {

    const result =
      await reader.read();


    if (
      result.done
    ) {

      break;
    }


    if (
      result.value &&
      result.value.length
    ) {

      parts.push(
        result.value
      );
    }
  }


  return concatMany(
    parts
  );
}


// ============================================================
// SIMPLE CHUNKED BYTE DECODER FOR LIVE PLAYLIST
// ============================================================

async function decodeChunkedBytes(
  reader,
  initialBytes
) {

  let buffer =
    initialBytes;


  const output = [];


  while (true) {

    let lineEnd =
      findCrlf(
        buffer
      );


    while (
      lineEnd === -1
    ) {

      const result =
        await reader.read();


      if (
        result.done
      ) {

        break;
      }


      buffer =
        concatUint8Arrays(
          buffer,
          result.value
        );


      lineEnd =
        findCrlf(
          buffer
        );
    }


    if (
      lineEnd === -1
    ) {

      break;
    }


    const sizeLine =
      new TextDecoder()
        .decode(
          buffer.slice(
            0,
            lineEnd
          )
        )
        .trim();


    buffer =
      buffer.slice(
        lineEnd + 2
      );


    const semicolon =
      sizeLine.indexOf(
        ";"
      );


    const sizeText =
      semicolon >= 0
        ? sizeLine.slice(
            0,
            semicolon
          )
        : sizeLine;


    const chunkSize =
      parseInt(
        sizeText.trim(),
        16
      );


    if (
      !Number.isFinite(
        chunkSize
      )
    ) {

      throw new Error(
        "Invalid live chunk size"
      );
    }


    if (
      chunkSize === 0
    ) {

      break;
    }


    while (
      buffer.length <
      chunkSize + 2
    ) {

      const result =
        await reader.read();


      if (
        result.done
      ) {

        throw new Error(
          "Unexpected EOF in live chunk"
        );
      }


      buffer =
        concatUint8Arrays(
          buffer,
          result.value
        );
    }


    output.push(
      buffer.slice(
        0,
        chunkSize
      )
    );


    buffer =
      buffer.slice(
        chunkSize + 2
      );
  }


  return concatMany(
    output
  );
}


// ============================================================
// REWRITE LIVE M3U8
// ============================================================

function rewriteLivePlaylist(
  playlist,
  playlistBaseUrl,
  originalLiveUrl,
  workerOrigin,
  cors
) {

  if (
    typeof playlist !== "string" ||
    !playlist.includes(
      "#EXTM3U"
    )
  ) {

    console.error(
      "[LIVE INVALID PLAYLIST]",
      {
        length:
          playlist?.length ||
          0,

        preview:
          String(
            playlist || ""
          ).substring(
            0,
            300
          ),
      }
    );


    return new Response(
      playlist ||
        "Invalid live playlist",

      {
        status:
          502,

        headers: {
          ...cors,

          "Content-Type":
            "text/plain; charset=utf-8",

          "Cache-Control":
            "no-store",
        },
      }
    );
  }




  const lines =
    playlist.split(
      /\r?\n/
    );


  const output = [];


  for (
    const line of lines
  ) {

    const trimmed =
      line.trim();


    // --------------------------------------------------------
    // Empty line
    // --------------------------------------------------------

    if (!trimmed) {

      output.push(
        ""
      );

      continue;
    }


    // --------------------------------------------------------
    // HLS comments / tags
    // --------------------------------------------------------

    if (
      trimmed.startsWith("#")
    ) {

      output.push(
        line
      );

      continue;
    }


    // --------------------------------------------------------
    // Segment / child playlist URL
    // --------------------------------------------------------

    try {

      const mediaUrl =
        new URL(
          trimmed,
          playlistBaseUrl.toString()
        );


      /*
       * We deliberately route the media request back through
       * the same /stream endpoint.
       *
       * This keeps the browser away from the provider IP and
       * lets the Worker handle the IP socket connection.
       */

      const proxiedUrl =
        workerOrigin +
        "/stream?hls=1&url=" +
        encodeURIComponent(
          mediaUrl.toString()
        );


      output.push(
        proxiedUrl
      );

    } catch (error) {

      console.warn(
        "[LIVE PLAYLIST URL ERROR]",
        {
          line:
            trimmed.substring(
              0,
              200
            ),

          message:
            error?.message ||
            String(error),
        }
      );


      output.push(
        line
      );
    }
  }


  const body =
    output.join(
      "\n"
    );


  console.log(
    "[LIVE PLAYLIST REWRITTEN]",
    {
      originalBytes:
        playlist.length,

      rewrittenBytes:
        body.length,

      mediaLines:
        output.filter(
          line =>
            line.startsWith(
              workerOrigin +
              "/stream?url="
            )
        ).length,
    }
  );


  return new Response(
    body,
    {
      status:
        200,

      headers: {
        ...cors,

        "Content-Type":
          "application/vnd.apple.mpegurl",

        "Cache-Control":
          "no-store, no-cache, must-revalidate",

        "Pragma":
          "no-cache",
      },
    }
  );
}



// ============================================================
// BUILD UPSTREAM HEADERS
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

    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  );


  headers.set(
    "Accept",

    request.headers.get(
      "Accept"
    ) ||

    "video/mp4,video/*,*/*;q=0.8"
  );


  headers.set(
    "Accept-Language",

    request.headers.get(
      "Accept-Language"
    ) ||

    "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7"
  );


  headers.set(
    "Accept-Encoding",
    "identity"
  );


  headers.set(
    "Referer",

    getOrigin(
      targetUrl.toString()
    ) + "/"
  );


  // ----------------------------------------------------------
  // Range
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // Conditional headers
  // ----------------------------------------------------------

  copyRequestHeader(
    request,
    headers,
    "If-Range"
  );


  copyRequestHeader(
    request,
    headers,
    "If-None-Match"
  );


  copyRequestHeader(
    request,
    headers,
    "If-Modified-Since"
  );


  return headers;
}


// ============================================================
// HOSTNAME REDIRECT
// ============================================================

async function fetchHostnameRedirect(
  request,
  redirectUrl,
  upstreamHeaders,
  cors
) {

  console.log(
    "[VOD HOST REDIRECT]",
    redirectUrl.toString()
  );


  try {

    const response =
      await fetch(
        redirectUrl.toString(),
        {
          method:
            request.method === "HEAD"
              ? "HEAD"
              : "GET",

          headers:
            upstreamHeaders,

          redirect:
            "manual",

          cache:
            "no-store",
        }
      );


    if (
      response.status >= 300 &&
      response.status < 400
    ) {

      const location =
        response.headers.get(
          "location"
        );


      if (!location) {

        return json(
          {
            error:
              "Second redirect without Location",

            status:
              response.status,
          },

          502,

          cors
        );
      }


      const nextUrl =
        new URL(
          location,
          redirectUrl.toString()
        );


      console.log(
        "[VOD SECOND REDIRECT]",
        {
          to:
            nextUrl.toString(),
        }
      );


      if (
        isIpAddress(
          nextUrl.hostname
        )
      ) {

        return await proxyIpWithSocket(
          request,
          nextUrl,
          cors
        );
      }


      return json(
        {
          error:
            "Too many VOD redirects",

          finalHost:
            nextUrl.hostname,
        },

        502,

        cors
      );
    }


    if (
      response.status >= 200 &&
      response.status < 300
    ) {

      return makeBrowserResponse(
        response,
        request,
        cors
      );
    }


    const text =
      await safeReadText(
        response
      );


    return new Response(
      text ||
        `Upstream HTTP ${response.status}`,

      {
        status:
          response.status,

        headers: {

          ...cors,

          "Content-Type":
            response.headers.get(
              "content-type"
            ) ||
            "text/plain; charset=utf-8",
        },
      }
    );


  } catch (error) {

    console.error(
      "[VOD HOST REDIRECT ERROR]",
      {
        message:
          error?.message ||
          String(error),
      }
    );


    return json(
      {
        error:
          "Hostname redirect failed",

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
// TCP SOCKET PROXY
// ============================================================

async function proxyIpWithSocket(
  request,
  targetUrl,
  cors
) {

  const ip =
    targetUrl.hostname;


  const port =
    Number(
      targetUrl.port ||
      80
    );


  if (
    !isIpAddress(ip)
  ) {

    return json(
      {
        error:
          "Socket target is not an IP",
      },

      500,

      cors
    );
  }


  if (
    port !== 80
  ) {

    return json(
      {
        error:
          "Only HTTP port 80 is supported for IP VOD redirect",

        port,
      },

      502,

      cors
    );
  }


  console.log(
    "[SOCKET CONNECT]",
    {
      ip,
      port,

      path:
        targetUrl.pathname +
        targetUrl.search,
    }
  );


  let socket;


  try {

    socket =
      connect({
        hostname:
          ip,

        port:
          port,

        // HTTP socket, not TLS.
        secureTransport:
          "off",

        /*
         * Keep the readable side alive independently
         * from the writable side.
         */
        allowHalfOpen:
          true,
      });


    await socket.opened;


    console.log(
      "[SOCKET CONNECTED]",
      {
        ip,
        port,
      }
    );

  } catch (error) {

    console.error(
      "[SOCKET CONNECT ERROR]",
      {
        ip,
        port,

        message:
          error?.message ||
          String(error),
      }
    );


    return json(
      {
        error:
          "Could not connect to VOD server",

        details:
          error?.message ||
          String(error),
      },

      502,

      cors
    );
  }


  try {

    const writer =
      socket.writable.getWriter();


    const requestText =
      buildRawHttpRequest(
        request,
        targetUrl
      );


    console.log(
      "[SOCKET HTTP REQUEST]",
      {
        host:
          ip,

        path:
          targetUrl.pathname +
          targetUrl.search,

        range:
          request.headers.get(
            "Range"
          ) || "",

        requestBytes:
          new TextEncoder()
            .encode(requestText)
            .length,
      }
    );


    await writer.write(
      new TextEncoder().encode(
        requestText
      )
    );


    console.log(
      "[SOCKET WRITE OK]"
    );


    /*
     * IMPORTANT
     *
     * Do NOT close the writer here.
     *
     * The HTTP request is already complete because
     * buildRawHttpRequest() ends with \r\n\r\n.
     *
     * Keeping the writable side open avoids immediately
     * sending FIN to upstream.
     */
    writer.releaseLock();


    console.log(
      "[SOCKET WRITE RELEASED]"
    );


    const reader =
      socket.readable.getReader();


    console.log(
      "[SOCKET WAITING RESPONSE]"
    );


    // --------------------------------------------------------
    // Read HTTP response headers.
    // --------------------------------------------------------

    const headerResult =
      await readHttpHeadersWithTimeout(
        reader,
        10000
      );


    if (!headerResult) {

      console.error(
        "[SOCKET NO RESPONSE]",
        {
          ip,
          port,

          message:
            "Socket ended or timed out before HTTP headers were received",
        }
      );


      try {
        reader.releaseLock();
      } catch (_) {}


      try {
        await socket.close();
      } catch (_) {}


      return json(
        {
          error:
            "VOD server closed connection before sending headers",
        },

        502,

        cors
      );
    }


    const {
      status,
      statusText,
      headers,
      bodyRemainder,
    } =
      headerResult;


    console.log(
      "[SOCKET RESPONSE]",
      {
        status,

        contentType:
          headers.get(
            "content-type"
          ) || "",

        contentLength:
          headers.get(
            "content-length"
          ) || "",

        contentRange:
          headers.get(
            "content-range"
          ) || "",

        transferEncoding:
          headers.get(
            "transfer-encoding"
          ) || "",

        acceptRanges:
          headers.get(
            "accept-ranges"
          ) || "",
      }
    );


    // --------------------------------------------------------
    // HEAD
    // --------------------------------------------------------

    if (
      request.method === "HEAD"
    ) {

      try {
        reader.releaseLock();
      } catch (_) {}


      try {
        await socket.close();
      } catch (_) {}


      return new Response(
        null,
        {
          status,

          statusText,

          headers:
            browserHeadersFromUpstream(
              headers,
              cors
            ),
        }
      );
    }


    // --------------------------------------------------------
    // Error response
    // --------------------------------------------------------

    if (
      status < 200 ||
      status >= 300
    ) {

      const errorBody =
        await collectSocketBody(
          reader,
          bodyRemainder,
          headers
        );


      try {
        await socket.close();
      } catch (_) {}


      const text =
        new TextDecoder()
          .decode(errorBody)
          .substring(
            0,
            1000
          );


      console.error(
        "[SOCKET UPSTREAM ERROR]",
        {
          status,
          body:
            text,
        }
      );


      return new Response(
        text ||
          `VOD upstream HTTP ${status}`,

        {
          status,

          headers: {

            ...cors,

            "Content-Type":
              "text/plain; charset=utf-8",

            "Cache-Control":
              "no-store",
          },
        }
      );
    }


    // --------------------------------------------------------
    // Browser headers
    // --------------------------------------------------------

    const browserHeaders =
      browserHeadersFromUpstream(
        headers,
        cors
      );


    // --------------------------------------------------------
    // Stream body
    // --------------------------------------------------------

    const body =
      createSocketBodyStream(
        reader,
        bodyRemainder,
        headers,
        socket
      );


    return new Response(
      body,
      {
        status,

        statusText,

        headers:
          browserHeaders,
      }
    );


  } catch (error) {

    console.error(
      "[SOCKET PROXY ERROR]",
      {
        message:
          error?.message ||
          String(error),

        stack:
          error?.stack ||
          "",

        target:
          targetUrl.toString(),
      }
    );


    try {
      await socket.close();
    } catch (_) {}


    return json(
      {
        error:
          "VOD socket proxy failed",

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
// RAW HTTP REQUEST
// ============================================================

function buildRawHttpRequest(
  request,
  targetUrl
) {

  const lines = [];


  // ----------------------------------------------------------
  // GET
  // ----------------------------------------------------------

  lines.push(
    `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`
  );


  // ----------------------------------------------------------
  // IMPORTANT:
  //
  // The redirect target is:
  //
  // http://37.49.230.121/vauth/...
  //
  // Therefore Host remains the IP.
  // ----------------------------------------------------------

  lines.push(
    `Host: ${targetUrl.hostname}`
  );


  // ----------------------------------------------------------
  // Keep connection alive.
  // ----------------------------------------------------------

  lines.push(
    "Connection: keep-alive"
  );


  lines.push(
    "Accept: video/mp4,video/*,*/*;q=0.8"
  );


  lines.push(
    "Accept-Encoding: identity"
  );


  lines.push(
    "Accept-Language: ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7"
  );


  lines.push(
    "User-Agent: " +
    (
      request.headers.get(
        "User-Agent"
      ) ||

      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    )
  );


  lines.push(
    "Referer: http://barqtv.website/"
  );


  // ----------------------------------------------------------
  // Range
  // ----------------------------------------------------------

  const range =
    request.headers.get(
      "Range"
    );


  if (range) {

    lines.push(
      `Range: ${range}`
    );
  }


  // ----------------------------------------------------------
  // Conditional headers
  // ----------------------------------------------------------

  const ifRange =
    request.headers.get(
      "If-Range"
    );


  if (ifRange) {

    lines.push(
      `If-Range: ${ifRange}`
    );
  }


  const ifNoneMatch =
    request.headers.get(
      "If-None-Match"
    );


  if (ifNoneMatch) {

    lines.push(
      `If-None-Match: ${ifNoneMatch}`
    );
  }


  const ifModifiedSince =
    request.headers.get(
      "If-Modified-Since"
    );


  if (ifModifiedSince) {

    lines.push(
      `If-Modified-Since: ${ifModifiedSince}`
    );
  }


  // ----------------------------------------------------------
  // End HTTP request.
  // ----------------------------------------------------------

  lines.push("");
  lines.push("");


  return lines.join(
    "\r\n"
  );
}


// ============================================================
// READ HTTP HEADERS WITH TIMEOUT
// ============================================================

async function readHttpHeadersWithTimeout(
  reader,
  timeoutMs
) {

  let timer;


  try {

    return await Promise.race([

      readHttpHeaders(
        reader
      ),

      new Promise(
        (_, reject) => {

          timer =
            setTimeout(
              () => {

                reject(
                  new Error(
                    `Timed out waiting for upstream HTTP headers after ${timeoutMs}ms`
                  )
                );

              },
              timeoutMs
            );
        }
      ),
    ]);

  } catch (error) {

    console.error(
      "[SOCKET HEADER TIMEOUT/ERROR]",
      {
        message:
          error?.message ||
          String(error),
      }
    );


    return null;

  } finally {

    if (timer) {
      clearTimeout(timer);
    }
  }
}


// ============================================================
// READ HTTP RESPONSE HEADERS
// ============================================================

async function readHttpHeaders(
  reader
) {

  const separator =
    new Uint8Array([
      13, 10,
      13, 10,
    ]);


  let buffer =
    new Uint8Array(0);


  const maxHeaderSize =
    128 * 1024;


  while (
    buffer.length <
    maxHeaderSize
  ) {

    const result =
      await reader.read();


    if (
      result.done
    ) {

      return null;
    }


    const chunk =
      result.value;


    if (
      !chunk ||
      !chunk.length
    ) {

      continue;
    }


    buffer =
      concatUint8Arrays(
        buffer,
        chunk
      );


    const index =
      findBytes(
        buffer,
        separator
      );


    if (
      index !== -1
    ) {

      const headerBytes =
        buffer.slice(
          0,
          index
        );


      const bodyRemainder =
        buffer.slice(
          index + 4
        );


      const headerText =
        new TextDecoder()
          .decode(
            headerBytes
          );


      const lines =
        headerText.split(
          "\r\n"
        );


      const statusLine =
        lines.shift() ||
        "";


      const statusMatch =
        statusLine.match(
          /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/
        );


      if (
        !statusMatch
      ) {

        throw new Error(
          "Invalid upstream HTTP status line: " +
          statusLine
        );
      }


      const status =
        Number(
          statusMatch[1]
        );


      const statusText =
        statusMatch[2] ||
        "";


      const headers =
        new Headers();


      for (
        const line of lines
      ) {

        const colon =
          line.indexOf(":");


        if (
          colon <= 0
        ) {

          continue;
        }


        const name =
          line
            .slice(
              0,
              colon
            )
            .trim();


        const value =
          line
            .slice(
              colon + 1
            )
            .trim();


        try {

          headers.set(
            name,
            value
          );

        } catch (_) {}
      }


      return {
        status,

        statusText,

        headers,

        bodyRemainder,
      };
    }
  }


  throw new Error(
    "Upstream HTTP headers too large"
  );
}


// ============================================================
// CREATE STREAM FROM SOCKET
// ============================================================

function createSocketBodyStream(
  reader,
  initialBytes,
  headers,
  socket
) {

  const transferEncoding =
    (
      headers.get(
        "transfer-encoding"
      ) || ""
    ).toLowerCase();


  // ----------------------------------------------------------
  // CHUNKED RESPONSE
  // ----------------------------------------------------------

  if (
    transferEncoding.includes(
      "chunked"
    )
  ) {

    return createChunkedStream(
      reader,
      initialBytes ||
        new Uint8Array(0),
      socket
    );
  }


  // ----------------------------------------------------------
  // CONTENT-LENGTH RESPONSE
  //
  // This is important because the upstream connection
  // is now keep-alive.
  //
  // We must stop exactly after Content-Length bytes.
  // ----------------------------------------------------------

  const contentLengthHeader =
    headers.get(
      "content-length"
    );


  if (
    contentLengthHeader !== null
  ) {

    const contentLength =
      Number(
        contentLengthHeader
      );


    if (
      Number.isFinite(
        contentLength
      ) &&
      contentLength >= 0
    ) {

      let remaining =
        contentLength;


      let initialOffset =
        0;


      const initial =
        initialBytes ||
        new Uint8Array(0);


      return new ReadableStream({

        async pull(controller) {

          try {

            // ------------------------------------------------
            // Entire response received.
            // ------------------------------------------------

            if (
              remaining <= 0
            ) {

              controller.close();


              try {
                reader.releaseLock();
              } catch (_) {}


              try {
                await socket.close();
              } catch (_) {}


              return;
            }


            // ------------------------------------------------
            // First bytes may already contain part/all of body.
            // ------------------------------------------------

            if (
              initialOffset <
              initial.length
            ) {

              const available =
                initial.length -
                initialOffset;


              const take =
                Math.min(
                  available,
                  remaining
                );


              if (
                take > 0
              ) {

                controller.enqueue(
                  initial.slice(
                    initialOffset,
                    initialOffset +
                      take
                  )
                );


                initialOffset +=
                  take;


                remaining -=
                  take;
              }


              if (
                remaining <= 0
              ) {

                controller.close();


                try {
                  reader.releaseLock();
                } catch (_) {}


                try {
                  await socket.close();
                } catch (_) {}
              }


              return;
            }


            // ------------------------------------------------
            // Read next socket data.
            // ------------------------------------------------

            const result =
              await reader.read();


            if (
              result.done
            ) {

              /*
               * Upstream ended before Content-Length.
               *
               * Do not throw a fake video error here.
               * Close cleanly because the server has already
               * ended the response.
               */
              console.warn(
                "[SOCKET CONTENT-LENGTH EOF]",
                {
                  remaining,
                }
              );


              controller.close();


              try {
                reader.releaseLock();
              } catch (_) {}


              try {
                await socket.close();
              } catch (_) {}


              return;
            }


            if (
              result.value &&
              result.value.length
            ) {

              const take =
                Math.min(
                  result.value.length,
                  remaining
                );


              controller.enqueue(
                result.value.slice(
                  0,
                  take
                )
              );


              remaining -=
                take;


              /*
               * Ignore any bytes beyond Content-Length.
               * They belong to a later keep-alive response
               * and must never be sent to the browser.
               */
              if (
                remaining <= 0
              ) {

                controller.close();


                try {
                  reader.releaseLock();
                } catch (_) {}


                try {
                  await socket.close();
                } catch (_) {}
              }
            }

          } catch (error) {

            console.error(
              "[SOCKET CONTENT-LENGTH STREAM ERROR]",
              {
                message:
                  error?.message ||
                  String(error),
              }
            );


            controller.error(
              error
            );


            try {
              reader.releaseLock();
            } catch (_) {}


            try {
              await socket.close();
            } catch (_) {}
          }
        },


        cancel() {

          try {
            reader.cancel();
          } catch (_) {}


          try {
            socket.close();
          } catch (_) {}
        },
      });
    }
  }


  // ----------------------------------------------------------
  // NO CONTENT-LENGTH
  //
  // In this case EOF determines the end of the response.
  // ----------------------------------------------------------

  let initialSent =
    false;


  return new ReadableStream({

    async pull(controller) {

      try {

        if (
          !initialSent
        ) {

          initialSent =
            true;


          if (
            initialBytes &&
            initialBytes.length
          ) {

            controller.enqueue(
              initialBytes
            );


            return;
          }
        }


        const result =
          await reader.read();


        if (
          result.done
        ) {

          controller.close();


          try {
            reader.releaseLock();
          } catch (_) {}


          try {
            await socket.close();
          } catch (_) {}


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

      } catch (error) {

        console.error(
          "[SOCKET BODY ERROR]",
          {
            message:
              error?.message ||
              String(error),
          }
        );


        controller.error(
          error
        );


        try {
          reader.releaseLock();
        } catch (_) {}


        try {
          await socket.close();
        } catch (_) {}
      }
    },


    cancel() {

      try {
        reader.cancel();
      } catch (_) {}


      try {
        socket.close();
      } catch (_) {}
    },
  });
}


// ============================================================
// CHUNKED TRANSFER DECODER
// ============================================================

function createChunkedStream(
  reader,
  initialBytes,
  socket
) {

  return new ReadableStream({

    async start(controller) {

      let buffer =
        initialBytes;


      try {

        while (true) {

          let lineEnd =
            findCrlf(
              buffer
            );


          while (
            lineEnd === -1
          ) {

            const result =
              await reader.read();


            if (
              result.done
            ) {

              throw new Error(
                "Unexpected EOF in chunked response"
              );
            }


            buffer =
              concatUint8Arrays(
                buffer,
                result.value
              );


            lineEnd =
              findCrlf(
                buffer
              );
          }


          const sizeLine =
            new TextDecoder()
              .decode(
                buffer.slice(
                  0,
                  lineEnd
                )
              )
              .trim();


          buffer =
            buffer.slice(
              lineEnd + 2
            );


          const semicolon =
            sizeLine.indexOf(
              ";"
            );


          const sizeText =
            semicolon >= 0
              ? sizeLine.slice(
                  0,
                  semicolon
                )
              : sizeLine;


          const chunkSize =
            parseInt(
              sizeText.trim(),
              16
            );


          if (
            !Number.isFinite(
              chunkSize
            )
          ) {

            throw new Error(
              "Invalid chunk size"
            );
          }


          // --------------------------------------------------
          // Last chunk
          // --------------------------------------------------

          if (
            chunkSize === 0
          ) {

            controller.close();

            break;
          }


          // --------------------------------------------------
          // Read complete chunk
          // --------------------------------------------------

          while (
            buffer.length <
            chunkSize + 2
          ) {

            const result =
              await reader.read();


            if (
              result.done
            ) {

              throw new Error(
                "Unexpected EOF in chunk data"
              );
            }


            buffer =
              concatUint8Arrays(
                buffer,
                result.value
              );
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


          if (
            chunk.length
          ) {

            controller.enqueue(
              chunk
            );
          }
        }

      } catch (error) {

        console.error(
          "[CHUNKED STREAM ERROR]",
          {
            message:
              error?.message ||
              String(error),
          }
        );


        controller.error(
          error
        );

      } finally {

        try {
          reader.releaseLock();
        } catch (_) {}


        try {
          await socket.close();
        } catch (_) {}
      }
    },


    cancel() {

      try {
        reader.cancel();
      } catch (_) {}


      try {
        socket.close();
      } catch (_) {}
    },
  });
}


// ============================================================
// COLLECT SOCKET BODY
// ============================================================

async function collectSocketBody(
  reader,
  initialBytes,
  headers
) {

  const parts = [];


  if (
    initialBytes &&
    initialBytes.length
  ) {

    parts.push(
      initialBytes
    );
  }


  while (true) {

    const result =
      await reader.read();


    if (
      result.done
    ) {

      break;
    }


    if (
      result.value &&
      result.value.length
    ) {

      parts.push(
        result.value
      );
    }
  }


  return concatMany(
    parts
  );
}


// ============================================================
// BROWSER RESPONSE FOR FETCH
// ============================================================

function makeBrowserResponse(
  upstreamResponse,
  request,
  cors
) {

  const headers =
    browserHeadersFromUpstream(
      upstreamResponse.headers,
      cors
    );


  if (
    request.method === "HEAD"
  ) {

    return new Response(
      null,
      {
        status:
          upstreamResponse.status,

        statusText:
          upstreamResponse.statusText,

        headers,
      }
    );
  }


  return new Response(
    upstreamResponse.body,
    {
      status:
        upstreamResponse.status,

      statusText:
        upstreamResponse.statusText,

      headers,
    }
  );
}


// ============================================================
// BROWSER RESPONSE HEADERS
// ============================================================

function browserHeadersFromUpstream(
  upstreamHeaders,
  cors
) {

  const headers =
    new Headers(cors);


  const type =
    upstreamHeaders.get(
      "content-type"
    );


  headers.set(
    "Content-Type",

    type &&
    type !==
      "application/octet-stream"

      ? type

      : "video/mp4"
  );


  const acceptRanges =
    upstreamHeaders.get(
      "accept-ranges"
    );


  headers.set(
    "Accept-Ranges",

    acceptRanges ||
    "bytes"
  );


  const length =
    upstreamHeaders.get(
      "content-length"
    );


  if (length) {

    headers.set(
      "Content-Length",
      length
    );
  }


  const range =
    upstreamHeaders.get(
      "content-range"
    );


  if (range) {

    headers.set(
      "Content-Range",
      range
    );
  }


  const etag =
    upstreamHeaders.get(
      "etag"
    );


  if (etag) {

    headers.set(
      "ETag",
      etag
    );
  }


  const modified =
    upstreamHeaders.get(
      "last-modified"
    );


  if (modified) {

    headers.set(
      "Last-Modified",
      modified
    );
  }


  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );


  headers.set(
    "Pragma",
    "no-cache"
  );


  return headers;
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
    url.searchParams
      .get("url")
      ?.trim();


  if (!target) {

    return json(
      {
        worker:
          "Raxson Player",

        status:
          "OK",

        routes: [
          "/api",
          "/stream",
          "/test",
          "/debug",
        ],

        vod:
          "enabled",

        live:
          "disabled",

        ipRedirect:
          "TCP socket enabled",
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
        valid:
          true,

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

        isIp:
          isIpAddress(
            parsed.hostname
          ),
      },

      200,

      cors
    );


  } catch (error) {

    return json(
      {
        valid:
          false,

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
          "no-store",
      },
    }
  );
}


// ============================================================
// NORMALIZE HOST
// ============================================================

function normalizeHost(
  host
) {

  let value =
    String(host)
      .trim();


  if (
    !/^https?:\/\//i.test(
      value
    )
  ) {

    value =
      "http://" + value;
  }


  const parsed =
    new URL(value);


  if (
    parsed.protocol !==
      "http:" &&

    parsed.protocol !==
      "https:"
  ) {

    throw new Error(
      "Only HTTP and HTTPS are supported"
    );
  }


  parsed.pathname =
    "";

  parsed.search =
    "";

  parsed.hash =
    "";


  return parsed.origin;
}


// ============================================================
// EXTRA API PARAMS
// ============================================================

function appendExtraParams(
  targetUrl,
  extra
) {

  if (!extra) {
    return;
  }


  let value =
    String(extra)
      .trim();


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
      new URLSearchParams(
        value
      );


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


// ============================================================
// COPY REQUEST HEADER
// ============================================================

function copyRequestHeader(
  request,
  target,
  name
) {

  const value =
    request.headers.get(
      name
    );


  if (value) {

    target.set(
      name,
      value
    );
  }
}


// ============================================================
// SAFE TEXT
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


// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  value
) {

  try {

    return new URL(
      value
    ).origin;

  } catch (_) {

    return "";
  }
}


// ============================================================
// IP DETECTION
// ============================================================

function isIpAddress(
  hostname
) {

  // IPv4
  if (
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(
      hostname
    )
  ) {

    return hostname
      .split(".")
      .every(
        part =>
          Number(part) >= 0 &&
          Number(part) <= 255
      );
  }


  // Basic IPv6 detection
  return hostname.includes(":");
}


// ============================================================
// BYTE HELPERS
// ============================================================

function concatUint8Arrays(
  a,
  b
) {

  const result =
    new Uint8Array(
      a.length +
      b.length
    );


  result.set(
    a,
    0
  );


  result.set(
    b,
    a.length
  );


  return result;
}


function concatMany(
  arrays
) {

  let total = 0;


  for (
    const item of arrays
  ) {

    total +=
      item.length;
  }


  const result =
    new Uint8Array(
      total
    );


  let offset = 0;


  for (
    const item of arrays
  ) {

    result.set(
      item,
      offset
    );


    offset +=
      item.length;
  }


  return result;
}


function findBytes(
  buffer,
  needle
) {

  outer:

  for (
    let i = 0;

    i <=
    buffer.length -
    needle.length;

    i++
  ) {

    for (
      let j = 0;

      j < needle.length;

      j++
    ) {

      if (
        buffer[i + j] !==
        needle[j]
      ) {

        continue outer;
      }
    }


    return i;
  }


  return -1;
}


function findCrlf(
  buffer
) {

  for (
    let i = 0;

    i < buffer.length - 1;

    i++
  ) {

    if (
      buffer[i] === 13 &&
      buffer[i + 1] === 10
    ) {

      return i;
    }
  }


  return -1;
}


// ============================================================
// PHASE 1 - LOCAL SUBSCRIPTIONS (isolated, additive only)
// ------------------------------------------------------------
// Rules honored by this section:
// - handleApi / handleStream / handleLiveStream are NOT
//   modified. Old /api and /stream behavior is untouched.
// - Main Xtream credentials come ONLY from Worker Secrets
//   (MAIN_HOST / MAIN_USER / MAIN_PASS) and are NEVER sent
//   to the browser in any response, URL, or header.
// - Local subscription passwords are stored in KV as
//   PBKDF2-SHA256 hashes (salt + hash), never plaintext.
// - Every local content/stream request requires a valid
//   session. Expired or disabled subscriptions are rejected
//   here and NEVER fall back to direct login.
// - No static subscriptions.json file is used.
// ============================================================

const LOCAL_SESSION_TTL_SECONDS = 24 * 60 * 60;

const LOCAL_PBKDF2_ITERATIONS = 100000;

const LOCAL_SUB_KEY_PREFIX = "sub:";

const LOCAL_SESS_KEY_PREFIX = "sess:";

const LOCAL_ALLOWED_ACTIONS = new Set([
  "get_account_info",
  "get_live_categories",
  "get_live_streams",
  "get_vod_categories",
  "get_vod_streams",
  "get_series_categories",
  "get_series",
  "get_series_info",
]);

const LOCAL_ADMIN_DURATIONS = {
  "24h": 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  "90d": 90 * 24 * 60 * 60,
  "365d": 365 * 24 * 60 * 60,
};


// ------------------------------------------------------------
// Small isolated helpers (local* prefix, no shared mutation)
// ------------------------------------------------------------

function localHexFromBytes(bytes) {

  let out = "";

  for (const b of bytes) {

    out += b.toString(16).padStart(2, "0");
  }

  return out;
}


function localBytesFromHex(hex) {

  const clean = String(hex || "").trim().toLowerCase();

  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {

    return null;
  }

  const out = new Uint8Array(clean.length / 2);

  for (let i = 0; i < out.length; i++) {

    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }

  return out;
}


function localTimingSafeEqual(a, b) {

  const x = String(a === undefined || a === null ? "" : a);
  const y = String(b === undefined || b === null ? "" : b);

  let diff = x.length === y.length ? 0 : 1;

  const len = Math.max(x.length, y.length);

  for (let i = 0; i < len; i++) {

    const cx = i < x.length ? x.charCodeAt(i) : 0;
    const cy = i < y.length ? y.charCodeAt(i) : 0;

    diff |= cx ^ cy;
  }

  return diff === 0;
}


function localKv(env) {

  if (!env || !env.SUBS || typeof env.SUBS.get !== "function") {

    return null;
  }

  return env.SUBS;
}


function localMainCreds(env) {

  const host = (env && env.MAIN_HOST ? String(env.MAIN_HOST) : "").trim();
  const user = (env && env.MAIN_USER ? String(env.MAIN_USER) : "").trim();
  const pass = (env && env.MAIN_PASS ? String(env.MAIN_PASS) : "").trim();

  if (!host || !user || !pass) {

    return null;
  }

  let cleanHost;

  try {

    cleanHost = normalizeHost(host);

  } catch (_) {

    return null;
  }

  return { host: cleanHost, user: user, pass: pass };
}


async function localHashPassword(password) {

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: LOCAL_PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    256
  );

  return {
    algo: "PBKDF2-SHA256",
    iterations: LOCAL_PBKDF2_ITERATIONS,
    salt: localHexFromBytes(saltBytes),
    hash: localHexFromBytes(new Uint8Array(bits)),
  };
}


async function localVerifyPassword(password, pw) {

  try {

    if (!pw || pw.algo !== "PBKDF2-SHA256") {

      return false;
    }

    const iterations = Number(pw.iterations);

    if (!Number.isFinite(iterations) || iterations < 10000) {

      return false;
    }

    const saltBytes = localBytesFromHex(pw.salt);

    if (!saltBytes || saltBytes.length < 8) {

      return false;
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(password)),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: iterations,
        hash: "SHA-256",
      },
      key,
      256
    );

    return localTimingSafeEqual(
      localHexFromBytes(new Uint8Array(bits)),
      pw.hash
    );

  } catch (_) {

    return false;
  }
}


async function localGetSub(kv, username) {

  const raw = await kv.get(LOCAL_SUB_KEY_PREFIX + username);

  if (!raw) {

    return null;
  }

  try {

    const sub = JSON.parse(raw);

    if (!sub || typeof sub !== "object" || sub.username !== username) {

      return null;
    }

    return sub;

  } catch (_) {

    return null;
  }
}


function localPublicSub(sub) {

  return {
    username: sub.username,
    startDate: sub.startDate,
    endDate: sub.endDate,
    active: sub.active === true,
    serverProfile: sub.serverProfile || "main",
    createdAt: sub.createdAt || null,
    updatedAt: sub.updatedAt || null,
  };
}


function localValidUsername(u) {

  return typeof u === "string" && /^[A-Za-z0-9._-]{3,64}$/.test(u.trim());
}


function localSessionTokenFromRequest(request, url) {

  const q = (url.searchParams.get("session") || "").trim();

  if (/^[0-9a-f]{64}$/.test(q)) {

    return q;
  }

  const auth = request.headers.get("Authorization") || "";

  const m = auth.match(/^Bearer\s+(.+)$/i);

  if (m && /^[0-9a-f]{64}$/.test(m[1].trim())) {

    return m[1].trim();
  }

  return null;
}


// Returns { session, sub } or { error, status, code }.
// Expired / disabled / deleted subscriptions are rejected
// here and never fall back to direct login.
async function localValidateSession(env, sessionToken) {

  const kv = localKv(env);

  if (!kv) {

    return { error: "Server not configured", status: 503, code: "NO_KV" };
  }

  if (!sessionToken || !/^[0-9a-f]{64}$/.test(sessionToken)) {

    return { error: "Invalid session", status: 401, code: "SESSION_INVALID" };
  }

  const raw = await kv.get(LOCAL_SESS_KEY_PREFIX + sessionToken);

  if (!raw) {

    return { error: "Session expired", status: 401, code: "SESSION_EXPIRED" };
  }

  let sess = null;

  try {

    sess = JSON.parse(raw);

  } catch (_) {

    sess = null;
  }

  if (!sess || !sess.sub || !Number.isFinite(sess.exp)) {

    try { await kv.delete(LOCAL_SESS_KEY_PREFIX + sessionToken); } catch (_) {}

    return { error: "Session expired", status: 401, code: "SESSION_EXPIRED" };
  }

  if (sess.exp * 1000 <= Date.now()) {

    try { await kv.delete(LOCAL_SESS_KEY_PREFIX + sessionToken); } catch (_) {}

    return { error: "Session expired", status: 401, code: "SESSION_EXPIRED" };
  }

  const sub = await localGetSub(kv, sess.sub);

  if (!sub) {

    return { error: "Subscription unavailable", status: 401, code: "SUB_MISSING" };
  }

  if (sub.active !== true) {

    return { error: "Subscription disabled", status: 403, code: "SUB_DISABLED" };
  }

  const now = Date.now();
  const start = Date.parse(sub.startDate);
  const end = Date.parse(sub.endDate);

  if (!Number.isFinite(start) || now < start) {

    return { error: "Subscription not started", status: 403, code: "SUB_NOT_STARTED" };
  }

  if (!Number.isFinite(end) || now > end) {

    return { error: "Subscription expired", status: 403, code: "SUB_EXPIRED" };
  }

  return { session: sess, sub: sub };
}


function localBuildMediaUrl(main, type, id) {

  if (!/^\d{1,10}$/.test(String(id))) {

    return null;
  }

  if (type === "live") {

    return main.host + "/live/" + main.user + "/" + main.pass + "/" + id + ".m3u8";
  }

  if (type === "movie") {

    return main.host + "/movie/" + main.user + "/" + main.pass + "/" + id + ".mp4";
  }

  if (type === "series") {

    return main.host + "/series/" + main.user + "/" + main.pass + "/" + id + ".mp4";
  }

  return null;
}


// Strips upstream account credentials from get_account_info
// responses so MAIN_USER / MAIN_PASS never reach the browser.
function localSanitizeAccountInfo(bodyText) {

  try {

    const data = JSON.parse(bodyText);

    if (data && typeof data === "object" && data.user_info && typeof data.user_info === "object") {

      delete data.user_info.username;
      delete data.user_info.password;
    }

    return JSON.stringify(data);

  } catch (_) {

    return bodyText;
  }
}


// ============================================================
// LOCAL LOGIN / LOGOUT
// ============================================================

async function handleLocalLogin(request, env, cors) {

  if (request.method !== "POST") {

    return json({ error: "Method not allowed" }, 405, cors);
  }

  const kv = localKv(env);

  if (!kv) {

    return json({ error: "Server not configured", code: "NO_KV" }, 503, cors);
  }

  let body = null;

  try {

    body = await request.json();

  } catch (_) {

    return json({ error: "Invalid JSON body" }, 400, cors);
  }

  const username = (body && body.username ? String(body.username) : "").trim();
  const password = body && body.password !== undefined ? String(body.password) : "";

  if (!localValidUsername(username) || !password) {

    return json({ error: "Invalid credentials", code: "BAD_CREDENTIALS" }, 401, cors);
  }

  const sub = await localGetSub(kv, username);

  if (!sub) {

    return json({ error: "Invalid credentials", code: "BAD_CREDENTIALS" }, 401, cors);
  }

  const ok = await localVerifyPassword(password, sub.pw);

  if (!ok) {

    return json({ error: "Invalid credentials", code: "BAD_CREDENTIALS" }, 401, cors);
  }

  if (sub.active !== true) {

    return json({ error: "Subscription disabled", code: "SUB_DISABLED" }, 403, cors);
  }

  const now = Date.now();
  const start = Date.parse(sub.startDate);
  const end = Date.parse(sub.endDate);

  if (!Number.isFinite(start) || now < start) {

    return json({ error: "Subscription not started", code: "SUB_NOT_STARTED" }, 403, cors);
  }

  if (!Number.isFinite(end) || now > end) {

    return json({ error: "Subscription expired", code: "SUB_EXPIRED" }, 403, cors);
  }

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = localHexFromBytes(tokenBytes);
  const exp = Math.min(
    Math.floor(end / 1000),
    Math.floor(now / 1000) + LOCAL_SESSION_TTL_SECONDS
  );

  await kv.put(
    LOCAL_SESS_KEY_PREFIX + token,
    JSON.stringify({
      sub: username,
      profile: sub.serverProfile || "main",
      createdAt: new Date(now).toISOString(),
      exp: exp,
    }),
    { expiration: exp }
  );

  return json(
    {
      ok: true,
      user: username,
      session: token,
      expiresAt: new Date(exp * 1000).toISOString(),
    },
    200,
    cors
  );
}


async function handleLocalLogout(request, env, cors) {

  if (request.method !== "POST") {

    return json({ error: "Method not allowed" }, 405, cors);
  }

  const kv = localKv(env);

  if (!kv) {

    return json({ error: "Server not configured", code: "NO_KV" }, 503, cors);
  }

  let token = null;

  try {

    const body = await request.json();

    if (body && body.session && /^[0-9a-f]{64}$/.test(String(body.session).trim())) {

      token = String(body.session).trim();
    }

  } catch (_) {}
  // Logout never reveals whether the session existed.

  if (token) {

    try { await kv.delete(LOCAL_SESS_KEY_PREFIX + token); } catch (_) {}
  }

  return json({ ok: true }, 200, cors);
}


// ============================================================
// LOCAL CONTENT API (session-based, secrets stay server-side)
// ============================================================

async function handleLocalApi(request, url, env, cors) {

  if (request.method !== "GET") {

    return json({ error: "Method not allowed" }, 405, cors);
  }

  const sessionToken = localSessionTokenFromRequest(request, url);
  const checked = await localValidateSession(env, sessionToken);

  if (checked.error) {

    return json({ error: checked.error, code: checked.code }, checked.status, cors);
  }

  const main = localMainCreds(env);

  if (!main) {

    return json({ error: "Server not configured", code: "NO_MAIN" }, 503, cors);
  }

  const action = (url.searchParams.get("action") || "").trim();
  const extra = url.searchParams.get("extra") || "";

  if (!LOCAL_ALLOWED_ACTIONS.has(action)) {

    return json({ error: "Action not allowed", code: "BAD_ACTION" }, 403, cors);
  }

  const apiUrl = new URL("/player_api.php", main.host + "/");

  apiUrl.searchParams.set("username", main.user);
  apiUrl.searchParams.set("password", main.pass);
  apiUrl.searchParams.set("action", action);

  appendExtraParams(apiUrl, extra);

  const controller = new AbortController();
  const isHeavy = ["get_live_streams", "get_vod_streams", "get_series"].includes(action);
  const timeout = setTimeout(() => controller.abort(), isHeavy ? 90000 : 40000);

  try {

    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ar,en;q=0.9",
        "Referer": main.host + "/",
      },
    });

    let body = await response.text();

    if (action === "get_account_info") {

      body = localSanitizeAccountInfo(body);
    }

    return new Response(body, {
      status: response.status,
      headers: {
        ...cors,
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
      },
    });

  } catch (error) {

    return json(
      {
        error: "Local API fetch failed",
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
// LOCAL STREAM ENTRY (builds upstream URL server-side)
// ============================================================

async function handleLocalStream(request, url, env, cors) {

  if (request.method !== "GET" && request.method !== "HEAD") {

    return json({ error: "Method not allowed" }, 405, cors);
  }

  const sessionToken = localSessionTokenFromRequest(request, url);
  const checked = await localValidateSession(env, sessionToken);

  if (checked.error) {

    return json({ error: checked.error, code: checked.code }, checked.status, cors);
  }

  const main = localMainCreds(env);

  if (!main) {

    return json({ error: "Server not configured", code: "NO_MAIN" }, 503, cors);
  }

  const type = (url.searchParams.get("type") || "").trim().toLowerCase();
  const id = (url.searchParams.get("id") || "").trim();

  const mediaUrl = localBuildMediaUrl(main, type, id);

  if (!mediaUrl) {

    return json({ error: "Invalid type or id", code: "BAD_MEDIA" }, 400, cors);
  }

  let targetUrl;

  try {

    targetUrl = new URL(mediaUrl);

  } catch (_) {

    return json({ error: "Invalid media URL", code: "BAD_MEDIA" }, 400, cors);
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {

    return json({ error: "Unsupported protocol", code: "BAD_MEDIA" }, 403, cors);
  }

  if (/^\/live(?:\/|$)/i.test(targetUrl.pathname)) {

    return await handleLocalLive(request, targetUrl, sessionToken, new URL(request.url).origin, cors);
  }

  const isMovie = /^\/movie(?:\/|$)/i.test(targetUrl.pathname);
  const isSeries = /^\/series(?:\/|$)/i.test(targetUrl.pathname);

  if (!isMovie && !isSeries) {

    return json({ error: "Only movie and series media are allowed", code: "BAD_MEDIA" }, 403, cors);
  }

  const upstreamHeaders = buildUpstreamHeaders(request, targetUrl);

  try {

    const firstResponse = await fetch(targetUrl.toString(), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders,
      redirect: "manual",
      cache: "no-store",
    });

    if (firstResponse.status >= 200 && firstResponse.status < 300) {

      return makeBrowserResponse(firstResponse, request, cors);
    }

    if (firstResponse.status >= 300 && firstResponse.status < 400) {

      const location = firstResponse.headers.get("location");

      if (!location) {

        return json({ error: "Redirect without Location", code: "UPSTREAM_REDIRECT" }, 502, cors);
      }

      const redirectUrl = new URL(location, targetUrl.toString());

      if (!isIpAddress(redirectUrl.hostname)) {

        return await fetchHostnameRedirect(request, redirectUrl, upstreamHeaders, cors);
      }

      return await proxyIpWithSocket(request, redirectUrl, cors);
    }

    const errorText = await safeReadText(firstResponse);

    return new Response(errorText || ("Upstream HTTP " + firstResponse.status), {
      status: firstResponse.status,
      headers: {
        ...cors,
        "Content-Type": firstResponse.headers.get("content-type") || "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });

  } catch (error) {

    return json(
      {
        error: "Local stream failed",
        details: error?.message || String(error),
      },
      502,
      cors
    );
  }
}


// ============================================================
// LOCAL LIVE HLS (mirrors live flow, session-bound segments)
// ============================================================

async function handleLocalLive(request, targetUrl, sessionToken, workerOrigin, cors) {

  const upstreamHeaders = buildLiveUpstreamHeaders(request, targetUrl);

  let firstResponse;

  try {

    firstResponse = await fetch(targetUrl.toString(), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders,
      redirect: "manual",
      cache: "no-store",
    });

  } catch (error) {

    return json(
      {
        error: "Live provider request failed",
        details: error?.message || String(error),
      },
      502,
      cors
    );
  }

  if (firstResponse.status >= 200 && firstResponse.status < 300) {

    const playlist = await firstResponse.text();

    return rewriteLocalLivePlaylist(playlist, targetUrl, workerOrigin, sessionToken, cors);
  }

  if (firstResponse.status >= 300 && firstResponse.status < 400) {

    const location = firstResponse.headers.get("location");

    if (!location) {

      return json({ error: "Live redirect without Location", code: "UPSTREAM_REDIRECT" }, 502, cors);
    }

    const redirectUrl = new URL(location, targetUrl.toString());

    if (isIpAddress(redirectUrl.hostname)) {

      const result = await fetchLivePlaylistFromSocket(request, redirectUrl);

      if (!result) {

        return json({ error: "Could not retrieve live playlist", code: "UPSTREAM_PLAYLIST" }, 502, cors);
      }

      if (result.status < 200 || result.status >= 300) {

        return new Response(result.bodyText || ("Live upstream HTTP " + result.status), {
          status: result.status,
          headers: {
            ...cors,
            "Content-Type": result.headers.get("content-type") || "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      return rewriteLocalLivePlaylist(result.bodyText, redirectUrl, workerOrigin, sessionToken, cors);
    }

    try {

      const response = await fetch(redirectUrl.toString(), {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: upstreamHeaders,
        redirect: "manual",
        cache: "no-store",
      });

      if (response.status >= 200 && response.status < 300) {

        const playlist = await response.text();

        return rewriteLocalLivePlaylist(playlist, redirectUrl, workerOrigin, sessionToken, cors);
      }

      return new Response(await safeReadText(response), {
        status: response.status,
        headers: {
          ...cors,
          "Content-Type": response.headers.get("content-type") || "text/plain; charset=utf-8",
        },
      });

    } catch (error) {

      return json(
        {
          error: "Live hostname redirect failed",
          details: error?.message || String(error),
        },
        502,
        cors
      );
    }
  }

  return new Response(await safeReadText(firstResponse), {
    status: firstResponse.status,
    headers: {
      ...cors,
      "Content-Type": firstResponse.headers.get("content-type") || "text/plain; charset=utf-8",
    },
  });
}


// Same rewrite rules as rewriteLivePlaylist, but segments stay
// behind /local/seg with a valid session (never /stream).
function rewriteLocalLivePlaylist(playlist, playlistBaseUrl, workerOrigin, sessionToken, cors) {

  if (typeof playlist !== "string" || !playlist.includes("#EXTM3U")) {

    return new Response(playlist || "Invalid live playlist", {
      status: 502,
      headers: {
        ...cors,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const lines = playlist.split(/\r?\n/);
  const output = [];

  for (const line of lines) {

    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {

      output.push(line);
      continue;
    }

    try {

      const mediaUrl = new URL(trimmed, playlistBaseUrl.toString());

      output.push(
        workerOrigin +
        "/local/seg?session=" +
        sessionToken +
        "&u=" +
        encodeURIComponent(mediaUrl.toString())
      );

    } catch (_) {

      output.push(line);
    }
  }

  return new Response(output.join("\n"), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
    },
  });
}


// ============================================================
// LOCAL HLS SEGMENTS (session required on every request)
// ============================================================

async function handleLocalSeg(request, url, env, cors) {

  if (request.method !== "GET") {

    return json({ error: "Method not allowed" }, 405, cors);
  }

  const sessionToken = localSessionTokenFromRequest(request, url);
  const checked = await localValidateSession(env, sessionToken);

  if (checked.error) {

    return json({ error: checked.error, code: checked.code }, checked.status, cors);
  }

  const raw = (url.searchParams.get("u") || "").trim();

  if (!raw) {

    return json({ error: "Missing media reference", code: "BAD_SEG" }, 400, cors);
  }

  let targetUrl;

  try {

    targetUrl = new URL(raw);

  } catch (_) {

    return json({ error: "Invalid media reference", code: "BAD_SEG" }, 400, cors);
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {

    return json({ error: "Unsupported protocol", code: "BAD_SEG" }, 403, cors);
  }

  const hostname = targetUrl.hostname.toLowerCase();

  if (!isIpAddress(hostname) || !/^\/hls(?:\/|$)/i.test(targetUrl.pathname)) {

    return json({ error: "Segment not allowed", code: "BAD_SEG" }, 403, cors);
  }

  // Nested child playlists are re-fetched and re-written so
  // every hop keeps the session (and never the main creds).
  if (/\.m3u8(?:$|[?#])/i.test(targetUrl.pathname + targetUrl.search)) {

    const result = await fetchLivePlaylistFromSocket(request, targetUrl);

    if (!result) {

      return json({ error: "Could not retrieve playlist", code: "UPSTREAM_PLAYLIST" }, 502, cors);
    }

    if (result.status < 200 || result.status >= 300) {

      return new Response(result.bodyText || ("Upstream HTTP " + result.status), {
        status: result.status,
        headers: {
          ...cors,
          "Content-Type": result.headers.get("content-type") || "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return rewriteLocalLivePlaylist(
      result.bodyText,
      targetUrl,
      new URL(request.url).origin,
      sessionToken,
      cors
    );
  }

  return await proxyIpWithSocket(request, targetUrl, cors);
}


// ============================================================
// LOCAL ADMIN (ADMIN_TOKEN Bearer only, never in client code)
// ============================================================

async function handleLocalAdmin(request, url, env, cors) {

  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const provided = m ? m[1].trim() : "";
  const expected = env && env.ADMIN_TOKEN ? String(env.ADMIN_TOKEN) : "";

  if (!expected || !provided || !localTimingSafeEqual(provided, expected)) {

    return json({ error: "Unauthorized" }, 401, cors);
  }

  const kv = localKv(env);

  if (!kv) {

    return json({ error: "Server not configured", code: "NO_KV" }, 503, cors);
  }

  // ---- LIST ----
  if (request.method === "GET") {

    let listed = null;

    try {

      listed = await kv.list({ prefix: LOCAL_SUB_KEY_PREFIX });

    } catch (error) {

      return json({ error: "List failed", details: error?.message || String(error) }, 502, cors);
    }

    const out = [];

    for (const k of (listed && listed.keys) || []) {

      const sub = await localGetSub(kv, String(k.name).slice(LOCAL_SUB_KEY_PREFIX.length));

      if (sub) {

        out.push(localPublicSub(sub));
      }
    }

    out.sort((a, b) => String(a.username).localeCompare(String(b.username)));

    return json({ subscriptions: out }, 200, cors);
  }

  // ---- CREATE ----
  if (request.method === "POST") {

    let body = null;

    try {

      body = await request.json();

    } catch (_) {

      return json({ error: "Invalid JSON body" }, 400, cors);
    }

    const username = (body && body.username ? String(body.username) : "").trim();
    const password = body && body.password !== undefined ? String(body.password) : "";
    const active = body && body.active !== undefined ? body.active === true : true;
    const serverProfile = (body && body.serverProfile ? String(body.serverProfile) : "main").trim() || "main";

    if (!localValidUsername(username)) {

      return json({ error: "Invalid username", code: "BAD_INPUT" }, 400, cors);
    }

    if (typeof password !== "string" || password.length < 4 || password.length > 128) {

      return json({ error: "Invalid password", code: "BAD_INPUT" }, 400, cors);
    }

    const exists = await localGetSub(kv, username);

    if (exists) {

      return json({ error: "Subscription already exists", code: "EXISTS" }, 409, cors);
    }

    const range = localResolveDateRange(body, Date.now());

    if (!range) {

      return json({ error: "Invalid duration or dates", code: "BAD_INPUT" }, 400, cors);
    }

    const nowIso = new Date(Date.now()).toISOString();
    const pw = await localHashPassword(password);

    const sub = {
      username: username,
      pw: pw,
      startDate: range.startIso,
      endDate: range.endIso,
      active: active,
      serverProfile: serverProfile,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await kv.put(LOCAL_SUB_KEY_PREFIX + username, JSON.stringify(sub));

    return json({ ok: true, subscription: localPublicSub(sub) }, 200, cors);
  }

  // ---- UPDATE ----
  if (request.method === "PUT") {

    const username = (url.searchParams.get("user") || "").trim();

    if (!localValidUsername(username)) {

      return json({ error: "Invalid username", code: "BAD_INPUT" }, 400, cors);
    }

    const sub = await localGetSub(kv, username);

    if (!sub) {

      return json({ error: "Not found", code: "NOT_FOUND" }, 404, cors);
    }

    let body = null;

    try {

      body = await request.json();

    } catch (_) {

      return json({ error: "Invalid JSON body" }, 400, cors);
    }

    if (body && body.password !== undefined) {

      const npw = String(body.password);

      if (npw.length < 4 || npw.length > 128) {

        return json({ error: "Invalid password", code: "BAD_INPUT" }, 400, cors);
      }

      sub.pw = await localHashPassword(npw);
    }

    if (body && body.active !== undefined) {

      sub.active = body.active === true;
    }

    if (body && body.serverProfile !== undefined) {

      sub.serverProfile = String(body.serverProfile).trim() || "main";
    }

    if (body && (body.extendDuration || body.endDate || body.startDate)) {

      const base = Math.max(Date.now(), Date.parse(sub.endDate) || 0);
      const range = localResolveDateRange(body, base, true);

      if (!range) {

        return json({ error: "Invalid duration or dates", code: "BAD_INPUT" }, 400, cors);
      }

      if (body.startDate) {

        sub.startDate = range.startIso;
      }

      sub.endDate = range.endIso;
    }

    sub.updatedAt = new Date(Date.now()).toISOString();

    await kv.put(LOCAL_SUB_KEY_PREFIX + username, JSON.stringify(sub));

    return json({ ok: true, subscription: localPublicSub(sub) }, 200, cors);
  }

  // ---- DELETE (sessions auto-invalidate: sub lookup fails) ----
  if (request.method === "DELETE") {

    const username = (url.searchParams.get("user") || "").trim();

    if (!localValidUsername(username)) {

      return json({ error: "Invalid username", code: "BAD_INPUT" }, 400, cors);
    }

    const sub = await localGetSub(kv, username);

    if (!sub) {

      return json({ error: "Not found", code: "NOT_FOUND" }, 404, cors);
    }

    await kv.delete(LOCAL_SUB_KEY_PREFIX + username);

    return json({ ok: true }, 200, cors);
  }

  return json({ error: "Method not allowed" }, 405, cors);
}


// Resolves { startIso, endIso } from either a duration key
// ("24h" | "30d" | "90d" | "365d") or explicit ISO dates.
// When isExtend is true, duration is added to baseNow.
function localResolveDateRange(body, baseNow, isExtend) {

  try {

    const durKey = body && body.duration ? String(body.duration) : "";
    const secs = LOCAL_ADMIN_DURATIONS[durKey];

    if (secs) {

      const start = isExtend ? baseNow : Date.now();

      return {
        startIso: body && body.startDate ? new Date(body.startDate).toISOString() : new Date(start).toISOString(),
        endIso: new Date((isExtend ? baseNow : (body && body.startDate ? Date.parse(body.startDate) : Date.now())) + secs * 1000).toISOString(),
      };
    }

    if (body && body.startDate && body.endDate) {

      const s = Date.parse(body.startDate);
      const e = Date.parse(body.endDate);

      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {

        return null;
      }

      return { startIso: new Date(s).toISOString(), endIso: new Date(e).toISOString() };
    }

    return null;

  } catch (_) {

    return null;
  }
}
