import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildV2Test, operations } from '../scripts/build-v2-test.mjs';
import { modernHandler } from '../scripts/v2-modern-adapter.mjs';
const scratch = () => mkdtemp(join(tmpdir(), 'v2-only-'));
const good = { CONTEXT: 'branch-deploy', BRANCH: 'staging' };
const request = (body, headers = {}) => new Request('https://synthetic.invalid/test', { method: 'POST', headers, body });

async function isolatedRepo() {
  const dir = await scratch();
  const source = fileURLToPath(new URL('../', import.meta.url));
  for (const name of ['netlify', 'src', 'assets', 'index.html', 'netlify.toml', 'deploy/v2-test/netlify.toml',
    'scripts/build-v2-test.mjs', 'scripts/v2-modern-adapter.mjs', 'scripts/build-public.mjs', 'scripts/build-v2-identity.mjs']) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await cp(join(source, name), join(dir, name), { recursive: true });
  }
  return dir;
}
function runBuild(dir, script) {
  return execFileSync(process.execPath, [script], { cwd: dir, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, ...good, LIFF_ID: '1234567890-Synthetic', APP_ORIGIN: 'https://synthetic.invalid' } });
}
async function snapshot(dir) {
  const result = {};
  async function walk(path, prefix = '') {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.isDirectory()) await walk(join(path, item.name), prefix + item.name + '/');
      else result[prefix + item.name] = (await readFile(join(path, item.name))).toString('base64');
    }
  }
  await walk(dir); return result;
}
test('V2 then V1 builds preserve identical V1 output with prior generated files', async () => {
  const dir = await isolatedRepo();
  runBuild(dir, 'scripts/build-public.mjs');
  await writeFile(join(dir, 'dist/previous-public.txt'), 'existing harmless V1 output');
  const before = await snapshot(join(dir, 'dist'));
  runBuild(dir, 'scripts/build-v2-test.mjs');
  runBuild(dir, 'scripts/build-v2-test.mjs'); // expected stale V2 files may be overwritten
  runBuild(dir, 'scripts/build-public.mjs');
  assert.deepEqual(await snapshot(join(dir, 'dist')), before);
  assert.equal((await readdir(join(dir, 'dist-v2-test/functions'))).length, 6);
  assert.ok(!Object.keys(before).some(p => /deployment-identity|v2-test|server\//.test(p)));
  const config = await readFile(join(dir, 'deploy/v2-test/netlify.toml'), 'utf8');
  assert.match(config, /publish = "\.\.\/\.\.\/dist-v2-test\/public"/);
  assert.match(config, /directory = "\.\.\/\.\.\/dist-v2-test\/functions"/);
});
for (const [context, branch, count] of [['production', 'v2-test-bootstrap', 0], ['branch-deploy', 'staging', 6]]) {
  test(`configured nested base builds ${context}/${branch} with ${count} modern endpoints`, async () => {
    const dir = await isolatedRepo(), base = join(dir, 'deploy/v2-test');
    const config = await readFile(join(base, 'netlify.toml'), 'utf8');
    const command = config.match(/command = "([^"]+)"/)[1];
    const publish = join(base, config.match(/publish = "([^"]+)"/)[1]);
    const functions = join(base, config.match(/directory = "([^"]+)"/)[1]);
    assert.equal(publish, join(dir, 'dist-v2-test/public'));
    assert.equal(functions, join(dir, 'dist-v2-test/functions'));
    assert.ok(!/schedule|build-public|netlify\/functions/.test(config));
    const rootConfig = await readFile(join(dir, 'netlify.toml'), 'utf8');
    assert.ok(!/^\s*base\s*=/m.test(rootConfig));
    assert.equal(command.split(' ')[0], 'node');
    execFileSync(process.execPath, command.split(' ').slice(1), { cwd: base, windowsHide: true,
      env: { ...process.env, CONTEXT: context, BRANCH: branch, V2_SERVICE_ACCOUNT_JSON: 'SECRET_CANARY' } });
    assert.equal(await readFile(join(dir, 'netlify.toml'), 'utf8'), rootConfig);
    const entries = await readdir(functions);
    assert.deepEqual(entries.sort(), count ? operations.map(o => `v2-staging-test-${o}.mjs`).sort() : []);
    assert.deepEqual(await readdir(publish), ['index.html']);
    assert.ok(!/SECRET_CANARY|<script|LIFF|firebase|deployment-identity/i.test(await readFile(join(publish, 'index.html'), 'utf8')));
    for (const name of entries) {
      const module = await import(pathToFileURL(join(functions, name)));
      assert.deepEqual(Object.keys(module), ['default']); // complete static dependency graph resolves
      assert.equal((await module.default(request('{}'))).status, 503);
    }
  });
}
test('legacy nested artifacts stop V2 before V1 sequence, without deleting anything', async () => {
  const dir = await isolatedRepo();
  await mkdir(join(dir, 'dist/v2-test/server'), { recursive: true });
  await writeFile(join(dir, 'dist/v2-test/server/deployment-identity.mjs'), 'synthetic stale metadata');
  const before = await snapshot(join(dir, 'dist'));
  assert.throws(() => runBuild(dir, 'scripts/build-v2-test.mjs'), /Legacy dist\/v2-test artifact/);
  assert.deepEqual(await snapshot(join(dir, 'dist')), before);
});
test('output override cannot reintroduce V1 publish nesting', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const output of [join(root, 'dist'), join(root, 'dist/v2-test')]) {
    await assert.rejects(buildV2Test({ output, env: good }), /outside V1 publish/);
  }
});

