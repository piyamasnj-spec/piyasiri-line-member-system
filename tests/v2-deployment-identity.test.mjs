import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, copyFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'v2-identity-'));
// Only source/fixtures; no .git, credentials, historical RTDB test or archives.
for (const dir of ['netlify', 'scripts', 'tests', 'firebase', 'src', 'assets']) {
  await cp(join(repo, dir), join(scratch, dir), { recursive: true,
    filter: p => !p.endsWith('test-planned-capacity.mjs') });
}
for (const file of ['index.html', 'netlify.toml']) await copyFile(join(repo, file), join(scratch, file));
const metadata = join(scratch, 'netlify/functions/lib/v2/deployment-identity.mjs');
// Fresh processes ensure modules are loaded from each artifact, not an import cache.
function node(args, env = {}) {
  return execFileSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
}
function build(context, branch) {
  node(['scripts/build-public.mjs'], { ...(context === undefined ? {} : { CONTEXT: context }),
    ...(branch === undefined ? {} : { BRANCH: branch }), LIFF_ID: '123456-test', APP_ORIGIN: 'https://synthetic.invalid' });
}
function probe(allowed, extra = '') {
  node(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { remoteEnvironment } from './tests/v2-remote-helpers.mjs';
    import { remoteConfig, createRemoteTransport } from './netlify/functions/lib/v2/remote.mjs';
    globalThis.fetch = () => { throw Error('NETWORK FORBIDDEN'); };
    const env = remoteEnvironment(); delete env.CONTEXT; delete env.BRANCH;
    ${extra}
    ${allowed ? "assert.equal(remoteConfig(env).project, 'synthetic-v2-test');" : "assert.throws(() => remoteConfig(env), /v2_remote_configuration_denied/);"}
  `]);
}

test('Node 22.23.2 execution parity', () => assert.equal(process.version, 'v22.23.2'));
test('unbuilt checkout denies even spoofed staging runtime identity', () => probe(false, "env.CONTEXT='branch-deploy'; env.BRANCH='staging';"));
test('staging artifact allows without reserved runtime variables and keeps metadata server-only', async () => {
  build('branch-deploy', 'staging'); probe(true);
  const value = await readFile(metadata, 'utf8');
  assert.match(value, /Object.freeze/);
  assert.match(value, /"context":"branch-deploy","branch":"staging"/);
  const html = await readFile(join(scratch, 'dist/index.html'), 'utf8');
  assert.match(html, /testId: "123456-test"/); assert.match(html, /previewHostname: "synthetic.invalid"/);
  assert.ok(!html.includes('deploymentIdentity'));
  assert.equal(await readFile(join(scratch, 'dist/netlify/functions/lib/v2/deployment-identity.mjs')).then(() => true, () => false), false);
});
for (const [label, context, branch] of [
  ['production/main', 'production', 'main'], ['production/staging', 'production', 'staging'],
  ['preview', 'deploy-preview', 'staging'], ['wrong branch', 'branch-deploy', 'main'],
  ['missing context', undefined, 'staging'], ['missing branch', 'branch-deploy', undefined],
  ['malformed context', 'branch-deploy\n', 'staging']
]) test(`${label} build replaces stale staging grant and rejects spoofed runtime`, async () => {
  build('branch-deploy', 'staging'); build(context, branch);
  probe(false, "env.CONTEXT='branch-deploy'; env.BRANCH='staging';");
  assert.equal(await readFile(join(scratch, 'dist/index.html'), 'utf8'), await readFile(join(repo, 'index.html'), 'utf8'));
});
test('runtime contradiction rejected including variables added after initialization', () => {
  build('branch-deploy', 'staging');
  probe(false, "env.CONTEXT='production';"); probe(false, "env.BRANCH='main';");
  probe(true, "const t=createRemoteTransport({env}); env.CONTEXT='production'; assert.throws(()=>t.assertTarget(), /configuration_denied/); delete env.CONTEXT;");
});
test('generated identity is frozen and contains only deployment identity, never arbitrary env', async () => {
  node(['scripts/build-public.mjs'], { CONTEXT: 'branch-deploy', BRANCH: 'staging', LIFF_ID: '123456-test', APP_ORIGIN: 'https://synthetic.invalid', V2_SERVICE_ACCOUNT_JSON: 'SYNTHETIC_SECRET_CANARY' });
  node(['--input-type=module', '-e', `import assert from 'node:assert/strict'; import identity from './netlify/functions/lib/v2/deployment-identity.mjs'; assert.ok(Object.isFrozen(identity)); assert.throws(()=>{identity.branch='main'}, TypeError); assert.deepEqual(Object.keys(identity).sort(), ['branch','context','version']);`]);
  assert.ok(!(await readFile(metadata, 'utf8')).includes('SYNTHETIC_SECRET_CANARY'));
});
test('build context cannot inject executable code into metadata', async () => {
  build('branch-deploy', 'staging\";throw Error(\"injected\");//'); probe(false);
  assert.ok(!(await readFile(metadata, 'utf8')).includes('injected'));
});
for (const value of ['null', '{}', '[]', '"staging"', '{version:2,context:"branch-deploy",branch:"staging"}',
  '{version:1,context:"production",branch:"main"}', '{version:1,context:"branch-deploy",branch:"staging",extra:true}']) {
  test(`malformed metadata ${value} rejects runtime spoofing`, async () => {
    await writeFile(metadata, `export default Object.freeze(${value});\n`);
    probe(false, "env.CONTEXT='branch-deploy'; env.BRANCH='staging';");
  });
}
test('missing module cannot start and runtime spoofing cannot rescue it', async () => {
  await unlink(metadata);
  assert.throws(() => probe(true, "env.CONTEXT='branch-deploy'; env.BRANCH='staging';"), /ERR_MODULE_NOT_FOUND/);
});
test('syntactically invalid metadata cannot initialize the transport', async () => {
  await writeFile(metadata, 'export default {');
  assert.throws(() => probe(true), /SyntaxError/);
});
test('all six production artifact endpoints reject before network despite spoofed request/runtime', () => {
  build('production', 'main');
  node(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { remoteEnvironment } from './tests/v2-remote-helpers.mjs';
    Object.assign(process.env, remoteEnvironment());
    globalThis.fetch = () => { throw Error('NETWORK FORBIDDEN'); };
    for (const op of ['member-profile','member-state','reward-redemption','admin-operations','admin-session','sync-sale-points']) {
      const {handler}=await import('./netlify/functions/v2-staging-test-'+op+'.mjs');
      const r=await handler({httpMethod:'POST', headers:{context:'branch-deploy',branch:'staging'},queryStringParameters:{branch:'staging'},body:JSON.stringify({context:'branch-deploy',branch:'staging'})});
      assert.equal(r.statusCode,503); assert.equal(JSON.parse(r.body).status,'v2_remote_configuration_denied');
    }
  `]);
});
test('existing remote guard/retry/auth mock regressions on generated staging artifact', () => {
  build('branch-deploy', 'staging');
  const result = node(['--import', './tests/no-network.mjs', '--test', 'tests/v2-remote.test.mjs']);
  assert.match(result, /# fail 0/); console.log('Existing remote suite: ' + result.match(/# tests \d+/)?.[0]);
});
// Scratch is retained in OS temp as local test evidence; never an eligible Git artifact.
