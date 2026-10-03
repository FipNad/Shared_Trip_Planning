import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/src/index.js';

function setup() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../worker/migrations/0001_initial.sql',import.meta.url),'utf8'));
  const db={
    prepare(sql) {
      const statement=values=>({
        first:async()=>sqlite.prepare(sql).get(...values),
        all:async()=>({results:sqlite.prepare(sql).all(...values)}),
        run:async()=>sqlite.prepare(sql).run(...values)
      });
      return {...statement([]),bind:(...values)=>statement(values)};
    },
    batch:async statements=>Promise.all(statements.map(s=>s.run()))
  };
  return {DB:db,TRIP_PASSPHRASE:'a-long-group-passphrase',ALLOWED_ORIGIN:'https://example.github.io'};
}
async function call(env,path,method='GET',body,pass='a-long-group-passphrase') {
  const response=await worker.fetch(new Request(`https://example.workers.dev/api${path}`,{method,headers:{Origin:'https://example.github.io','X-Trip-Key':pass,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env);
  return {status:response.status,body:await response.json(),cors:response.headers.get('Access-Control-Allow-Origin')};
}

test('passphrase protects the shared trip and CORS allows the configured site',async()=>{
  const env=setup();
  const denied=await call(env,'/state','GET',undefined,'wrong');
  assert.equal(denied.status,401);
  const ok=await call(env,'/state');
  assert.equal(ok.status,200);
  assert.equal(ok.cors,'https://example.github.io');
  assert.equal(ok.body.config.destination,'oulu');
  assert.ok(ok.body.stops.length>0);
});

test('friends can add, reorder and delete stops and edit activity decisions',async()=>{
  const env=setup();
  const added=await call(env,'/stops','POST',{leg:'out',name:'Brno',lat:49.1951,lon:16.6068,nights:1,created_by:'Alex'});
  assert.equal(added.status,200);
  const state=await call(env,'/state');
  const ids=state.body.stops.filter(s=>s.leg==='out').map(s=>s.id);
  const order=await call(env,'/stops/order','PUT',{leg:'out',ids:[added.body.id,...ids.filter(id=>id!==added.body.id)]});
  assert.equal(order.status,200);
  const activity=await call(env,'/activities','POST',{leg:'out',stop_id:added.body.id,title:'Castle walk',category:'sightseeing',description:'On the way',source_url:'',proposed_by:'Alex'});
  assert.equal(activity.status,200);
  const planned=await call(env,`/activities/${activity.body.id}`,'PATCH',{...activity.body,status:'planned'});
  assert.equal(planned.status,200);
  const removed=await call(env,`/stops/${added.body.id}`,'DELETE');
  assert.equal(removed.status,200);
  const final=await call(env,'/state');
  assert.equal(final.body.activities.find(a=>a.id===activity.body.id).stop_id,null);
  assert.equal(final.body.activities.find(a=>a.id===activity.body.id).status,'planned');
});

test('route returns road geometry and caches the provider result',async()=>{
  const env=setup();
  let fetches=0;
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{ fetches++; return new Response(JSON.stringify({code:'Ok',routes:[{distance:123456,geometry:{type:'LineString',coordinates:[[26.1,44.4],[19.04,47.5]]}}]}),{status:200}); };
  try {
    const body={coordinates:[[26.1,44.4],[19.04,47.5]]};
    const first=await call(env,'/route','POST',body), second=await call(env,'/route','POST',body);
    assert.equal(first.body.distance_m,123456);
    assert.deepEqual(first.body.geometry.coordinates,second.body.geometry.coordinates);
    assert.equal(fetches,1);
  } finally { globalThis.fetch=original; }
});

test('ORS routing uses the current HeiGIT endpoint when a key is configured',async()=>{
  const env={...setup(),ORS_API_KEY:'test-route-key'};
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson');
    assert.equal(options.headers.Authorization,'test-route-key');
    return new Response(JSON.stringify({features:[{properties:{summary:{distance:234567}},geometry:{type:'LineString',coordinates:[[26.1,44.4],[19.04,47.5]]}}]}),{status:200});
  };
  try {
    const response=await call(env,'/route','POST',{coordinates:[[26.1,44.4],[19.04,47.5]]});
    assert.equal(response.status,200);
    assert.equal(response.body.distance_m,234567);
  } finally { globalThis.fetch=original; }
});

test('AI suggestions use structured output and become editable activities',async()=>{
  const env={...setup(),OPENAI_API_KEY:'test-key'};
  const original=globalThis.fetch;
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);
    assert.equal(request.store,false);
    assert.equal(request.text.format.type,'json_schema');
    assert.equal(request.text.format.strict,true);
    const suggestions={ideas:[
      {leg:'out',stop_id:'out-krakow',title:'Wawel Royal Castle',category:'museum',locality:'Kraków',description:'A possible history stop.',source_url:''},
      {leg:'out',stop_id:'out-krakow',title:'Wieliczka Salt Mine',category:'museum',locality:'Kraków',description:'Duplicate starter idea.',source_url:''}
    ]};
    return new Response(JSON.stringify({output:[{content:[{type:'output_text',text:JSON.stringify(suggestions)}]}]}),{status:200});
  };
  try {
    const response=await call(env,'/suggestions','POST',{leg:'out'});
    assert.equal(response.status,200);
    assert.equal(response.body.added,1);
    const updated=await call(env,'/state');
    assert.equal(updated.body.activities.find(a=>a.title==='Wawel Royal Castle').stop_id,'out-krakow');
  } finally { globalThis.fetch=original; }
});
