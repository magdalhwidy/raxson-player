export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    // ===== /health =====
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'raxson-player' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ===== /api =====
    if (url.pathname === '/api') {
      const host = (url.searchParams.get('host') || '').trim();
      const user = (url.searchParams.get('user') || '').trim();
      const pwd = (url.searchParams.get('pass') || '').trim();
      const action = (url.searchParams.get('action') || '').trim();
      const extra = url.searchParams.get('extra') || '';

      if (!host || !user || !pwd || !action) {
        return new Response(
          JSON.stringify({ error: 'Missing parameters' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const cleanHost = host.endsWith('/') ? host.slice(0, -1) : host;
      const apiUrl = `${cleanHost}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pwd)}&action=${encodeURIComponent(action)}${extra}`;
      const timeout = action === 'get_live_streams' ? 60000 : 35000;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const resp = await fetch(apiUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ar,en;q=0.9',
            'Referer': 'http://barqtv.website/'
          }
        });

        clearTimeout(timer);
        const contentType = resp.headers.get('Content-Type') || '';
        let data;

        if (contentType.includes('application/json')) {
          data = await resp.json();
        } else {
          const text = await resp.text();
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
        }

        return new Response(
          JSON.stringify(data),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

      } catch (err) {
        if (err.name === 'AbortError') {
          return new Response(
            JSON.stringify({ error: 'Request timeout' }),
            { status: 504, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ error: 'Failed to fetch', details: err.message }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ===== /stream =====
    if (url.pathname === '/stream') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return new Response(
          JSON.stringify({ error: 'Missing url parameter' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Accept': '*/*',
        'Referer': 'http://barqtv.website/'
      };

      const rangeHeader = request.headers.get('Range');
      if (rangeHeader) headers['Range'] = rangeHeader;

      try {
        const resp = await fetch(targetUrl, { headers, redirect: 'follow' });
        const contentType = resp.headers.get('Content-Type') || '';

        const isM3U8 = contentType.toLowerCase().includes('mpegurl') ||
                       targetUrl.toLowerCase().endsWith('.m3u8') ||
                       targetUrl.toLowerCase().endsWith('.m3u');

        if (isM3U8) {
          const text = await resp.text();
          const basePath = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

          const newLines = text.split('\n').map(line => {
            const s = line.trim();
            if (!s || s.startsWith('#')) return line;
            if (s.startsWith('http')) return '/stream?url=' + encodeURIComponent(s);
            try {
              const resolved = new URL(s, basePath).href;
              return '/stream?url=' + encodeURIComponent(resolved);
            } catch { return line; }
          });

          return new Response(newLines.join('\n'), {
            headers: {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
          });
        }

        const responseHeaders = new Headers();
        for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified', 'ETag']) {
          const v = resp.headers.get(h);
          if (v) responseHeaders.set(h, v);
        }
        responseHeaders.set('Access-Control-Allow-Origin', '*');

        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: responseHeaders
        });

      } catch (err) {
        return new Response(
          JSON.stringify({ error: 'Stream failed', details: err.message }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ===== الملفات الثابتة (index.html, sw.js, logo1.png, images...) =====
    const assetResponse = await env.ASSETS.fetch(request);

    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js') {
      const newHeaders = new Headers(assetResponse.headers);
      newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (url.pathname === '/sw.js') {
        newHeaders.set('Service-Worker-Allowed', '/');
      }
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        headers: newHeaders
      });
    }

    return assetResponse;
  }
};
