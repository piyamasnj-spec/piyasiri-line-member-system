import { generateKeyPairSync, randomUUID } from 'node:crypto';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
// Ephemeral key generated in memory; never a real service identity or committed PEM.
export function remoteEnvironment() {
  return {
    FIRESTORE_V2_MODE: 'staging-test', V2_STAGING_TEST_ENABLED: 'true', CONTEXT: 'branch-deploy', BRANCH: 'staging',
    FIRESTORE_V2_PROJECT: 'synthetic-v2-test', FIRESTORE_V2_DATABASE: '(default)', FIRESTORE_V2_NAMESPACE: `synthetic-${randomUUID()}`,
    V2_ALLOWED_PROJECTS: '["synthetic-v2-test"]', V2_ALLOWED_DATABASES: '["(default)"]',
    V2_DENIED_PROJECTS: '["synthetic-prod-denied"]', V2_DENIED_TARGETS: '["synthetic-prod-denied/(default)"]',
    APP_ORIGIN: 'https://synthetic.invalid', V2_ALLOWED_ORIGINS: '["https://synthetic.invalid"]',
    LINE_LOGIN_CHANNEL_ID: 'test-channel', V2_TEST_LINE_CHANNEL_ID: 'test-channel',
    V2_TEST_LINE_SUBJECTS: JSON.stringify([0,1,99].map(i => `U${(i + 1).toString(16).padStart(32, '0')}`)),
    V2_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: 'synthetic-v2-test', client_email: 'test@synthetic-v2-test.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) })
  };
}
export const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
export const oauthResponse = () => response({ access_token: 'synthetic-mock-access', token_type: 'Bearer', expires_in: 3600 });
