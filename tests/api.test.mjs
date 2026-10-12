import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import worker from '../worker/src/index.js';

function setup() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../worker/migrations/0001_initial.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../worker/migrations/0002_accommodation.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../worker/migrations/0003_flexible_destinations.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../worker/migrations/0004_trip_start_date.sql',import.meta.url),'utf8'));
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
  assert.equal(ok.body.config.start_date,'');
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
  globalThis.fetch=async()=>{ fetches++; return new Response(JSON.stringify({code:'Ok',routes:[{distance:123456,legs:[{distance:123456}],geometry:{type:'LineString',coordinates:[[26.1,44.4],[19.04,47.5]]}}]}),{status:200}); };
  try {
    const body={coordinates:[[26.1,44.4],[19.04,47.5]]};
    const first=await call(env,'/route','POST',body), second=await call(env,'/route','POST',body);
    assert.equal(first.body.distance_m,123456);
    assert.deepEqual(first.body.segments_m,[123456]);
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
    return new Response(JSON.stringify({features:[{properties:{summary:{distance:234567},segments:[{distance:234567}]},geometry:{type:'LineString',coordinates:[[26.1,44.4],[19.04,47.5]]}}]}),{status:200});
  };
  try {
    const response=await call(env,'/route','POST',{coordinates:[[26.1,44.4],[19.04,47.5]]});
    assert.equal(response.status,200);
    assert.equal(response.body.distance_m,234567);
    assert.deepEqual(response.body.segments_m,[234567]);
  } finally { globalThis.fetch=original; }
});

test('friends can compare accommodations by night and removed nights clear their options',async()=>{
  const env=setup();
  const option={leg:'out',stop_id:'out-krakow',night_number:2,name:'Old Town Apartment',price_amount:125.5,currency:'EUR',rating:8.7,rating_scale:10,review_count:240,review_source:'Booking.com',review_note:'Walkable to the centre',booking_url:'https://example.com/stay',image_urls:['https://example.com/one.jpg','https://example.com/two.jpg'],proposed_by:'Alex'};
  const created=await call(env,'/accommodations','POST',option);
  assert.equal(created.status,200);
  const invalid=await call(env,'/accommodations','POST',{...option,night_number:3});
  assert.equal(invalid.status,400);
  const unsafeImage=await call(env,'/accommodations','POST',{...option,image_urls:['javascript:alert(1)']});
  assert.equal(unsafeImage.status,400);
  const noListing=await call(env,'/accommodations','POST',{...option,booking_url:''});
  assert.equal(noListing.status,400);
  const wrongScale=await call(env,'/accommodations','POST',{...option,rating_scale:5});
  assert.equal(wrongScale.status,400);
  const wrongRoute=await call(env,'/accommodations','POST',{...option,leg:'back'});
  assert.equal(wrongRoute.status,400);
  const state=await call(env,'/state');
  assert.deepEqual(state.body.accommodations[0].image_urls,option.image_urls);
  assert.equal(state.body.accommodations[0].rating,8.7);
  assert.equal(state.body.accommodations[0].review_source,'Booking.com');
  const changed=await call(env,`/accommodations/${created.body.id}`,'PATCH',{...option,price_amount:115});
  assert.equal(changed.status,200);
  const afterEdit=await call(env,'/state');
  assert.equal(afterEdit.body.accommodations[0].price_amount,115);
  const shortened=await call(env,'/stops/out-krakow','PATCH',{nights:1,note:''});
  assert.equal(shortened.status,200);
  const afterShortening=await call(env,'/state');
  assert.equal(afterShortening.body.accommodations.length,0);

  const destination=await call(env,'/accommodations','POST',{...option,leg:'destination',stop_id:null,night_number:3,name:'Lapland Lodge'});
  assert.equal(destination.status,200);
  const config=await call(env,'/config','PUT',{destination:'oulu',destination_nights:2});
  assert.equal(config.status,200);
  const afterDestination=await call(env,'/state');
  assert.equal(afterDestination.body.config.destination_nights,2);
  assert.equal(afterDestination.body.accommodations.length,0);
  const oulu=await call(env,'/accommodations','POST',{...option,leg:'destination',stop_id:null,night_number:1,name:'Oulu Hotel'});
  assert.equal(oulu.status,200);
  await call(env,'/config','PUT',{destination:'levi',destination_nights:2});
  const afterSwitch=await call(env,'/state');
  assert.equal(afterSwitch.body.accommodations[0].destination_code,'oulu');
  const changedDestination=await call(env,'/config','PUT',{destination:'rovaniemi',destination_nights:2});
  assert.equal(changedDestination.status,200);
  const rovaniemi=await call(env,'/accommodations','POST',{...option,leg:'destination',stop_id:null,night_number:1,name:'Rovaniemi Hotel'});
  assert.equal(rovaniemi.status,200);
  const afterRovaniemi=await call(env,'/state');
  assert.equal(afterRovaniemi.body.accommodations.find(a=>a.name==='Rovaniemi Hotel').destination_code,'rovaniemi');
});

