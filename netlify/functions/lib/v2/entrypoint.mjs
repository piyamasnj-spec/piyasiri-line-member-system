import { createStore } from './firestore.mjs';
import { createRemoteTransport } from './remote.mjs';
import { createV2Handlers } from './handlers.mjs';
import { error, failure } from '../http.mjs';

// No eager initialization or network request during build/import. No V1 routing.
export function stagingHandler(operation) {
  let handlers;
  return async event => {
    try {
      if (!handlers) {
        const transport = createRemoteTransport();
        if (!process.env.ADMIN_PASSWORD_SALT || process.env.ADMIN_PASSWORD_SALT.length < 16 ||
            !/^[a-f0-9]{128}$/.test(process.env.ADMIN_PASSWORD_HASH || '') ||
            (process.env.ADMIN_SESSION_SECRET || '').length < 32 || (process.env.SHEET_SYNC_SECRET || '').length < 32) {
          throw error(503, 'v2_server_auth_not_configured');
        }
        const store = createStore({ namespace: transport.namespace, transport });
        handlers = createV2Handlers(store);
      }
      return await handlers[operation](event);
    } catch (e) { return failure(e); }
  };
}
