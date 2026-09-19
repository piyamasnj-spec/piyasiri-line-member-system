export const error = (statusCode, message) => Object.assign(new Error(message), {
  statusCode
});
export const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  },
  body: JSON.stringify(body)
});
export function bodyOf(event) {
  if (Buffer.byteLength(event.body || '') > 100_000) throw error(413, 'payload_too_large');
  try {
    const body = JSON.parse(event.body || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw 0;
    return body;
  } catch {
    throw error(400, 'invalid_json');
  }
}
export function failure(e) {
  return json(e.statusCode || 503, {
    ok: false,
    status: e.statusCode ? e.message : 'service_unavailable'
  });
}
export function header(event, name) {
  return Object.entries(event.headers || {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] || '';
}
export function key(value) {
  if (typeof value !== 'string' || !value || value.length > 160 || /[.#$\[\]/\u0000-\u001f\u007f]/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw error(400, 'invalid_id');
  return value;
}
export function number(value, {
  min = 0,
  integer = false
} = {}) {
  const n = Number(value);
  if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(n) || n < min || n > Number.MAX_SAFE_INTEGER || integer && !Number.isSafeInteger(n)) throw error(409, 'invalid_number');
  return n;
}
