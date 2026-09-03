export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, Range, Accept',
      'Access-Control-Allow-Methods':
        'GET, HEAD, OPTIONS',
      'Access-Control-Expose-Headers':
        'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, Content-Disposition',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      // API
      if (pathname === '/api') {
        return await handleApi(
          url,
          request,
          corsHeaders
        );
      }

      // STREAM / VOD / LIVE / HLS
      if (pathname === '/stream') {
        return await handleStream(
          url,
          request,
          corsHeaders
        );
      }

      // Cloudflare Pages static files
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response(
        'Not Found',
        {
          status: 404,
          headers: corsHeaders
        }
      );

    } catch (err) {
      console.error(
        '[Worker Error]',
        err
      );

      return jsonResponse(
        {
          error: 'Worker Error',
          details:
            err?.message ||
            String(err)
        },
        500,
        corsHeaders
      );
    }
  }
};


/* =========================================================
   API
========================================================= */

async function handleApi(
  url,
  request,
  corsHeaders
) {
  const host =
    url.searchParams
      .get('host')
      ?.trim() || '';

  const user =
    url.searchParams
      .get('user')
      ?.trim() || '';

  const pwd =
    url.searchParams
      .get('pass')
      ?.trim() || '';

  const action =
    url.searchParams
      .get('action')
      ?.trim() || '';

  const extra =
    url.searchParams
      .get('extra') || '';

  if (
    !host ||
    !user ||
    !pwd ||
    !action
  ) {
    return jsonResponse(
      {
        error: 'Missing parameters'
      },
      400,
      corsHeaders
    );
  }

  const cleanHost =
    host.endsWith('/')
      ? host.slice(0, -1)
      : host;

  /*
   * Keep the same API behavior as the old
   * working Vercel backend.
   */
  const targetUrl =
    `${cleanHost}/player_api.php` +
    `?username=${encodeURIComponent(user)}` +
    `&password=${encodeURIComponent(pwd)}` +
    `&action=${encodeURIComponent(action)}` +
    `${extra}`;

  console.log(
    '[API]',
    action,
    'host=',
    cleanHost
  );

  const heavyActions = [
    'get_live_streams',
    'get_vod_streams',
    'get_series'
  ];

  const timeout =
    heavyActions.includes(action)
      ? 90000
      : 40000;

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeout
    );

  try {

    /*
     * IMPORTANT:
     *
     * No Origin header here.
     *
     * This matches the old Vercel backend.
     */
    const resp =
      await fetch(
        targetUrl,
        {
          method: 'GET',

          headers: {
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0',

            'Accept':
              'application/json, text/plain, */*',

            'Accept-Language':
              'ar,en;q=0.9',

            'Referer':
              'http://barqtv.website/'
          },

          signal:
            controller.signal,

          /*
           * Keep normal HTTP redirect behavior.
           */
          redirect: 'follow'
        }
      );

    clearTimeout(timer);

    console.log(
      '[API]',
      action,
      'status=',
      resp.status,
      'final-url=',
      resp.url
    );

    const body =
      await resp.text();

    return new Response(
      body,
      {
        status: resp.status,

        headers: {
          ...corsHeaders,

          'Content-Type':
            resp.headers.get(
              'Content-Type'
            ) ||
            'application/json',

          'Cache-Control':
            'no-cache, no-store, must-revalidate'
        }
      }
    );

  } catch (err) {

    clearTimeout(timer);

    console.error(
      '[API Error]',
      action,
      err?.message ||
        String(err)
    );

    return jsonResponse(
      {
        error: 'Fetch failed',
        details:
          err?.message ||
          String(err),
        url: targetUrl
      },
      502,
      corsHeaders
    );
  }
}


/* =========================================================
   STREAM
   LIVE / VOD / MP4 / TS / M3U8
========================================================= */

