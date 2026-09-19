// Offline only: report configuration names, never values; no deployment or network calls.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function stagingPreflight(env, {previewHostname, testLiffId}) {
  const issues=[];
  const requireValue=name=>{if(!env[name])issues.push({name,reason:'MISSING'});};
  for(const name of ['APP_ORIGIN','FIREBASE_DATABASE_URL','FIREBASE_SERVICE_ACCOUNT_JSON','ADMIN_PASSWORD_SALT','ADMIN_PASSWORD_HASH','ADMIN_SESSION_SECRET','LINE_LOGIN_CHANNEL_ID'])requireValue(name);
  const origin=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password?u:null;}catch{return null;}};
  const app=origin(env.APP_ORIGIN);
  if(!app||app.hostname!==previewHostname||app.hostname==='piyasiri-line-member-system.netlify.app')issues.push({name:'APP_ORIGIN',reason:'UNSUPPORTED_OR_UNCONFIRMED_HOST_MAPPING'});
  const db=origin(env.FIREBASE_DATABASE_URL);
  if(!db||!/\.(firebaseio\.com|firebasedatabase\.app)$/.test(db.hostname)||/piyasiri-member-system/i.test(db.hostname))issues.push({name:'FIREBASE_DATABASE_URL',reason:'INVALID_OR_PRODUCTION_TARGET'});
  if(!['deploy-preview','branch-deploy'].includes(env.CONTEXT))issues.push({name:'CONTEXT',reason:'NON_PRODUCTION_CONTEXT_REQUIRED'});
  if(env.FIREBASE_EMULATOR_MODE==='true')issues.push({name:'FIREBASE_EMULATOR_MODE',reason:'REMOTE_STAGING_MUST_NOT_USE_EMULATOR_MODE'});
  if(!testLiffId||testLiffId.split('-')[0]!==env.LINE_LOGIN_CHANNEL_ID)issues.push({name:'LINE_LOGIN_CHANNEL_ID',reason:'LIFF_CHANNEL_MISMATCH'});
  if(testLiffId?.split('-')[0]==='2010437975')issues.push({name:'TEST_LIFF_ID',reason:'SHARES_PRODUCTION_CHANNEL_PREFIX_REQUIRES_ISOLATION_DECISION'});
  if((env.ADMIN_SESSION_SECRET||'').length<32)issues.push({name:'ADMIN_SESSION_SECRET',reason:'INVALID_LENGTH'});
  if((env.ADMIN_PASSWORD_SALT||'').length<16)issues.push({name:'ADMIN_PASSWORD_SALT',reason:'INVALID_LENGTH'});
  if(!/^[a-f0-9]{128}$/.test(env.ADMIN_PASSWORD_HASH||''))issues.push({name:'ADMIN_PASSWORD_HASH',reason:'INVALID_FORMAT'});
  try{const a=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);if(a.type!=='service_account'||!a.project_id||a.project_id==='piyasiri-member-system'||!a.client_email||!a.private_key)throw Error();}catch{issues.push({name:'FIREBASE_SERVICE_ACCOUNT_JSON',reason:'INVALID_OR_PRODUCTION_ACCOUNT'});}
  if(env.LINE_NOTIFICATIONS_ENABLED!=='false')issues.push({name:'LINE_NOTIFICATIONS_ENABLED',reason:'KEEP_DISABLED_FOR_CORE_FLOW'});
  return {mode:'OFFLINE_READINESS_ONLY',configuration:issues.length?'NOT READY':'STATIC CHECKS PASS',liveE2E:'BLOCKED — requires verified isolated resources and authorized test credentials',issues,
    requiredEvidence:['Approved staging hostname and deployed branch revision','Independent Firebase project/database and matching service-account IAM','Proposed Rules deployed to staging only','Test LINE channel/LIFF endpoint and tester permissions verified','Function-scoped secrets and exact APP_ORIGIN','Synthetic fixture and dedicated test user; no real customer phone','No Production environment inheritance']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const previewHostname=/previewHostname:\s*"([^"]+)"/.exec(html)?.[1];
  const testLiffId=/testId:\s*"([^"]+)"/.exec(html)?.[1];
  console.log(JSON.stringify(stagingPreflight(process.env,{previewHostname,testLiffId}),null,2));
}
