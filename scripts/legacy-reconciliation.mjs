// Read-only local evidence classifier. Never imports Firebase or produces a repair plan.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const amount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
export function reconcile(root) {
  const rows = [], collections = {};
  const add = (collection, key, reasons) => rows.push({collection, key, classification: reasons.length ? 'NEEDS REVIEW' : 'STRUCTURALLY CONSISTENT', reasons});
  if (!object(root)) return {mode:'DRY RUN',status:'NEEDS REVIEW',rows:[{collection:'root',key:'',classification:'NEEDS REVIEW',reasons:['INVALID_ROOT']} ]};
  for (const name of ['customers','transactions','redemptions','rewards','operationLocks']) {
    const value = root[name];
    if (value != null && !object(value)) add(name, '', ['INVALID_COLLECTION']);
    collections[name] = object(value) ? value : {};
  }
  const entries = name => Object.entries(collections[name]).filter(([,v]) => object(v));
  const matches = (name, id) => typeof id === 'string' && id ? entries(name).filter(([,v]) => v.id === id) : [];
  const one = (name, id) => matches(name,id).length === 1 ? matches(name,id)[0][1] : undefined;
  const base = (name,key,v) => {
    const reasons = [];
    if (typeof v.id !== 'string' || !v.id) reasons.push('MISSING_ID');
    else {if (v.id !== key) reasons.push('KEY_ID_MISMATCH');if(matches(name,v.id).length!==1)reasons.push('DUPLICATE_ID');}
    return reasons;
  };
  for (const name of ['customers','transactions','redemptions','rewards']) {
    for (const [key,v] of Object.entries(collections[name])) {
      if (!object(v)) {add(name,key,['INVALID_RECORD']);continue;}
      const reasons = base(name,key,v);
      if (name === 'customers') {
        if (!amount(v.points)) reasons.push('INVALID_POINTS');
        // Neither a matching sum nor a zero balance proves that historical writes all committed.
        reasons.push('OPENING_BALANCE_AND_LEDGER_COMPLETENESS_UNPROVEN');
        if (v.lineUserId && entries(name).filter(([,c])=>c.lineUserId===v.lineUserId).length>1) reasons.push('DUPLICATE_LINE_IDENTITY');
      }
      if (name === 'rewards') {
        if (!amount(v.points) || v.points === 0) reasons.push('INVALID_REWARD_POINTS');
        if (v.stock !== '' && v.stock != null && (!amount(v.stock)||!Number.isInteger(v.stock))) reasons.push('INVALID_STOCK');
      }
      if (name === 'transactions') {
        if (!one('customers',v.customerId)) reasons.push('CUSTOMER_MISSING_OR_AMBIGUOUS');
        if (!amount(v.points)) reasons.push('INVALID_POINTS');
        if (!['earn','redeem','refund','sale_reversal'].includes(v.type)) reasons.push('UNKNOWN_TRANSACTION_TYPE');
        if (v.status === undefined) reasons.push('MISSING_TRANSACTION_STATUS');
        else if (!['confirmed','reversed','revised'].includes(v.status)) reasons.push('UNKNOWN_TRANSACTION_STATUS');
        if(v.status==='reversed'||v.status==='revised'||v.type==='sale_reversal'||v.previousTransactionId) reasons.push('REVERSAL_OR_REVISION_CHAIN_REQUIRES_REVIEW');
        if(v.type==='earn' && v.ref && entries(name).filter(([,t])=>t.type==='earn' && (!t.status||t.status==='confirmed') && String(t.ref||'').trim().toLowerCase()===String(v.ref).trim().toLowerCase()).length>1) reasons.push('DUPLICATE_ACTIVE_SALE_REFERENCE');
        if (v.type === 'redeem' || v.type === 'refund') {
          const candidates=entries('redemptions').filter(([,r])=>r[v.type==='redeem'?'transactionId':'refundTransactionId']===v.id);
          const r=candidates.length===1?candidates[0][1]:undefined;
          if (!r) reasons.push('REDEMPTION_LINK_MISSING_OR_AMBIGUOUS');
          else if ((v.redemptionId && v.redemptionId!==r.id)||v.customerId!==r.customerId||v.points!==(r.pointsUsed??r.points)) reasons.push('REDEMPTION_LEDGER_MISMATCH');
        }
      }
      if (name === 'redemptions') {
        if (!one('customers',v.customerId)) reasons.push('CUSTOMER_MISSING_OR_AMBIGUOUS');
        if (!one('rewards',v.rewardId)) reasons.push('REWARD_MISSING_OR_AMBIGUOUS');
        const points=v.pointsUsed??v.points;
        if(!amount(points)||points===0) reasons.push('INVALID_POINTS');
        if(v.pointsUsed!==undefined && v.points!==undefined && v.pointsUsed!==v.points)reasons.push('POINTS_SNAPSHOT_MISMATCH');
        if(!Number.isSafeInteger(v.quantity)||v.quantity<1)reasons.push('QUANTITY_MISSING_OR_INVALID');
        if(!['requested','completed','cancelled'].includes(v.status))reasons.push('STATUS_MISSING_OR_AMBIGUOUS');
        if(typeof v.stockReserved!=='boolean' && v.stockBefore===undefined)reasons.push('STOCK_RESERVATION_UNPROVEN');
        if(v.stockReserved!==undefined && typeof v.stockReserved!=='boolean')reasons.push('INVALID_STOCK_RESERVATION_FLAG');
        if(v.stockBefore!==undefined && v.stockBefore!==null && (!amount(v.stockBefore)||!Number.isInteger(v.stockBefore)))reasons.push('INVALID_STOCK_SNAPSHOT');
        if(v.stockReserved===true && v.stockBefore===null || v.stockReserved===false && typeof v.stockBefore==='number')reasons.push('STOCK_SNAPSHOT_CONTRADICTION');
        const debit=one('transactions',v.transactionId);
        if(!debit || debit.type!=='redeem'||debit.customerId!==v.customerId||debit.points!==points)reasons.push('DEBIT_MISSING_OR_MISMATCH');
        const refunds=entries('transactions').filter(([,t])=>t.type==='refund' && (t.redemptionId===v.id||t.id===v.refundTransactionId));
        if(v.status==='cancelled') {
          const refund=one('transactions',v.refundTransactionId);
          if(refunds.length!==1||!refund||refund.type!=='refund'||refund.customerId!==v.customerId||refund.points!==points||refund.status!=='confirmed')reasons.push('REFUND_MISSING_DUPLICATE_OR_MISMATCH');
          if(!v.refundedAt)reasons.push('REFUND_TIME_UNPROVEN');
        } else if(refunds.length||v.refundTransactionId||v.refundedAt)reasons.push('REFUND_WITHOUT_CANCELLATION');
      }
      add(name,key,[...new Set(reasons)]);
    }
  }
  // Old lock claim/financial patch/finish were separate writes. Even completed/failed is not proof.
  for (const key of Object.keys(collections.operationLocks)) add('operationLocks',key,['NON_ATOMIC_LEGACY_LOCK_OUTCOME_UNPROVEN']);
  return {mode:'DRY RUN',status:rows.some(r=>r.classification==='NEEDS REVIEW')?'NEEDS REVIEW':'STRUCTURALLY CONSISTENT',
    scope:'Local snapshot only; structural consistency is not balance certification or migration authorization',
    summary:{records:rows.length,needsReview:rows.filter(r=>r.classification==='NEEDS REVIEW').length},rows};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==3)throw Error('Usage: node scripts/legacy-reconciliation.mjs LOCAL_SYNTHETIC_OR_APPROVED_SNAPSHOT.json');
  const report=reconcile(JSON.parse(await readFile(resolve(process.argv[2]),'utf8')));
  console.log(JSON.stringify(report,null,2));
}