async function handleStream(
  url,
  request,
  corsHeaders
) {
  const targetUrl =
    url.searchParams
      .get('url')
      ?.trim() || '';

  if (!targetUrl) {
    return jsonResponse(
      {
        error:
          'Missing url parameter'
      },
      400,
      corsHeaders
    );
  }

  /*
   * Validate URL.
   */
  let parsedTarget;

  try {

    parsedTarget =
      new URL(targetUrl);

    if (
      parsedTarget.protocol !==
        'http:' &&
      parsedTarget.protocol !==
        'https:'
    ) {
      return jsonResponse(
        {
          error:
            'Invalid URL scheme'
        },
        400,
        corsHeaders
      );
    }

  } catch {

    return jsonResponse(
      {
        error:
          'Invalid URL'
      },
      400,
      corsHeaders
    );
  }


  /*
   * =======================================================
   * Headers
   *
   * IMPORTANT:
   *
   * These intentionally match the working Vercel
   * stream_proxy() implementation.
   *
   * We DO NOT send Origin.
   * =======================================================
   */

  const upstreamHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0',

    'Accept':
      '*/*',

    'Referer':
      'http://barqtv.website/'
  };


  /*
   * =======================================================
   * RANGE
   *
   * Critical for MP4/VOD seeking.
   *
   * Example:
   *
   * Range: bytes=0-
   * Range: bytes=5000000-
   * =======================================================
   */

  const rangeHeader =
    request.headers.get(
      'Range'
    );

  if (rangeHeader) {

    upstreamHeaders['Range'] =
      rangeHeader;

    console.log(
      '[STREAM] Range=',
      rangeHeader
    );
  }


  console.log(
    '[STREAM] request=',
    targetUrl.substring(0, 300)
  );


  try {

    /*
     * =====================================================
     * Fetch with controlled redirects.
     *
     * We manually follow redirects so that we know:
     *
     * 1. Original URL
     * 2. Redirect URL
     * 3. Final URL
     * 4. Status returned by final server
     *
     * Maximum 5 redirects.
     * =====================================================
     */

    const result =
      await fetchWithRedirects(
        targetUrl,
        request.method === 'HEAD'
          ? 'HEAD'
          : 'GET',
        upstreamHeaders
      );

    const resp =
      result.response;

    const finalUrl =
      result.finalUrl;

    /*
     * =====================================================
     * Detailed diagnostics
     * =====================================================
     */

    const contentType =
      resp.headers.get(
        'Content-Type'
      ) || '';

    const contentLength =
      resp.headers.get(
        'Content-Length'
      );

    const contentRange =
      resp.headers.get(
        'Content-Range'
      );

    const acceptRanges =
      resp.headers.get(
        'Accept-Ranges'
      );

    const location =
      resp.headers.get(
        'Location'
      );

    console.log(
      '[STREAM RESULT]',
      JSON.stringify({
        status:
          resp.status,

        originalUrl:
          targetUrl,

        finalUrl:
          finalUrl,

        redirected:
          finalUrl !== targetUrl,

        contentType:
          contentType,

        contentLength:
          contentLength,

        contentRange:
          contentRange,

        acceptRanges:
          acceptRanges,

        location:
          location,

        requestedRange:
          rangeHeader || null
      })
    );


    /*
     * =====================================================
     * M3U8
     *
     * Playlist must be read as text because we need
     * to rewrite its internal URLs.
     * =====================================================
     */

    const lowerType =
      contentType.toLowerCase();

    const lowerFinalUrl =
      finalUrl.toLowerCase();

    const isM3U8 =
      lowerType.includes(
        'mpegurl'
      ) ||

      lowerType.includes(
        'm3u8'
      ) ||

      lowerFinalUrl.endsWith(
        '.m3u8'
      ) ||

      lowerFinalUrl.endsWith(
        '.m3u'
      );


    /*
     * Only rewrite successful playlist responses.
     */
    if (
      isM3U8 &&
      resp.status >= 200 &&
      resp.status < 300
    ) {

      const text =
        await resp.text();

      const rewritten =
        rewriteM3U8(
          text,
          finalUrl
        );

      return new Response(
        rewritten,
        {
          status: resp.status,

          headers: {
            ...corsHeaders,

            'Content-Type':
              'application/vnd.apple.mpegurl',

            'Cache-Control':
              'no-cache, no-store, must-revalidate',

            'Pragma':
              'no-cache'
          }
        }
      );
    }


    /*
     * =====================================================
     * BINARY STREAM
     *
     * MP4
     * TS
     * MPEG
     * AAC
     * etc.
     *
     * DO NOT:
     *
     * await resp.text()
     * await resp.arrayBuffer()
     * await resp.blob()
     *
     * We pass resp.body directly.
     * =====================================================
     */

    const responseHeaders = {
      ...corsHeaders,

      'Content-Type':
        contentType ||
        'application/octet-stream',

      'Cache-Control':
        'no-cache, no-store, must-revalidate',

      'Pragma':
        'no-cache'
    };


    /*
     * Headers required by HTML5 video,
     * seeking and partial content.
     */

    const passHeaders = [
      'Content-Length',
      'Content-Range',
      'Accept-Ranges',
      'Last-Modified',
      'ETag',
      'Content-Disposition',
      'Expires',
      'Vary'
    ];


    for (
      const headerName
      of passHeaders
    ) {

      const value =
        resp.headers.get(
          headerName
        );

      if (value) {

        responseHeaders[
          headerName
        ] = value;
      }
    }


    /*
     * If the upstream supports byte ranges,
     * explicitly expose it.
     *
     * We do NOT change the upstream status.
     */

    if (
      !responseHeaders[
        'Accept-Ranges'
      ]
    ) {

      if (
        resp.status === 206
      ) {

        responseHeaders[
          'Accept-Ranges'
        ] = 'bytes';
      }
    }


    /*
     * =====================================================
     * CRITICAL:
     *
     * Preserve upstream status.
     *
     * 200 = normal response
     * 206 = Partial Content
     * 403 = Forbidden
     * 404 = Not Found
     * 416 = Range Not Satisfiable
     *
     * And pass the stream directly.
     * =====================================================
     */

    return new Response(
      resp.body,
      {
        status:
          resp.status,

        headers:
          responseHeaders
      }
    );

  } catch (err) {

    console.error(
      '[STREAM ERROR]',
      JSON.stringify({
        url:
          targetUrl,

        error:
          err?.message ||
          String(err)
      })
    );

    return jsonResponse(
      {
        error:
          'Stream failed',

        details:
          err?.message ||
          String(err),

        url:
          targetUrl
      },
      502,
      corsHeaders
    );
  }
}


