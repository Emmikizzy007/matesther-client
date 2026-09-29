/* Local-only regression test. Never point at a production URL.
   Requires demo data in local Postgres and a running local preview. */
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:3000';
const stamp = Date.now();
async function api(path, method='GET', body, cookie, extraHeaders={}) {
  const response = await fetch(base+path, {method, headers: { ...(body?{'content-type':'application/json'}:{}), ...(cookie?{cookie}:{}), ...extraHeaders }, ...(body?{body:JSON.stringify(body)}:{}) });
  return {status:response.status, data:await response.json().catch(()=>({})), token:response.headers.get('set-cookie')?.match(/matesther_session=([^;]+)/)?.[1]};
}
function expect(result, status, label) {
  assert.equal(result.status, status, `${label}: HTTP ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}
(async()=>{
  const ownerLogin=await api('/api/auth/login','POST',{email:'estheradejugba@gmail.com',password:'owner123'});
  expect(ownerLogin,200,'Owner login'); const owner=`matesther_session=${ownerLogin.token}`;
  let cutterId, otherId, customerId, orderId;
  try {
    const cutter=expect(await api('/api/users','POST',{name:'Alhaji Musa Ibrahim',email:`cutter-supervisor-${stamp}@test.example`,password:'StrongTest123',role:'PRODUCTION_MANAGER',workerId:1},owner),201,'Create cutter-manager');
    cutterId=cutter.id;
    const cutterLogin=await api('/api/auth/login','POST',{email:cutter.email,password:'StrongTest123'});
    expect(cutterLogin,200,'Cutter manager login'); const cutterCookie=`matesther_session=${cutterLogin.token}`;
    const other=expect(await api('/api/users','POST',{name:'Non-cutting Supervisor',email:`supervisor-${stamp}@test.example`,password:'StrongTest123',role:'PRODUCTION_MANAGER'},owner),201,'Create non-cutting PM');
    otherId=other.id;
    const otherLogin=await api('/api/auth/login','POST',{email:other.email,password:'StrongTest123'});
    expect(otherLogin,200,'Other manager login'); const otherCookie=`matesther_session=${otherLogin.token}`;

    const ownerRights=expect(await api('/api/production-access','GET',undefined,owner),200,'Owner permissions');
    const cutterRights=expect(await api('/api/production-access','GET',undefined,cutterCookie),200,'Cutter supervisor permissions');
    const otherRights=expect(await api('/api/production-access','GET',undefined,otherCookie),200,'Other manager permissions');
    assert.equal(ownerRights.canAssignCutting,true);
    assert.equal(cutterRights.canAssignCutting,false);
    assert.equal(cutterRights.workerId,1);
    assert.equal(otherRights.canAssignCutting,true);
    console.log('Cutting assignment permissions: Owner yes, Cutter supervisor no, other manager yes.');

    const myWork=expect(await api('/api/dashboard?view=my-work','GET',undefined,cutterCookie),200,'Cutter supervisor own jobs');
    assert.equal(myWork.profile.id,1); assert.equal('revenue' in myWork,false);
    expect(await api('/api/payroll','GET',undefined,cutterCookie),403,'No company payroll');
    expect(await api('/api/reports','GET',undefined,cutterCookie),403,'No financial reports');
    const school=expect(await api('/api/customers','POST',{name:`School ${stamp}`,type:'SCHOOL'},owner),201,'Temporary school');
    customerId=school.id;
    const order=expect(await api('/api/orders','POST',{orderNumber:`ORD-SEC-${stamp}`,customerId,orderDate:'2026-09-24',dueDate:'2026-10-24',items:[{productId:1,quantity:10,unitPrice:4500}]},owner),201,'Temporary order');
    orderId=order.id;
    const safeOrders=expect(await api('/api/production-orders','GET',undefined,cutterCookie),200,'Production-only order catalogue');
    const item=safeOrders.find(x=>x.id===orderId)?.items[0]; assert.ok(item);
    assert.equal(item.unitPrice,undefined);

    const assignment={orderId,orderItemId:item.id,quantity:5,size:'M',color:'Navy',cuttingRate:175,tailorId:3,sewingRate:450,expectedCompletionDate:'2026-10-20'};
    expect(await api('/api/batches','POST',{...assignment,workerId:1},cutterCookie),403,'Self cutting assignment blocked');
    expect(await api('/api/batches','POST',{...assignment,workerId:2},cutterCookie),403,'Other cutter assignment blocked');
    const batch=expect(await api('/api/batches','POST',{...assignment,workerId:null},cutterCookie),201,'Cutter supervisor creates batch without assigning Cutter');
    const ops=expect(await api(`/api/operations?orderId=${orderId}`,'GET',undefined,cutterCookie),200,'Batch operations');
    const cutting=ops.find(x=>x.productionBatchId===batch.id&&x.stage==='CUTTING');
    const sewing=ops.find(x=>x.productionBatchId===batch.id&&x.stage==='SEWING');
    assert.equal(cutting.workerId,null); assert.equal(sewing.workerId,3); assert.equal(sewing.pieceRate,450);
    expect(await api('/api/operations','PUT',{id:cutting.id,workerId:1,pieceRate:175,status:'IN_PROGRESS'},cutterCookie),403,'Cutter supervisor cannot edit Cutting');
    expect(await api('/api/operations','PUT',{id:cutting.id,workerId:2,pieceRate:175,status:'IN_PROGRESS'},cutterCookie),403,'Cutter supervisor cannot assign other cutters on board');
    expect(await api('/api/operations','PUT',{id:cutting.id,workerId:1,pieceRate:175,status:'IN_PROGRESS'},owner),200,'Owner assigns Cutter');
    expect(await api('/api/operations','PUT',{id:cutting.id,submitQty:3},cutterCookie),200,'Cutter supervisor submits own work');
    const ownQueue=expect(await api('/api/dashboard?view=pm','GET',undefined,cutterCookie),200,'Cutter manager inspection queue');
    assert.ok(ownQueue.inspection.awaiting.some(x=>x.id===cutting.id&&x.customer===school.name));
    const inspect={operationId:cutting.id,quantityApproved:2,quantityRework:1,quantityRejected:0,notes:'One piece needs correction',inspectedBy:'Esther Adejugba'};
    expect(await api('/api/inspections','POST',inspect,cutterCookie),403,'Cutter cannot approve their own work or forge inspector');
    const crossSite=await api('/api/inspections','POST',inspect,otherCookie,{origin:'https://malicious.example','sec-fetch-site':'cross-site'});
    expect(crossSite,403,'Cross-origin write blocked');
    const approved=expect(await api('/api/inspections','POST',inspect,otherCookie),201,'Different manager inspects');
    assert.equal(approved.inspector,other.name);
    expect(await api('/api/operations','PUT',{id:cutting.id,submitQty:1},cutterCookie),200,'Own rework submitted');
    const ownerCheck=expect(await api('/api/inspections','POST',{operationId:cutting.id,quantityApproved:1,quantityRework:0,quantityRejected:0},owner),201,'Owner approval');
    assert.equal(ownerCheck.inspector,'Esther Adejugba');
    const paid=expect(await api('/api/dashboard?view=my-work','GET',undefined,cutterCookie),200,'Personal pay after inspection');
    assert.equal(paid.earnings.total,myWork.earnings.total+3*175);
    console.log('Cutter self-inspection blocked. Different manager and Owner approved. Own earnings rose by ₦525; company finances stayed hidden.');
  } finally {
    if(orderId) console.log('Cleaned up order:',(await api(`/api/orders/${orderId}`,'DELETE',undefined,owner)).status);
    if(customerId) console.log('Cleaned up school:',(await api(`/api/customers/${customerId}`,'DELETE',undefined,owner)).status);
    if(cutterId) console.log('Cleaned up cutter manager:',(await api(`/api/users?id=${cutterId}`,'DELETE',undefined,owner)).status);
    if(otherId) console.log('Cleaned up other manager:',(await api(`/api/users?id=${otherId}`,'DELETE',undefined,owner)).status);
  }
})().catch(error=>{console.error(error);process.exitCode=1});
