import { cp, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
let stagingHtml;
if (process.env.CONTEXT === 'branch-deploy' && process.env.BRANCH === 'staging') {
  const liffId = process.env.LIFF_ID || '';
  if (liffId !== liffId.trim() || !/^\d+-[A-Za-z0-9]+$/.test(liffId)) {
    throw new Error('Staging build requires LIFF_ID in numeric-channel-alphanumeric-app format');
  }
  let origin;
  try {
    origin = new URL(process.env.APP_ORIGIN || '');
    if (origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
  } catch {
    throw new Error('Staging build requires APP_ORIGIN to be an HTTPS origin without credentials, path, query or fragment');
  }
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const configPattern = /const LIFF_CONFIG = Object\.freeze\(\{[^}]*\}\);/g;
  const configs = [...source.matchAll(configPattern)];
  if (configs.length !== 1) throw new Error('Staging build expected exactly one LIFF_CONFIG block');
  let config = configs[0][0];
  for (const [name, value] of [['testId', liffId], ['previewHostname', origin.hostname]]) {
    const property = new RegExp(`\\b${name}:\\s*"[^"\\r\\n]*"`, 'g');
    if ([...config.matchAll(property)].length !== 1) {
      throw new Error(`Staging build expected exactly one LIFF_CONFIG.${name}`);
    }
    config = config.replace(property, () => `${name}: ${JSON.stringify(value)}`);
  }
  stagingHtml = source.replace(configPattern, () => config);
}
// Explicit allowlist: source, credentials, backups, rules and tests never enter the web root.
await mkdir(new URL('../dist/', import.meta.url), {
  recursive: true
});
for (const name of ['index.html']) await copyFile(new URL(`../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
if (stagingHtml !== undefined) await writeFile(new URL('../dist/index.html', import.meta.url), stagingHtml);
for (const name of ['src', 'assets']) await cp(new URL(`../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url), {
  recursive: true
});
