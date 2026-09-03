export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    try {
      if (pathname === '/api') {
        return await handleApi(url, request, corsHeaders);
      }

      if (pathname === '/stream') {
        return await handleStream(url, request, corsHeaders);
      }

      if (env.ASSETS) {
        let response = await env.ASSETS.fetch(request);
        if (response.status === 404) {
          return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
        }
        return response;
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });

    } catch (err) {
      console.error('[Worker Error]', err);
      return jsonResponse({
        error: 'Worker Error',
        details: err.message,
        stack: err.stack
      }, 500, corsHeaders);
    }
  }
};

async function handleApi(url, request, corsHeaders) {
  const host   = url.searchParams.get('host')?.trim()   || '';
  const user   = url.searchParams.get('user')?.trim()   || '';
  const pwd    = url.searchParams.get('pass')?.trim()   || '';
  const action = url.searchParams.get('action')?.trim() || '';
  const extra  = url.searchParams.get('extra')          || '';

  if (!host || !user || !pwd || !action) {
    return jsonResponse({ error: 'Missing parameters' }, 400, corsHeaders);
  }

  const cleanHost = host.endsWith('/') ? host.slice(0, -1) : host;
  const targetUrl = `${cleanHost}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pwd)}&action=${encodeURIComponent(action)}${extra}`;

  console.log('[API]', action, 'host=', cleanHost);

  const heavy = ['get_live_streams', 'get_vod_streams', 'get_series'].includes(action);
  const timeout = heavy ? 90000 : 40000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ar,en;q=0.9',
        'Referer': 'http://barqtv.website/'
      },
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timer);
    console.log('[API]', action, 'status=', resp.status, 'final-url=', resp.url);

    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        ...corsHeaders,
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });

  } catch (err) {
    clearTimeout(timer);
    console.error('[API Error]', action, err.message);
    return jsonResponse({
      error: 'Fetch failed',
      details: err.message,
      url: targetUrl
    }, 502, corsHeaders);
  }
}

async function handleStream(url, request, corsHeaders) {
  const targetUrl = url.searchParams.get('url')?.trim() || '';

  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, 400, corsHeaders);
  }

  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    return jsonResponse({ error: 'Invalid URL scheme' }, 400, corsHeaders);
  }

  console.log('[Stream] url=', targetUrl.substring(0, 120));

  // استخراج النطاق الأصلي للسيرفر لاستخدامه ديناميكياً وتفادي خطأ 403 Forbidden
  let refererVal = 'http://barqtv.website/';
  try {
    const parsedTarget = new URL(targetUrl);
    refererVal = `${parsedTarget.protocol}//${parsedTarget.host}/`;
  } catch (e) {}

  const headers = {
    'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0',
    'Accept': '*/*',
    'Accept-Language': 'ar,en;q=0.9',
    'Referer': refererVal,
    'Origin': refererVal.slice(0, -1)
  };

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    headers['Range'] = rangeHeader;
  }

  try {
    const resp = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'follow'
    });

    const contentType = resp.headers.get('Content-Type') || '';
    const finalUrl = resp.url;

    console.log('[Stream] status=', resp.status, 'ctype=', contentType, 'final=', finalUrl.substring(0, 120));

    const isM3U8 = contentType.toLowerCase().includes('mpegurl') ||
                   contentType.toLowerCase().includes('m3u8') ||
                   targetUrl.toLowerCase().endsWith('.m3u8') ||
                   targetUrl.toLowerCase().endsWith('.m3u');

    if (isM3U8 && resp.status === 200) {
      const text = await resp.text();
      const rewritten = rewriteM3U8(text, finalUrl);

      return new Response(rewritten, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }

    const responseHeaders = {
      ...corsHeaders,
      'Content-Type': contentType || 'application/octet-stream',
      'Accept-Ranges': 'bytes'
    };

    const passHeaders = ['Content-Length', 'Content-Range', 'Last-Modified', 'ETag'];
    for (const h of passHeaders) {
      const val = resp.headers.get(h);
      if (val) responseHeaders[h] = val;
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: responseHeaders
    });

  } catch (err) {
    console.error('[Stream Error]', targetUrl, err.message);
    return jsonResponse({
      error: 'Stream failed',
      details: err.message,
      url: targetUrl
    }, 502, corsHeaders);
  }
}

function rewriteM3U8(text, baseUrl) {
  const lines = text.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith('#')) {
      line = rewriteUriInTag(line, baseUrl);
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    const resolved = resolveUrl(trimmed, baseUrl);
    out.push(proxyUrl(resolved));
  }

  return out.join('\n');
}

function rewriteUriInTag(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/g, (match, uri) => {
    if (uri.startsWith('data:') || uri.startsWith('skd:')) {
      return match;
    }
    const resolved = resolveUrl(uri, baseUrl);
    return `URI="${proxyUrl(resolved)}"`;
  });
}

function resolveUrl(url, base) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function proxyUrl(url) {
  return '/stream?url=' + encodeURIComponent(url);
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
