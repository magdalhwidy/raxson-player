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

        "Pragma":
          "no-cache",
      },
    });

  } catch (err) {
    console.error("[API ERROR]", err);

    return json(
      {
        error: "Fetch failed",
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
// STREAM
// ============================================================

async function handleStream(request, url, cors) {
  const target =
    url.searchParams.get("url")?.trim();

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

    // ========================================================
    // HTTPS ALTERNATIVE
    // ========================================================

    let httpsTarget = null;

    if (parsed.protocol === "http:") {
      const httpsUrl = new URL(target);

      httpsUrl.protocol = "https:";

      if (httpsUrl.port === "80") {
        httpsUrl.port = "";
      }

      httpsTarget = httpsUrl.href;
    }


    // ========================================================
    // TRY HTTPS FIRST
    // ========================================================

    let result = null;
    let response = null;
    let finalUrl = null;

    if (httpsTarget) {

      console.log(
        "[STREAM] Trying HTTPS first:",
        httpsTarget
      );

      try {

        const httpsResult =
          await followRedirects(
            httpsTarget,
            method,
            headers
          );

        const httpsResponse =
          httpsResult.response;

        console.log(
          "[STREAM HTTPS FIRST RESULT]",
          {
            status:
              httpsResponse.status,

            finalUrl:
              httpsResult.finalUrl,

            contentType:
              httpsResponse.headers.get(
                "Content-Type"
              ),

            server:
              httpsResponse.headers.get(
                "Server"
              ),

            contentLength:
              httpsResponse.headers.get(
                "Content-Length"
              ),

            contentRange:
              httpsResponse.headers.get(
                "Content-Range"
              ),

            acceptRanges:
              httpsResponse.headers.get(
                "Accept-Ranges"
              ),
          }
        );


        /*
         * HTTPS is considered successful
         * only when it returns a 2xx response.
         */

        if (
          httpsResponse.status >= 200 &&
          httpsResponse.status < 300
        ) {

          result =
            httpsResult;

          response =
            httpsResponse;

          finalUrl =
            httpsResult.finalUrl;

          console.log(
            "[STREAM] HTTPS succeeded."
          );

        } else {

          console.log(
            "[STREAM] HTTPS did not return 2xx."
          );

          console.log(
            "[STREAM] Trying original HTTP."
          );
        }

      } catch (err) {

        console.error(
          "[STREAM HTTPS FIRST ERROR]",
          err?.message ||
            String(err)
        );

        console.log(
          "[STREAM] Falling back to original HTTP."
        );
      }
    }


    // ========================================================
    // ORIGINAL HTTP FALLBACK
    // ========================================================

    if (!response) {

      console.log(
        "[STREAM] Trying original URL:",
        target
      );

      result =
        await followRedirects(
          target,
          method,
          headers
        );

      response =
        result.response;

      finalUrl =
        result.finalUrl;

      console.log(
        "[STREAM HTTP RESULT]",
        {
          status:
            response.status,

          finalUrl,

          contentType:
            response.headers.get(
              "Content-Type"
            ),

          server:
            response.headers.get(
              "Server"
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
        }
      );
    }


    // ========================================================
    // M3U8 DETECTION
    // ========================================================

    const contentType =
      response.headers.get(
        "Content-Type"
      ) || "";

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
          status:
            response.status,

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

    for (
      const name of copyHeaders
    ) {

      const value =
        response.headers.get(
          name
        );

      if (value) {
        responseHeaders[name] =
          value;
      }
    }

    if (
      response.status === 206 &&
      !responseHeaders["Accept-Ranges"]
    ) {

      responseHeaders[
        "Accept-Ranges"
      ] = "bytes";
    }


    /*
     * IMPORTANT:
     *
     * Never call response.text()
     * or arrayBuffer() for video.
     *
     * Pass the upstream ReadableStream
     * directly to the client.
     */

    return new Response(
      response.body,
      {
        status:
          response.status,

        statusText:
          response.statusText,

        headers:
          responseHeaders,
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
        error:
          "Stream failed",

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
  let current =
    initialUrl;

  const maxRedirects = 5;

  for (
    let attempt = 0;
    attempt <= maxRedirects;
    attempt++
  ) {

    console.log(
      "[UPSTREAM]",
      {
        attempt:
          attempt + 1,

        url:
          current,
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

          redirect:
            "manual",

          cache:
            "no-store",
        }
      );


    if (
      !isRedirect(
        response.status
      )
    ) {

      return {
        response,

        finalUrl:
          current,
      };
    }


    const location =
      response.headers.get(
        "Location"
      );

    console.log(
      "[REDIRECT]",
      {
        status:
          response.status,

        from:
          current,

        location,
      }
    );


    if (!location) {

      return {
        response,

        finalUrl:
          current,
      };
    }


    if (
      attempt >= maxRedirects
    ) {

      return {
        response,

        finalUrl:
          current,
      };
    }


    /*
     * Resolve relative Location
     * correctly.
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

  for (
    const originalLine of lines
  ) {

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
      toProxyUrl(
        resolved
      )
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
    request.headers.get(
      "Range"
    );


  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",

    "Accept":
      "*/*",

    "Referer":
      "http://barqtv.website/",
  };


  if (range) {
    headers["Range"] =
      range;
  }


  /*
   * IMPORTANT:
   *
   * This debug function does NOT use
   * followRedirects().
   *
   * It follows every redirect manually
   * so we can see every individual hop.
   */

  const hops = [];

  let current =
    target;

  const maxRedirects = 5;


  try {

    for (
      let attempt = 0;
      attempt <= maxRedirects;
      attempt++
    ) {

      let currentUrl;

      try {
        currentUrl =
          new URL(current);
      } catch {
        break;
      }


      const response =
        await fetch(
          current,
          {
            method: "GET",

            headers: {
              ...headers,
            },

            redirect:
              "manual",

            cache:
              "no-store",
          }
        );


      const location =
        response.headers.get(
          "Location"
        );


      let locationHost =
        null;

      let locationProtocol =
        null;

      let resolvedLocation =
        null;


      if (location) {

        try {

          const resolved =
            new URL(
              location,
              current
            );

          resolvedLocation =
            resolved.href;

          locationHost =
            resolved.hostname;

          locationProtocol =
            resolved.protocol;

        } catch {

          resolvedLocation =
            location;
        }
      }


      /*
       * Diagnostic body.
       *
       * Only read a tiny amount.
       */

      let bodyPreview =
        "";


      if (
        !location &&
        response.body
      ) {

        try {

          const reader =
            response.body.getReader();

          const decoder =
            new TextDecoder();

          const {
            value
          } =
            await reader.read();


          if (value) {

            bodyPreview =
              decoder
                .decode(value)
                .slice(
                  0,
                  4096
                );
          }


          try {
            await reader.cancel();
          } catch {}

        } catch (err) {

          bodyPreview =
            "[body read failed] " +
            (
              err?.message ||
              String(err)
            );
        }
      }


      /*
       * Save every redirect hop.
       */

      hops.push(
        {
          attempt:
            attempt + 1,

          requestUrl:
            current,

          requestHost:
            currentUrl.hostname,

          requestProtocol:
            currentUrl.protocol,

          requestPort:
            currentUrl.port ||
            (
              currentUrl.protocol ===
              "https:"
                ? "443"
                : "80"
            ),

          status:
            response.status,

          statusText:
            response.statusText,

          location:
            location || null,

          resolvedLocation,

          locationHost,

          locationProtocol,

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

          server:
            response.headers.get(
              "Server"
            ),

          via:
            response.headers.get(
              "Via"
            ),

          cfRay:
            response.headers.get(
              "CF-Ray"
            ),

          cfCacheStatus:
            response.headers.get(
              "CF-Cache-Status"
            ),

          cacheControl:
            response.headers.get(
              "Cache-Control"
            ),

          wwwAuthenticate:
            response.headers.get(
              "WWW-Authenticate"
            ),

          bodyPreview,
        }
      );


      /*
       * Not a redirect:
       * this is the final response.
       */

      if (
        !isRedirect(
          response.status
        ) ||
        !location
      ) {

        break;
      }


      /*
       * Resolve the next URL.
       */

      current =
        new URL(
          location,
          current
        ).href;
    }


    const finalHop =
      hops.length
        ? hops[hops.length - 1]
        : null;


    /*
     * Determine whether a redirect
     * went directly to an IP address.
     */

    const redirectedToIp =
      hops.some(
        hop =>
          hop.locationHost &&
          isIpAddress(
            hop.locationHost
          )
      );


    /*
     * Determine whether the final
     * response is Cloudflare 1003.
     */

    const finalBody =
      finalHop?.bodyPreview ||
      "";


    const finalIsCloudflare1003 =
      finalHop?.status === 403 &&
      (
        finalBody.includes(
          "1003"
        ) ||
        finalBody.includes(
          "Direct IP Access Not Allowed"
        )
      );


    /*
     * Determine whether the request
     * was redirected at all.
     */

    const redirected =
      hops.some(
        hop =>
          !!hop.location
      );


    return json(
      {

        test:
          "redirect-diagnostic",


        request: {

          url:
            target,

          protocol:
            parsed.protocol,

          hostname:
            parsed.hostname,

          port:
            parsed.port ||
            (
              parsed.protocol ===
              "https:"
                ? "443"
                : "80"
            ),

          range:
            range || null,
        },


        redirectCount:
          Math.max(
            0,
            hops.length - 1
          ),


        redirected,


        hops,


        final: {

          url:
            finalHop?.requestUrl ||
            null,

          host:
            finalHop?.requestHost ||
            null,

          protocol:
            finalHop?.requestProtocol ||
            null,

          status:
            finalHop?.status ??
            null,

          statusText:
            finalHop?.statusText ??
            null,

          server:
            finalHop?.server ??
            null,

          contentType:
            finalHop?.contentType ??
            null,

          contentLength:
            finalHop?.contentLength ??
            null,

          contentRange:
            finalHop?.contentRange ??
            null,

          acceptRanges:
            finalHop?.acceptRanges ??
            null,

          bodyPreview:
            finalBody,
        },


        diagnosis: {

          reachedFinalResponse:
            !!finalHop,

          redirectedToIp,

          finalIsCloudflare1003,

          finalServerIsCloudflare:
            (
              finalHop?.server ||
              ""
            ).toLowerCase()
              .includes(
                "cloudflare"
              ),

          finalHost:
            finalHop?.requestHost ||
            null,

          redirectChain:
            hops.map(
              hop => ({
                status:
                  hop.status,

                from:
                  hop.requestUrl,

                to:
                  hop.resolvedLocation ||
                  null,

                toHost:
                  hop.locationHost ||
                  null,
              })
            ),
        },
      },

      200,

      cors
    );


  } catch (err) {

    console.error(
      "[DEBUG ERROR]",
      {
        url:
          target,

        error:
          err?.message ||
          String(err),

        hops,
      }
    );


    return json(
      {

        error:
          "Debug fetch failed",

        details:
          err?.message ||
          String(err),

        url:
          target,

        hops,

      },

      502,

      cors
    );
  }
}


// ============================================================
// IP CHECK
// ============================================================

function isIpAddress(
  hostname
) {

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
   *
   * Basic detection.
   */

  if (
    hostname.includes(":")
  ) {

    return true;
  }


  return false;
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
