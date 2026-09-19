// Synthetic, loopback-only integration. External LINE delivery/identity responses are fixtures.
import assert from 'node:assert/strict';
import {scryptSync} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {firebaseRead, firebasePut, createTransaction} from '../netlify/functions/lib/firebase-rest.mjs';
import {lineAuth} from '../netlify/functions/lib/auth.mjs';
import {createAdminSessionHandler} from '../netlify/functions/admin-session.mjs';
import {createAdminOperationsHandler} from '../netlify/functions/admin-operations.mjs';
import {createMemberProfileHandler} from '../netlify/functions/member-profile.mjs';
import {createMemberStateHandler} from '../netlify/functions/member-state.mjs';
import {createRewardRedemptionHandler,redeem} from '../netlify/functions/reward-redemption.mjs';
import {saleOperation,createSaleHandler} from '../netlify/functions/sync-sale-points.mjs';
import {notifyRecord} from '../netlify/functions/send-line-message.mjs';
import {handler as audit} from '../netlify/functions/member-audit.mjs';
import {handler as syncRewards} from '../netlify/functions/sync-rewards.mjs';
import {fixture,actor,event,parsed} from '../tests/helpers.mjs';
if(process.env.FIREBASE_DATABASE_EMULATOR_HOST!=='127.0.0.1:9000')throw Error('Explicit local emulator required');
Object.assign(process.env,{FIREBASE_DATABASE_URL:'http://127.0.0.1:9000',FIREBASE_EMULATOR_MODE:'true',APP_ORIGIN:'https://synthetic.invalid',ADMIN_SESSION_SECRET:'synthetic-session-key-only-'.repeat(3),ADMIN_PASSWORD_SALT:'synthetic-salt-only',LINE_LOGIN_CHANNEL_ID:'synthetic-channel',SHEET_SYNC_SECRET:'synthetic-service-only',LINE_NOTIFICATIONS_ENABLED:'false'});
delete process.env.CONTEXT;
const password='synthetic-password-only';process.env.ADMIN_PASSWORD_HASH=scryptSync(password,process.env.ADMIN_PASSWORD_SALT,64).toString('hex');
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,opts)=>{const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:9000','No external network in integration');assert.equal(u.searchParams.get('ns'),'demo-member-stabilize');return nativeFetch(url,opts);};
const seed=async root=>{const r=await fetch('http://127.0.0.1:9000/.json?ns=demo-member-stabilize',{method:'PUT',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:JSON.stringify(root)});assert.equal(r.status,200);};
const state=async()=>(await firebaseRead('')).value;
let conflicts=0,puts=0;
const put=async(...args)=>{puts++;const r=await firebasePut(...args);if(!r.written)conflicts++;return r;};
const tx=createTransaction({put});
const authenticate=e=>lineAuth(e,{fetcher:async url=>new Response(JSON.stringify(url.includes('/verify?')?{client_id:url.includes('invalid')?'wrong':process.env.LINE_LOGIN_CHANNEL_ID,expires_in:3600}:{userId:actor.sub}),{status:200})});
const headers={authorization:'Bearer synthetic'};
const handler=createRewardRedemptionHandler({tx,authenticateMember:authenticate});
const call=async(body,h=headers)=>parsed(await handler(event({action:'request',rewardId:'r',operationId:'op-1',...body},h)));
let checks=0;const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
await check('real admin login, unauthorized/forged/authorized operations, logout revocation',async()=>{
 await seed(fixture().state);const session=createAdminSessionHandler({tx});const admin=createAdminOperationsHandler({tx});
 const body={action:'counter-sale',phone:'0812345678',amount:100,operationId:'admin-sale'};
 const origin={origin:process.env.APP_ORIGIN};assert.equal((await admin(event(body,origin))).statusCode,401);
 assert.equal((await admin(event(body,{...origin,cookie:'__Host-member_admin=forged',sessionStorage:'admin'}))).statusCode,401);
 const signed=await session(event({action:'login',password},origin));assert.equal(signed.statusCode,200);
 const h={...origin,cookie:signed.headers['Set-Cookie'].split(';')[0]};
 assert.equal((await admin(event(body,h))).statusCode,200);assert.equal((await state()).customers.m.points,11);
 assert.equal((await session(event({action:'logout'},h))).statusCode,200);assert.equal((await admin(event({...body,operationId:'after-logout'},h))).statusCode,401);
});
await check('LINE identity, profile whitelist, registration and member read scoping',async()=>{
 await seed(fixture().state);const profile=createMemberProfileHandler({tx,authenticate});const body={name:'Synthetic',phone:'0812345678',birthday:'2000-01-01',area:'Fixture'};
 assert.equal((await profile(event(body,{authorization:'Bearer invalid'}))).statusCode,401);
 assert.equal((await profile(event({...body,points:999},headers))).statusCode,400);
 assert.equal((await profile(event(body,headers))).statusCode,200);assert.equal((await state()).customers.m.points,10);
 const get=createMemberStateHandler({authenticate});const read=parsed(await get({httpMethod:'GET',headers}));assert.equal(read.state.customers.length,1);assert.equal(read.state.security,undefined);
 await seed({});assert.equal(parsed(await profile(event(body,headers))).created,true);assert.equal(Object.values((await state()).customers)[0].points,0);
});
await check('redemption preconditions, retry/replay and payload mismatch',async()=>{
 for(const [field,value] of [['points',4],['stock',0],['active',false]]){const root=fixture().state;(field==='points'?root.customers.m:root.rewards.r)[field]=value;await seed(root);assert.ok((await call({})).status>=400);assert.equal((await state()).redemptions,undefined);}
 await seed(fixture().state);assert.equal((await call({},{})).status,401);const first=await call({});assert.equal(first.status,200);const retry=await call({});assert.equal(retry.redemptionId,first.redemptionId);assert.equal((await call({quantity:2})).status,409);assert.equal((await state()).customers.m.points,5);
});
await check('simultaneous distinct keys limited independently by points and stock',async()=>{
 for(const [points,stock] of [[10,10],[100,2]]){const root=fixture().state;root.customers.m.points=points;root.rewards.r.stock=stock;await seed(root);const results=await Promise.all(Array.from({length:12},(_,i)=>call({operationId:'distinct-'+i})));assert.equal(results.filter(r=>r.status===200).length,2);const after=await state();assert.equal(after.customers.m.points,points-10);assert.equal(after.rewards.r.stock,stock-2);assert.equal(Object.keys(after.redemptions).length,2);}
 assert.ok(conflicts>0,'Real CAS conflicts observed');
});
await check('simultaneous same key produces one debit',async()=>{await seed(fixture().state);const results=await Promise.all(Array.from({length:8},()=>call({})));assert.ok(results.every(r=>r.status===200));assert.equal(new Set(results.map(r=>r.redemptionId)).size,1);assert.equal((await state()).customers.m.points,5);});
await check('response lost after actual Firebase commit, same key retry',async()=>{await seed(fixture().state);let lose=true;const lossy=createTransaction({put:async(...args)=>{const r=await firebasePut(...args);if(r.written&&lose){lose=false;throw Error('synthetic response loss');}return r;}});const body={rewardId:'r',operationId:'loss'};await assert.rejects(lossy(root=>redeem(root,body,actor)),/response loss/);await tx(root=>redeem(root,body,actor));assert.equal((await state()).customers.m.points,5);assert.equal(Object.keys((await state()).redemptions).length,1);});
await check('cancel/complete race is single final state',async()=>{await seed(fixture().state);const {admin}=await import('../tests/helpers.mjs');const first=await call({});const results=await Promise.allSettled(['cancel','complete'].map(action=>tx(root=>redeem(root,{action,redemptionId:first.redemptionId,operationId:action},admin))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const root=await state();const cancelled=root.redemptions[first.redemptionId].status==='cancelled';assert.equal(root.customers.m.points,cancelled?10:5);assert.equal(root.rewards.r.stock,cancelled?2:1);});
await check('sale reversal versus redemption and notification metadata writers',async()=>{
 const root=fixture().state;root.customers.m.points=5;root.customers.m.totalSpend=500;root.transactions={sale:{id:'sale',customerId:'m',type:'earn',status:'confirmed',ref:'bill',points:5,amount:500}};await seed(root);
 const results=await Promise.allSettled([tx(r=>redeem(r,{rewardId:'r',operationId:'debit'},actor)),tx(r=>saleOperation(r,{action:'reverse',ref:'bill'}))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await state()).customers.m.points,0);
 const next=fixture().state;next.transactions={earned:{id:'earned',customerId:'m',type:'earn',points:5,expiresAt:'2099-01-01'}};await seed(next);await Promise.all([notifyRecord({type:'points_expiring',id:'earned'},{tx,push:async()=>({ok:true})}),call({})]);assert.equal((await state()).customers.m.points,5);assert.ok((await state()).transactions.earned.expiryNotifiedAt);
});
await check('service sale/audit and reward-sync gate',async()=>{await seed(fixture().state);const h={'x-sheet-sync-secret':process.env.SHEET_SYNC_SECRET};const sale=createSaleHandler({tx,notify:async()=>({ok:true})});const body={ref:'SYNTHETIC-BILL',phone:'0812345678',pointResult:{points:5,amount:500,breakdown:[{points:5}]}};assert.equal((await sale(event(body))).statusCode,401);assert.equal((await sale(event(body,h))).statusCode,200);assert.equal((await audit({httpMethod:'GET',headers:h})).statusCode,200);assert.equal((await syncRewards(event({rewards:[]},h))).statusCode,503);});
const capacity=[];
for(const target of [100000,1000000,4000000,7500000]){
 const root=fixture().state;root.syntheticCapacityPadding='x'.repeat(target-Buffer.byteLength(JSON.stringify(root))-35);await seed(root);const bytes=Buffer.byteLength(JSON.stringify(await state()));const before=conflicts,start=performance.now();
 const outcomes=await Promise.allSettled(Array.from({length:8},()=>tx(r=>{r.syntheticCounter=(r.syntheticCounter||0)+1;})));
 const elapsedMs=Math.round(performance.now()-start);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,8);assert.equal((await state()).syntheticCounter,8);capacity.push({bytes,concurrency:8,elapsedMs,conflicts:conflicts-before});
}
await check('8 MB read and proposed-write guards leave Firebase unchanged',async()=>{
 await seed(fixture().state);let before=puts;await assert.rejects(tx(r=>{r.syntheticCapacityPadding='x'.repeat(8000001);}),/database_size_requires_review/);assert.equal(puts,before);assert.equal((await state()).syntheticCapacityPadding,undefined);
 await seed({...fixture().state,syntheticCapacityPadding:'x'.repeat(8000001)});before=puts;await assert.rejects(tx(r=>{r.changed=true;}),/database_size_requires_review/);assert.equal(puts,before);
});
await seed(fixture().state);
console.log(JSON.stringify({checks,conflicts,capacity,limitations:['Synthetic sizes only; actual Production root size and peak concurrency unknown','Local machine timings, not deployed Netlify latency','LINE verification responses and delivery stubbed; Firebase I/O real']},null,2));
