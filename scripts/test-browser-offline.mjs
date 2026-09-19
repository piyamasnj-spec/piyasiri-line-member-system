import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root=path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
const page=await browser.newPage({viewport:{width:390,height:844}});
const subject='U'+'a'.repeat(32),errors=[];let authenticated=false,redeems=0;
let state={customers:[{id:'m',lineUserId:subject,name:'สมาชิกทดสอบ',phone:'0812345678',code:'MB-FIXTURE',points:10,totalSpend:1000}],rewards:[{id:'r',name:'รางวัลทดสอบ',points:5,stock:1,active:true}],transactions:[],redemptions:[],pendingPurchases:[]};
page.on('pageerror',e=>errors.push(e.message));
// Every browser request is intercepted: no external navigation, Firebase, LINE or Netlify traffic.
await page.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 if(url.hostname==='static.line-scdn.net')return route.fulfill({contentType:'text/javascript',body:`window.liff={init:async()=>{},isLoggedIn:()=>true,isInClient:()=>false,getProfile:async()=>({userId:'${subject}',displayName:'Fixture'}),getAccessToken:()=> 'offline-fixture',login:()=>{throw new Error('Unexpected login redirect')}};`});
 if(url.pathname.includes('/.netlify/functions/')){
  const name=url.pathname.split('/').at(-1),body=request.postDataJSON() || {};
  if(name==='admin-session'){
   if(body.action==='login')authenticated=true;if(body.action==='logout')authenticated=false;
   return route.fulfill({status:authenticated || body.action==='logout'?200:401,json:{ok:authenticated || body.action==='logout'}});
  }
  if(name==='member-state')return route.fulfill({json:{ok:true,state}});
  if(name==='reward-redemption'){
   redeems++;state.customers[0].points-=5;state.rewards[0].stock=0;state.redemptions.push({id:'redeem-fixture',customerId:'m',rewardName:'รางวัลทดสอบ',points:5,date:new Date().toISOString(),status:'requested'});
   return route.fulfill({json:{ok:true,redemptionId:'redeem-fixture'}});
  }
  return route.fulfill({status:400,json:{ok:false,status:'unexpected_mock_request'}});
 }
 if(url.hostname!=='deploy-preview-6--piyasiri-line-member-system.netlify.app')return route.fulfill({json:{ok:true,promotions:[]}});
 const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
 if(!file.startsWith(root+path.sep) || !fs.existsSync(file))return route.fulfill({status:404,body:''});
 return route.fulfill({contentType:file.endsWith('.mjs')?'text/javascript':file.endsWith('.png')?'image/png':'text/html',body:fs.readFileSync(file)});
});
try{
 await page.goto('https://deploy-preview-6--piyasiri-line-member-system.netlify.app/#member');
 await page.getByText('สมาชิกทดสอบ',{exact:true}).first().waitFor();
 await page.locator('[data-screen="screenRewards"]').first().click();
 await page.locator('[data-redeem="r"]:visible').first().click();
 await page.getByText('ส่งคำขอแลกของแล้ว',{exact:true}).waitFor();
 assert.equal(redeems,1);assert.equal(state.customers[0].points,5);
 if (process.env.SMOKE_SCREENSHOT_PATH) await page.screenshot({path:process.env.SMOKE_SCREENSHOT_PATH,fullPage:true});
 await page.evaluate(()=>{location.hash='#admin';});
 await page.locator('#adminPasscode:visible').fill('offline-fixture-only');
 await page.locator('#adminLoginBtn').click();
 await page.waitForFunction(()=>document.body.classList.contains('admin-authenticated'));
 await page.locator('#adminLogoutBtn').click();
 await page.waitForFunction(()=>!document.body.classList.contains('admin-authenticated'));
 await page.getByText('สมาชิกทดสอบ',{exact:true}).first().waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: offline browser member load, rewards, redemption, admin login/logout and return to member; zero external network requests');
}finally{await browser.close();}