/* =========================================================
   FETCH WITH REDIRECTS
========================================================= */

async function fetchWithRedirects(
  initialUrl,
  method,
  headers
) {
  let currentUrl =
    initialUrl;

  const maxRedirects = 5;

  for (
    let i = 0;
    i <= maxRedirects;
    i++
  ) {

    console.log(
      '[STREAM FETCH]',
      i + 1,
      currentUrl.substring(0, 300)
    );


    const response =
      await fetch(
        currentUrl,
        {
          method,

          headers: {
            ...headers
          },

          /*
           * Manual redirect handling.
           */
          redirect: 'manual'
        }
      );


    /*
     * Not a redirect.
     */
    if (
      !isRedirectStatus(
        response.status
      )
    ) {

      return {
        response,
        finalUrl:
          currentUrl
      };
    }


    /*
     * Redirect response.
     */
    const location =
      response.headers.get(
        'Location'
      );


    console.log(
      '[STREAM REDIRECT]',
      JSON.stringify({
        status:
          response.status,

        from:
          currentUrl,

        location:
          location
      })
    );


    /*
     * Redirect without Location.
     */
    if (!location) {

      return {
        response,
        finalUrl:
          currentUrl
      };
    }


    /*
     * Too many redirects.
     */
    if (
      i >= maxRedirects
    ) {

      console.error(
        '[STREAM] Too many redirects'
      );

      return {
        response,
        finalUrl:
          currentUrl
      };
    }


    /*
     * Resolve relative Location headers correctly.
     *
     * Example:
     *
     * Location: /movie/file.mp4
     *
     * becomes:
     *
     * https://domain.com/movie/file.mp4
     */

    currentUrl =
      new URL(
        location,
        currentUrl
      ).href;


    /*
     * Continue with the SAME headers.
     *
     * This keeps:
     *
     * User-Agent
     * Accept
     * Referer
     * Range
     *
     * on the redirected request.
     */

  }


  throw new Error(
    'Redirect handling failed'
  );
}


/* =========================================================
   REDIRECT STATUS
========================================================= */

function isRedirectStatus(
  status
) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}


/* =========================================================
   M3U8 REWRITE
========================================================= */

function rewriteM3U8(
  text,
  baseUrl
) {
  const lines =
    text.split('\n');

  const out = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    let line =
      lines[i];


    /*
     * HLS tags.
     */
    if (
      line.startsWith('#')
    ) {

      line =
        rewriteUriInTag(
          line,
          baseUrl
        );

      out.push(line);

      continue;
    }


    const trimmed =
      line.trim();


    /*
     * Empty line.
     */
    if (!trimmed) {

      out.push(line);

      continue;
    }


    /*
     * Segment / playlist URL.
     */
    const resolved =
      resolveUrl(
        trimmed,
        baseUrl
      );


    out.push(
      proxyUrl(
        resolved
      )
    );
  }


  return out.join('\n');
}


/* =========================================================
   M3U8 URI TAG
========================================================= */

function rewriteUriInTag(
  line,
  baseUrl
) {
  return line.replace(
    /URI="([^"]+)"/g,
    (match, uri) => {

      /*
       * Do not modify data/skd URIs.
       */
      if (
        uri.startsWith(
          'data:'
        ) ||
        uri.startsWith(
          'skd:'
        )
      ) {
        return match;
      }


      const resolved =
        resolveUrl(
          uri,
          baseUrl
        );


      return (
        `URI="${proxyUrl(resolved)}"`
      );
    }
  );
}


/* =========================================================
   RESOLVE URL
========================================================= */

function resolveUrl(
  url,
  base
) {
  /*
   * Absolute URL.
   */
  if (
    url.startsWith(
      'http://'
    ) ||
    url.startsWith(
      'https://'
    )
  ) {
    return url;
  }


  /*
   * Relative URL.
   */
  try {

    return new URL(
      url,
      base
    ).href;

  } catch {

    return url;
  }
}


/* =========================================================
   PROXY URL
========================================================= */

function proxyUrl(
  url
) {
  return (
    '/stream?url=' +
    encodeURIComponent(url)
  );
}


/* =========================================================
   JSON RESPONSE
========================================================= */

function jsonResponse(
  data,
  status,
  corsHeaders
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        ...corsHeaders,

        'Content-Type':
          'application/json; charset=utf-8',

        'Cache-Control':
          'no-cache, no-store, must-revalidate',

        'Pragma':
          'no-cache'
      }
    }
  );
}