test('destination migration preserves earlier stays and accepts Rovaniemi',()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../worker/migrations/0001_initial.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../worker/migrations/0002_accommodation.sql',import.meta.url),'utf8'));
  sqlite.exec("INSERT INTO accommodations(id,leg,destination_code,night_number,name,price_amount) VALUES('existing','destination','oulu',1,'Existing stay',100)");
  sqlite.exec(readFileSync(new URL('../worker/migrations/0003_flexible_destinations.sql',import.meta.url),'utf8'));
  assert.equal(sqlite.prepare("SELECT name FROM accommodations WHERE id='existing'").get().name,'Existing stay');
  sqlite.exec("INSERT INTO accommodations(id,leg,destination_code,night_number,name,price_amount) VALUES('new','destination','rovaniemi',1,'New stay',120)");
  assert.equal(sqlite.prepare("SELECT name FROM accommodations WHERE id='new'").get().name,'New stay');
});

test('Rovaniemi starter return stop does not create a duplicate routing waypoint',()=>{
  const source=readFileSync(new URL('../site/app.js',import.meta.url),'utf8');
  const context={document:{addEventListener(){}},localStorage:{getItem(){return null;}},sessionStorage:{getItem(){return null;}}};
  runInNewContext(`${source}\nstate.config.destination='rovaniemi';globalThis.routePlanTest=routingPlan('back');`,context);
  const plan=context.routePlanTest;
  assert.equal(plan.unique[0].name,'Rovaniemi');
  assert.equal(plan.segmentIndex[0],null);
  assert.equal(plan.unique.filter(p=>p.name==='Rovaniemi').length,1);
});

test('departure date is shared, validated, and preserved when changing destination',async()=>{
  const env=setup();
  const saved=await call(env,'/config','PUT',{destination:'oulu',start_date:'2028-02-28'});
  assert.equal(saved.status,200);
  assert.equal(saved.body.start_date,'2028-02-28');
  const invalid=await call(env,'/config','PUT',{destination:'oulu',start_date:'2027-02-29'});
  assert.equal(invalid.status,400);
  const changed=await call(env,'/config','PUT',{destination:'levi'});
  assert.equal(changed.status,200);
  const refreshed=await call(env,'/state');
  assert.equal(refreshed.body.config.start_date,'2028-02-28');
});

test('arrival schedule crosses leap day and carries days into the return route',()=>{
  const source=readFileSync(new URL('../site/app.js',import.meta.url),'utf8');
  const context={document:{addEventListener(){}},localStorage:{getItem(){return null;}},sessionStorage:{getItem(){return null;}}};
  runInNewContext(`${source}\nstate.config.start_date='2028-02-28';globalThis.scheduleTest=tripSchedule();state.stops.find(s=>s.leg==='out'&&s.name==='Budapest').nights=0;globalThis.updatedSchedule=tripSchedule();`,context);
  const schedule=context.scheduleTest;
  assert.equal(schedule.out[0].iso,'2028-02-28');
  assert.equal(schedule.out[2].iso,'2028-02-29');
  assert.equal(schedule.out.at(-1).iso,'2028-03-06');
  assert.equal(schedule.back[0].iso,'2028-03-09');
  assert.equal(schedule.back.at(-1).iso,'2028-03-14');
  assert.equal(schedule.back.at(-1).day,16);
  assert.equal(context.updatedSchedule.out[2].iso,'2028-02-28');
  assert.equal(context.updatedSchedule.back[0].iso,'2028-03-08');
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
