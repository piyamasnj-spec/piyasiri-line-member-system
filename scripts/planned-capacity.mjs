// Owner-approved planning assumptions, not measured Production statistics.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const hash=s=>createHash('sha256').update(s).digest('hex');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const memberId=i=>uuid(i+1);
export const lineId=i=>'U'+(i+1).toString(16).padStart(32,'0');
const date='2026-09-21T00:00:00.000Z';
export function* records({members=5000,days=0,earnPerDay=500,redeemPerDay=50}) {
 for(let i=0;i<members;i++)yield ['customers',memberId(i),{id:memberId(i),lineUserId:lineId(i),code:`MB-${String(i+1).padStart(4,'0')}`,name:`Synthetic member ${i}`,phone:'08'+String(i).padStart(8,'0'),birthday:'2000-01-01',area:'Synthetic district',points:10000,totalSpend:0,joinedAt:date}];
 for(let i=0;i<20;i++)yield ['rewards',`test-reward-${i}`,{id:`test-reward-${i}`,name:`Synthetic reward ${i}`,points:20,stock:100,stockVersion:0,active:true,description:'Synthetic capacity only',imageUrl:''}];
 // 1 earn transaction plus 1 receipt per earn; redemption adds debit, redemption and receipt.
 // Treat the requested loyalty transaction rate as earn volume; debit rows are additional.
 for(let i=0;i<days*earnPerDay;i++) {
  const id=`sheet-${uuid(i+1)}`,customerId=memberId(i%members),ref=`SYNTHETIC-BILL-${i}`;
  yield ['transactions',id,{id,customerId,type:'earn',status:'confirmed',points:10,amount:1000,ref,source:'google-sheet',date,operator:'google-sheet',pointBreakdown:[{points:10}],alerts:[],note:'Synthetic purchase',saleDate:'2026-09-21',expiresAt:'2027-09-21T00:00:00.000Z'}];
  yield ['secureOperations',hash(`sale:${i}`),{fingerprint:hash(ref),result:{ok:true,status:'synced',customerId,points:10,totalPoints:10000,transactionId:id},completedAt:date}];
 }
 for(let i=0;i<days*redeemPerDay;i++) {
  const id=`redeem-${uuid(i+1)}`,transactionId=`redeem-points-${uuid(i+1)}`,customerId=memberId(i%members),rewardId=`test-reward-${i%20}`;
  yield ['redemptions',id,{id,customerId,memberId:customerId,rewardId,rewardName:`Synthetic reward ${i%20}`,quantity:1,points:20,pointsUsed:20,stockBefore:100,stockAfter:99,stockReserved:true,transactionId,date,createdAt:date,status:'requested',operationId:uuid(i+1),testMode:false,operator:lineId(i%members)}];
  yield ['transactions',transactionId,{id:transactionId,customerId,type:'redeem',status:'confirmed',points:20,amount:0,rewardId,redemptionId:id,date}];
  yield ['secureOperations',hash(`redeem:${i}`),{fingerprint:hash(id),result:{ok:true,status:'requested',redemptionId:id,transactionId,points:20,totalPoints:9980,stock:99},completedAt:date}];
 }
}
const names=['customers','rewards','transactions','redemptions','secureOperations','pendingPurchases','security','operationLocks','notificationJobs'];
export function dataset(options){const root=Object.fromEntries(names.map(n=>[n,{}]));for(const [c,k,v] of records(options))root[c][k]=v;return root;}
export function sizing(options){
 const collections=Object.fromEntries(names.map(n=>[n,{count:0,bytes:2,recordBytes:0,minRecordBytes:null,maxRecordBytes:0}]));
 for(const [c,k,v] of records(options)){const s=collections[c],n=Buffer.byteLength(JSON.stringify(v));s.bytes+=Buffer.byteLength(JSON.stringify(k))+1+n+(s.count?1:0);s.count++;s.recordBytes+=n;s.minRecordBytes=Math.min(s.minRecordBytes??n,n);s.maxRecordBytes=Math.max(s.maxRecordBytes,n);}
 let bytes=2;for(const [i,[name,s]] of Object.entries(collections).entries()){bytes+=Buffer.byteLength(JSON.stringify(name))+1+s.bytes+(i?1:0);s.meanRecordBytes=s.count?Math.round(s.recordBytes/s.count):0;delete s.recordBytes;}
 return {options,bytes,collections};
}
export function threshold(members,earnPerDay,redeemPerDay){let days=0;while(sizing({members,days,earnPerDay,redeemPerDay}).bytes<=8000000)days++;return {firstRejectedDay:days,lastSupportedDays:days-1,lastSupportedBytes:sizing({members,days:days-1,earnPerDay,redeemPerDay}).bytes,firstRejectedBytes:sizing({members,days,earnPerDay,redeemPerDay}).bytes};}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const cases=[];for(const members of [5000,10000])for(const [load,earnPerDay,redeemPerDay]of [['normal',500,50],['stress',1500,200]])cases.push({load,...sizing({members,days:1095,earnPerDay,redeemPerDay}),threshold:threshold(members,earnPerDay,redeemPerDay)});
 const populationTrajectory=cases.map(c=>{const newMembersPerDay=c.load==='normal'?30:100;const endMembers=c.options.members+1095*newMembersPerDay;const customerBytes=sizing({members:endMembers}).collections.customers.bytes;return {initialMembers:c.options.members,load:c.load,newMembersPerDay,endMembers,threeYearBytes:c.bytes-c.collections.customers.bytes+customerBytes,daysUntil10000Members:Math.max(0,Math.ceil((10000-c.options.members)/newMembersPerDay))};});
 console.log(JSON.stringify({assumptions:'Planned owner envelope. 1095 days; fixed target/headroom cases plus uncapped population growth. Earn volume plus redemption debit rows. One receipt per financial operation. Empty ancillary collections: lower bound; profile/admin/notification receipts and cancellations increase size. Historical dates/balances are synthetic shape placeholders, not reconciliation evidence.',cases,populationTrajectory},null,2));
}
