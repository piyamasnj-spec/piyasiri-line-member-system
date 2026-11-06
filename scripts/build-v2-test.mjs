import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, relative, isAbsolute } from 'node:path';

export const operations = Object.freeze(['admin-operations', 'admin-session', 'member-profile', 'member-state', 'reward-redemption', 'sync-sale-points']);
const root = fileURLToPath(new URL('../', import.meta.url));
const libraries = ['auth.mjs', 'firebase-rest.mjs', 'http.mjs', 'operations.mjs', 'points.mjs', ...['entrypoint', 'firestore', 'handlers', 'member-store', 'remote'].map(n => `v2/${n}.mjs`)];
const domainModules = ['reward-redemption.mjs', 'admin-operations.mjs', 'sync-sale-points.mjs', 'member-profile.mjs', 'send-line-message.mjs'];
export async function buildV2Test({ output = join(root, 'dist-v2-test'), env = process.env } = {}) {
  const insideV1 = relative(join(root, 'dist'), resolve(output));
  if (!insideV1 || (!isAbsolute(insideV1) && insideV1 !== '..' && !insideV1.startsWith('..\\') && !insideV1.startsWith('../'))) {
    throw Error('V2 output must be outside V1 publish directory');
  }
  const legacy = await lstat(join(root, 'dist/v2-test')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (legacy) throw Error('Legacy dist/v2-test artifact detected: stop before V1 build; use a clean workspace');
  // No source mutation, credential serialization, or network. Refuse stale output.
  const staging = env.CONTEXT === 'branch-deploy' && env.BRANCH === 'staging';
  const files = new Map([['public/index.html', '<!doctype html><title>V2 isolated test</title><p>Server-only test deployment. No customer application.</p>']]);
  if (staging) {
    for (const name of libraries) files.set(`server/lib/${name}`, await readFile(join(root, 'netlify/functions/lib', name), 'utf8'));
    for (const name of domainModules) files.set(`server/${name}`, await readFile(join(root, 'netlify/functions', name), 'utf8'));
    files.set('server/lib/v2/deployment-identity.mjs', 'export default Object.freeze({version:1,context:"branch-deploy",branch:"staging"});\n');
    files.set('server/modern-adapter.mjs', await readFile(new URL('./v2-modern-adapter.mjs', import.meta.url), 'utf8'));
    for (const op of operations) files.set(`functions/v2-staging-test-${op}.mjs`,
      `import { stagingHandler } from '../server/lib/v2/entrypoint.mjs';\nimport { modernHandler } from '../server/modern-adapter.mjs';\nexport default modernHandler(stagingHandler(${JSON.stringify(op)}));\n`);
  }
  async function inspect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('Artifact symlink refused');
      if (entry.isDirectory()) await inspect(path);
      else if (!files.has(relative(output, path).replaceAll('\\', '/'))) throw Error('Unexpected stale artifact; use a fresh output directory');
    }
  }
  // Refuse a symlink output root as well as nested links.
  if ((await lstat(output).catch(e => { if (e.code === 'ENOENT') return null; throw e; }))?.isSymbolicLink()) throw Error('Artifact symlink refused');
  await inspect(output);
  for (const [name, content] of files) {
    const path = join(output, name); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, content);
  }
  await mkdir(join(output, 'functions'), { recursive: true });
  return [...files.keys()].sort();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildV2Test();
}
