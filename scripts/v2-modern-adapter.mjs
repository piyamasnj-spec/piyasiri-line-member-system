// Copied server-side into the isolated artifact. No credentials or network here.
export function modernHandler(handler, env = process.env) {
  return async request => {
    const reject = (status, message) => new Response(JSON.stringify({ ok: false, status: message }), {
      status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
    try {
      if (['FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'LINE_CHANNEL_ACCESS_TOKEN'].some(k => env[k])) {
        return reject(503, 'v1_environment_forbidden');
      }
      const url = new URL(request.url);
      const headers = Object.fromEntries(request.headers);
      // Never trust forwarded-host/origin headers as deployment identity.
      if (headers.host && headers.host !== url.host) return reject(403, 'origin_denied');
      headers.host = url.host;
      const query = Object.create(null);
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key)) return reject(400, 'duplicate_query_parameter');
        query[key] = value;
      }
      const chunks = []; let size = 0;
      if (request.body) {
        const reader = request.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 100_000) { await reader.cancel(); return reject(413, 'payload_too_large'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const result = await handler({ httpMethod: request.method, headers,
        queryStringParameters: query, body: Buffer.concat(chunks).toString('utf8'), isBase64Encoded: false });
      const outgoing = new Headers(result.headers || {});
      return new Response(result.body, { status: result.statusCode, headers: outgoing });
    } catch { return reject(503, 'service_unavailable'); }
  };
}
