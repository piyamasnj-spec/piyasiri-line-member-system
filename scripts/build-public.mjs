import { cp, mkdir, copyFile } from 'node:fs/promises';
// Explicit allowlist: source, credentials, backups, rules and tests never enter the web root.
await mkdir(new URL('../dist/', import.meta.url), {
  recursive: true
});
for (const name of ['index.html']) await copyFile(new URL(`../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
for (const name of ['src', 'assets']) await cp(new URL(`../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url), {
  recursive: true
});
