import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/))];
const checks=[
  ['private-key',/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/],
  ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['google-api-key',/AIza[0-9A-Za-z_-]{30,}/],
  ['slack-token',/xox[baprs]-[A-Za-z0-9-]{15,}/],
  ['literal-admin-passcode',/const\s+ADMIN_PASSCODE\s*=\s*["'][^"']+["']/],
  ['literal-bearer',/Bearer\s+[A-Za-z0-9_-]{40,}/]
];
const findings=[];
for(const file of files){if(!/\.(?:mjs|js|html|json|toml|md|txt|env)$/.test(file))continue;const source=readFileSync(path.join(root,file),'utf8');for(const [rule,re] of checks)if(re.test(source))findings.push({file,rule});}
console.log(JSON.stringify({files:files.length,checks:checks.length,findings},null,2));
if(findings.length)process.exitCode=1;
