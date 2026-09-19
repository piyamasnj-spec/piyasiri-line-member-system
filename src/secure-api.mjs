export function createApi({
  fetcher = fetch,
  token = () => '',
  storage,
  uuid = () => crypto.randomUUID()
} = {}) {
  const active = new Map();
  async function request(endpoint, {
    body,
    admin = false,
    method = body === undefined ? 'GET' : 'POST'
  } = {}) {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (!admin) {
      const accessToken = token();
      if (!accessToken) throw Object.assign(new Error('กรุณาเข้าสู่ระบบ LINE อีกครั้ง'), {
        status: 401
      });
      headers.Authorization = `Bearer ${accessToken}`;
    }
    const response = await fetcher(`/.netlify/functions/${endpoint}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : {
        body: JSON.stringify(body)
      })
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw Object.assign(new Error(result.status || 'บันทึกไม่สำเร็จ'), {
      status: response.status
    });
    return result;
  }
  function mutate(endpoint, body, {
    scope,
    admin = false,
    afterSuccess = async () => {}
  } = {}) {
    const storageKey = `member-operation:${scope}:${endpoint}:${JSON.stringify(body)}`;
    if (active.has(storageKey)) return active.get(storageKey);
    const run = (async () => {
      let operationId = storage.getItem(storageKey);
      if (!operationId) {
        operationId = uuid();
        storage.setItem(storageKey, operationId);
      }
      try {
        const result = await request(endpoint, {
          body: {
            ...body,
            operationId
          },
          admin
        });
        await afterSuccess(result);
        storage.removeItem(storageKey);
        return result;
      } catch (e) {
        // Unknown network/5xx outcomes retain the same key through reload/retry.
        if ([400, 403, 404, 409, 422].includes(e.status)) storage.removeItem(storageKey);
        throw e;
      }
    })().finally(() => active.delete(storageKey));
    active.set(storageKey, run);
    return run;
  }
  return {
    request,
    mutate
  };
}
