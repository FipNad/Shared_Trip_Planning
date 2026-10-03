const ORIGIN = { name: 'Bucharest', lat: 44.4268, lon: 26.1025 };
const DESTINATIONS = { oulu:{name:'Oulu',lat:65.0121,lon:25.4651}, levi:{name:'Levi',lat:67.8051,lon:24.8028} };
const categories = new Set(['sightseeing','museum','nature','food','other']);
const encode = new TextEncoder();

function json(data,status=200,headers={}) { return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}}); }
function cors(request,env) {
  const origin=request.headers.get('Origin');
  const allowed=(env.ALLOWED_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);
  const accepted=origin&&(allowed.includes(origin)||allowed.includes('*')||origin==='http://localhost:8000'||origin==='http://127.0.0.1:8000');
  return {'Access-Control-Allow-Origin':accepted?origin:'null','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Trip-Key','Vary':'Origin'};
}
function fail(message,status=400) { const error=new Error(message); error.status=status; throw error; }
async function parseBody(request) {
  const raw=await request.text();
  if(raw.length>16000) fail('Request is too large',413);
  try { return JSON.parse(raw||'{}'); } catch { fail('Invalid JSON'); }
}
function bounded(value,max=500) { return typeof value==='string'?value.trim().slice(0,max):''; }
function id() { return crypto.randomUUID(); }
function validLeg(v) { if(v!=='out'&&v!=='back') fail('Choose outbound or return'); return v; }
function validCoordinate(v,min,max) { const n=Number(v); if(!Number.isFinite(n)||n<min||n>max) fail('Invalid coordinates'); return n; }
function validUrl(value) { const v=bounded(value,500); if(!v) return ''; try { const u=new URL(v); if(u.protocol==='http:'||u.protocol==='https:') return u.href; } catch {} fail('Invalid source URL'); }
function validActivity(body) {
  const leg=validLeg(body.leg), title=bounded(body.title,100), category=bounded(body.category,30);
  if(!title) fail('Activity title is required');
  if(!categories.has(category)) fail('Invalid activity type');
  return {leg,title,category,description:bounded(body.description,500),source_url:validUrl(body.source_url),proposed_by:bounded(body.proposed_by,40)||'Friend',status:body.status==='planned'?'planned':'suggested',stop_id:body.stop_id?bounded(body.stop_id,80):null,locality:bounded(body.locality,100)};
}
async function verifyKey(request,env) {
  if(!env.TRIP_PASSPHRASE) fail('TRIP_PASSPHRASE secret is not configured',503);
  const supplied=request.headers.get('X-Trip-Key')||'';
  if(!supplied||supplied.length>200) fail('Trip passphrase required',401);
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(supplied)),crypto.subtle.digest('SHA-256',encode.encode(env.TRIP_PASSPHRASE))]);
  const aa=new Uint8Array(a),bb=new Uint8Array(b); let difference=0;
  for(let i=0;i<aa.length;i++) difference|=aa[i]^bb[i];
  if(difference!==0) fail('Incorrect trip passphrase',401);
}
async function state(db) {
  const [config,stops,activities]=await Promise.all([
    db.prepare('SELECT destination FROM trip_config WHERE id=1').first(),
    db.prepare('SELECT * FROM stops ORDER BY leg, position, created_at').all(),
    db.prepare('SELECT * FROM activities ORDER BY created_at DESC').all()
  ]);
  return {config:config||{destination:'oulu'},stops:stops.results,activities:activities.results};
}
async function existsStop(db,stopId,leg) {
  if(!stopId) return;
  const found=await db.prepare('SELECT id FROM stops WHERE id=? AND leg=?').bind(stopId,leg).first();
  if(!found) fail('Selected stop does not exist on this route');
}
async function route(request,env) {
  const body=await parseBody(request), coordinates=body.coordinates;
  if(!Array.isArray(coordinates)||coordinates.length<2||coordinates.length>18) fail('Use 2 to 18 route points');
  const points=coordinates.map(pair=>{
    if(!Array.isArray(pair)||pair.length!==2) fail('Invalid route point');
    return [validCoordinate(pair[0],-180,180),validCoordinate(pair[1],-90,90)];
  });
  const provider=env.ORS_API_KEY?'ors':'osrm';
  const cacheKey=JSON.stringify([provider,points]);
  const cached=await env.DB.prepare('SELECT data FROM route_cache WHERE cache_key=? AND created_at > datetime(\'now\',\'-7 days\')').bind(cacheKey).first();
  if(cached) return JSON.parse(cached.data);
  let result;
  if(env.ORS_API_KEY) {
    const response=await fetch('https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson',{method:'POST',headers:{'Authorization':env.ORS_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({coordinates:points})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.features?.[0]) fail(`Routing service error: ${data.error?.message||response.status}`,502);
    result={distance_m:data.features[0].properties.summary.distance,geometry:data.features[0].geometry,provider:'openrouteservice'};
  } else {
    const coords=points.map(p=>p.join(',')).join(';');
    const response=await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.code!=='Ok'||!data.routes?.[0]) fail(`Routing service error: ${data.message||response.status}`,502);
    result={distance_m:data.routes[0].distance,geometry:data.routes[0].geometry,provider:'OSRM demo'};
  }
  await env.DB.prepare('INSERT OR REPLACE INTO route_cache(cache_key,data,created_at) VALUES(?,?,CURRENT_TIMESTAMP)').bind(cacheKey,JSON.stringify(result)).run();
  return result;
}

const ideaSchema={
  type:'object',additionalProperties:false,required:['ideas'],properties:{ideas:{type:'array',items:{type:'object',additionalProperties:false,
    required:['leg','stop_id','title','category','locality','description','source_url'],properties:{
      leg:{type:'string',enum:['out','back']},stop_id:{type:'string'},title:{type:'string'},
      category:{type:'string',enum:['sightseeing','museum','nature','food','other']},
      locality:{type:'string'},description:{type:'string'},source_url:{type:'string'}
    }}}}
};
async function suggest(request,env) {
  if(!env.OPENAI_API_KEY) fail('Add an OPENAI_API_KEY Worker secret to enable AI suggestions',503);
  const body=await parseBody(request), selected=['out','back'].includes(body.leg)?[body.leg]:body.leg==='both'?['out','back']:null;
  if(!selected) fail('Choose outbound, return, or both');
  const day=new Date().toISOString().slice(0,10);
  const count=await env.DB.prepare('SELECT calls FROM ai_usage WHERE day=?').bind(day).first();
  if((count?.calls||0)>=3) fail('Daily suggestion limit reached. Try again tomorrow.',429);
  const snapshot=await state(env.DB), dest=DESTINATIONS[snapshot.config.destination]||DESTINATIONS.oulu;
  const routes=selected.map(leg=>({leg,places:leg==='out'?[ORIGIN,...snapshot.stops.filter(s=>s.leg==='out').sort((a,b)=>a.position-b.position),dest]:[dest,...snapshot.stops.filter(s=>s.leg==='back').sort((a,b)=>a.position-b.position),ORIGIN]}));
  const prompt={destination:dest.name,routes:routes.map(r=>({leg:r.leg,places:r.places.map(p=>({id:p.id||'',name:p.name,lat:p.lat,lon:p.lon}))})),existing_ideas:snapshot.activities.map(a=>({leg:a.leg,title:a.title,locality:a.locality}))};
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:env.OPENAI_MODEL||'gpt-4.1-mini',store:false,max_output_tokens:2000,input:[
    {role:'system',content:'You suggest realistic road-trip stops and activities in Europe. Return 4 to 8 concise, diverse suggestions near the supplied route stops. Historical memorials must be described respectfully. Do not duplicate existing ideas. Use the supplied stop ID when relevant, otherwise an empty string. Never invent official URLs: source_url must be empty unless you are highly confident it is the official site. Do not claim current opening hours, ticket availability, road conditions, or border rules.'},
    {role:'user',content:JSON.stringify(prompt)}
  ],text:{format:{type:'json_schema',name:'route_ideas',strict:true,schema:ideaSchema}}})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) fail(`OpenAI request failed: ${data.error?.message||response.status}`,502);
  const output=data.output?.flatMap(item=>item.content||[]).find(item=>item.type==='output_text')?.text;
  if(!output) fail('OpenAI returned no activity list',502);
  let parsed; try { parsed=JSON.parse(output); } catch { fail('OpenAI returned invalid JSON',502); }
  if(!Array.isArray(parsed.ideas)) fail('OpenAI returned an invalid activity list',502);
  const known=new Set(snapshot.activities.map(a=>`${a.leg}:${a.title.toLocaleLowerCase()}`));
  const inserts=[];
  for(const raw of parsed.ideas.slice(0,8)) {
    if(!selected.includes(raw.leg)||!categories.has(raw.category)) continue;
    const title=bounded(raw.title,100), k=`${raw.leg}:${title.toLocaleLowerCase()}`;
    if(!title||known.has(k)) continue;
    known.add(k);
    const stopId=snapshot.stops.some(s=>s.id===raw.stop_id&&s.leg===raw.leg)?raw.stop_id:null;
    let sourceUrl=''; try {sourceUrl=validUrl(raw.source_url);} catch {}
    inserts.push(env.DB.prepare('INSERT INTO activities(id,leg,stop_id,title,category,locality,description,source_url,proposed_by,status) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id(),raw.leg,stopId,title,raw.category,bounded(raw.locality,100),bounded(raw.description,500),sourceUrl,'AI suggestion','suggested'));
  }
  if(inserts.length) await env.DB.batch(inserts);
  await env.DB.prepare('INSERT INTO ai_usage(day,calls) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1').bind(day).run();
  return {added:inserts.length,ideas:parsed.ideas.length};
}

async function handle(request,env) {
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if(path==='/api/health'&&method==='GET') return {ok:true};
  await verifyKey(request,env);
  const db=env.DB;
  if(path==='/api/state'&&method==='GET') return state(db);
  if(path==='/api/route'&&method==='POST') return route(request,env);
  if(path==='/api/suggestions'&&method==='POST') return suggest(request,env);
  if(path==='/api/config'&&method==='PUT') {
    const {destination}=await parseBody(request);
    if(!DESTINATIONS[destination]) fail('Choose Oulu or Levi');
    await db.prepare('UPDATE trip_config SET destination=? WHERE id=1').bind(destination).run();
    return {destination};
  }
  if(path==='/api/stops'&&method==='POST') {
    const body=await parseBody(request), leg=validLeg(body.leg), name=bounded(body.name,120);
    if(!name) fail('Stop name is required');
    const lat=validCoordinate(body.lat,-90,90),lon=validCoordinate(body.lon,-180,180);
    const count=await db.prepare('SELECT COUNT(*) AS n FROM stops WHERE leg=?').bind(leg).first();
    if(count.n>=16) fail('Maximum 16 stops per route');
    const order=await db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM stops WHERE leg=?').bind(leg).first();
    const stop={id:id(),leg,name,lat,lon,nights:Math.max(0,Math.min(30,Number(body.nights)||0)),note:bounded(body.note,500),position:order.n,created_by:bounded(body.created_by,40)||'Friend'};
    await db.prepare('INSERT INTO stops(id,leg,name,lat,lon,nights,note,position,created_by) VALUES(?,?,?,?,?,?,?,?,?)').bind(stop.id,stop.leg,stop.name,stop.lat,stop.lon,stop.nights,stop.note,stop.position,stop.created_by).run();
    return stop;
  }
  if(path==='/api/stops/order'&&method==='PUT') {
    const body=await parseBody(request),leg=validLeg(body.leg),items=await db.prepare('SELECT id FROM stops WHERE leg=?').bind(leg).all();
    const expected=new Set(items.results.map(s=>s.id));
    if(!Array.isArray(body.ids)||body.ids.length!==expected.size||new Set(body.ids).size!==expected.size||body.ids.some(x=>!expected.has(x))) fail('Stop order is out of date. Refresh and try again.',409);
    await db.batch(body.ids.map((stopId,i)=>db.prepare('UPDATE stops SET position=? WHERE id=? AND leg=?').bind(i,stopId,leg)));
    return {ok:true};
  }
  const stopMatch=path.match(/^\/api\/stops\/([a-zA-Z0-9-]+)$/);
  if(stopMatch) {
    const stopId=stopMatch[1],found=await db.prepare('SELECT id FROM stops WHERE id=?').bind(stopId).first();
    if(!found) fail('Stop not found',404);
    if(method==='PATCH') { const b=await parseBody(request), nights=Math.max(0,Math.min(30,Number(b.nights)||0)), note=bounded(b.note,500);await db.prepare('UPDATE stops SET nights=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(nights,note,stopId).run();return {ok:true}; }
    if(method==='DELETE') { await db.batch([db.prepare('UPDATE activities SET stop_id=NULL WHERE stop_id=?').bind(stopId),db.prepare('DELETE FROM stops WHERE id=?').bind(stopId)]);return {ok:true}; }
  }
  if(path==='/api/activities'&&method==='POST') {
    const a=validActivity(await parseBody(request));await existsStop(db,a.stop_id,a.leg);a.id=id();
    await db.prepare('INSERT INTO activities(id,leg,stop_id,title,category,locality,description,source_url,proposed_by,status) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(a.id,a.leg,a.stop_id,a.title,a.category,a.locality,a.description,a.source_url,a.proposed_by,a.status).run();
    return a;
  }
  const activityMatch=path.match(/^\/api\/activities\/([a-zA-Z0-9-]+)$/);
  if(activityMatch) {
    const activityId=activityMatch[1],found=await db.prepare('SELECT id FROM activities WHERE id=?').bind(activityId).first();
    if(!found) fail('Activity not found',404);
    if(method==='PATCH') { const a=validActivity(await parseBody(request));await existsStop(db,a.stop_id,a.leg);await db.prepare('UPDATE activities SET leg=?,stop_id=?,title=?,category=?,locality=?,description=?,source_url=?,proposed_by=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(a.leg,a.stop_id,a.title,a.category,a.locality,a.description,a.source_url,a.proposed_by,a.status,activityId).run();return {ok:true}; }
    if(method==='DELETE') {await db.prepare('DELETE FROM activities WHERE id=?').bind(activityId).run();return {ok:true};}
  }
  fail('Endpoint not found',404);
}

export default { async fetch(request,env) {
  const headers=cors(request,env);
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers});
  try { return json(await handle(request,env),200,headers); }
  catch(error) { if(!error.status) console.error(error);return json({error:error.status?error.message:'Unexpected server error'},error.status||500,headers); }
}};