test('staging artifact: exactly six modern endpoints, dependency imports work and missing config denies', async () => {
  const output = await scratch();
  const files = await buildV2Test({ output, env: { ...good, V2_SERVICE_ACCOUNT_JSON: 'SECRET_CANARY_NOT_A_KEY', ADMIN_SESSION_SECRET: 'SECRET_CANARY_NOT_A_KEY' } });
  assert.deepEqual((await readdir(join(output, 'functions'))).sort(), operations.map(o => `v2-staging-test-${o}.mjs`).sort());
  assert.deepEqual(await readdir(join(output, 'public')), ['index.html']);
  for (const file of files) {
    const text = await readFile(join(output, file), 'utf8');
    assert.ok(!text.includes('SECRET_CANARY_NOT_A_KEY'));
    if (file.startsWith('public/')) assert.ok(!/LIFF|deployment-identity|branch-deploy|firebase|<script/i.test(text));
  }
  for (const op of operations) {
    const module = await import(pathToFileURL(join(output, `functions/v2-staging-test-${op}.mjs`)));
    assert.deepEqual(Object.keys(module), ['default']);
    const response = await module.default(request('{}'));
    assert.equal(response.status, 503);
  }
  for (const name of ['remote', 'firestore', 'member-store', 'handlers', 'entrypoint']) {
    assert.equal(await readFile(join(output, `server/lib/v2/${name}.mjs`), 'utf8'), await readFile(new URL(`../netlify/functions/lib/v2/${name}.mjs`, import.meta.url), 'utf8'));
  }
});
for (const env of [{}, { CONTEXT: 'production', BRANCH: 'main' }, { CONTEXT: 'production', BRANCH: 'staging' }, { CONTEXT: 'deploy-preview', BRANCH: 'staging' }, { CONTEXT: 'branch-deploy', BRANCH: 'other' }]) {
  test(`no functions outside staging branch-deploy: ${JSON.stringify(env)}`, async () => {
    const output = await scratch(); await buildV2Test({ output, env });
    assert.deepEqual(await readdir(join(output, 'functions')), []);
  });
}
test('stale artifacts fail closed instead of leaking endpoints across contexts', async () => {
  const output = await scratch(); await buildV2Test({ output, env: good });
  await assert.rejects(buildV2Test({ output, env: {} }), /stale artifact/);
  await writeFile(join(output, 'functions/evil.mjs'), 'export default () => null');
  await assert.rejects(buildV2Test({ output, env: good }), /stale artifact/);
});
test('modern mapping preserves auth, duplicate cookies, Origin, query, status and secure cookie', async () => {
  const cookie = '__Host-member_v2_admin=a; __Host-member_v2_admin=b';
  const fn = modernHandler(async e => {
    assert.equal(e.headers.cookie, cookie); assert.equal(e.headers.authorization, 'Bearer synthetic');
    assert.equal(e.headers.origin, 'https://synthetic.invalid'); assert.equal(e.headers.host, 'synthetic.invalid');
    assert.equal(e.body, '{}'); assert.equal(e.httpMethod, 'POST');
    return { statusCode: 401, headers: { 'Set-Cookie': '__Host-member_v2_admin=; Path=/; Secure; HttpOnly; SameSite=Strict', 'Cache-Control': 'no-store' }, body: '{}' };
  }, {});
  const response = await fn(request('{}', { Cookie: cookie, Authorization: 'Bearer synthetic', Origin: 'https://synthetic.invalid' }));
  assert.equal(response.status, 401); assert.match(response.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
});
test('body guard applies to streamed bytes before invoking financial handler', async () => {
  let called = 0; const fn = modernHandler(async () => { called++; return { statusCode: 200, body: '{}' }; }, {});
  assert.equal((await fn(request('a'.repeat(100001)))).status, 413);
  assert.equal(called, 0);
  assert.equal((await fn(request('a'.repeat(100000)))).status, 200);
  assert.equal(called, 1);
});
test('host mismatch and ambiguous queries deny before handler; forwarded headers cannot change host', async () => {
  const fn = modernHandler(async e => { assert.equal(e.headers.host, 'synthetic.invalid'); return { statusCode: 200, body: '{}' }; }, {});
  assert.equal((await fn(request('{}', { host: 'wrong.invalid' }))).status, 403);
  assert.equal((await fn(new Request('https://synthetic.invalid/?id=a&id=b'))).status, 400);
  assert.equal((await fn(request('{}', { 'x-forwarded-host': 'wrong.invalid' }))).status, 200);
});
test('V1 credentials refuse execution and unexpected errors are redacted', async () => {
  for (const key of ['FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'LINE_CHANNEL_ACCESS_TOKEN']) {
    const fn = modernHandler(() => { throw Error('must not run'); }, { [key]: 'synthetic' });
    assert.equal((await fn(request('{}'))).status, 503);
  }
  const response = await modernHandler(() => { throw Error('SECRET_CANARY'); }, {})(request('{}'));
  assert.ok(!(await response.text()).includes('SECRET_CANARY'));
});
