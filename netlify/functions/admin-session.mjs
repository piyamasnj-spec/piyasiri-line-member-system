import { adminAuth, login, sessionCookie } from './lib/auth.mjs';
import { transaction } from './lib/firebase-rest.mjs';
import { json, bodyOf, failure, error } from './lib/http.mjs';
export function createAdminSessionHandler({
  authenticate = adminAuth,
  signIn = login,
  tx = transaction
} = {}) {
  return async event => {
    try {
      if (event.httpMethod === 'GET') {
        await authenticate(event);
        return json(200, {
          ok: true
        });
      }
      if (event.httpMethod !== 'POST') throw error(405, 'method_not_allowed');
      const body = bodyOf(event);
      if (body.action === 'logout') {
        const actor = await authenticate(event);
        await tx(root => {
          if (root.security?.adminSessions?.[actor.sid]) root.security.adminSessions[actor.sid].revoked = true;
        });
        return json(200, {
          ok: true
        }, {
          'Set-Cookie': sessionCookie('', 0)
        });
      }
      if (body.action !== 'login') throw error(400, 'unknown_action');
      const token = await signIn(event, body.password);
      return json(200, {
        ok: true
      }, {
        'Set-Cookie': sessionCookie(token)
      });
    } catch (e) {
      return failure(e);
    }
  };
}
export const handler = createAdminSessionHandler();
