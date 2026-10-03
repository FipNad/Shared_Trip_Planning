/* Northbound: static frontend; the optional Worker supplies shared persistence and API keys. */
const ORIGIN = { name: 'Bucharest', lat: 44.4268, lon: 26.1025 };
const DESTINATIONS = {
  oulu: { name: 'Oulu', lat: 65.0121, lon: 25.4651 },
  levi: { name: 'Levi', lat: 67.8051, lon: 24.8028 }
};
const seed = () => ({
  config: { destination: 'oulu' },
  stops: [
    ['out','Budapest',47.4979,19.0402,1],['out','Kraków',50.0647,19.9450,2],
    ['out','Warsaw',52.2297,21.0122,1],['out','Riga',56.9496,24.1052,1],
    ['out','Tallinn',59.4370,24.7536,1],['out','Helsinki',60.1699,24.9384,1],
    ['back','Rovaniemi',66.5039,25.7294,1],['back','Helsinki',60.1699,24.9384,1],
    ['back','Vilnius',54.6872,25.2797,1],['back','Kraków',50.0647,19.9450,1],
    ['back','Budapest',47.4979,19.0402,1]
  ].map((v,i) => ({ id:`seed-${i}`, leg:v[0], name:v[1], lat:v[2], lon:v[3], nights:v[4], note:'', position:v[0]==='out'?i:i-6, created_by:'Starter route' })),
  activities: [
    ['out','Auschwitz-Birkenau Memorial and Museum','museum','Kraków','A major historical memorial near Kraków. Reserve a visit and allow substantial time.','https://www.auschwitz.org/'],
    ['out','Wieliczka Salt Mine','museum','Kraków','A historic underground mine close to Kraków.','https://www.kopalnia.pl/'],
    ['out','Riga Old Town','sightseeing','Riga','A walk through the historic centre before heading north.',''],
    ['out','Tallinn Old Town','sightseeing','Tallinn','Explore the medieval centre before the ferry to Finland.',''],
    ['back','Arktikum','museum','Rovaniemi','A museum and science centre focused on the Arctic.','https://www.arktikum.fi/'],
    ['back','Vilnius Old Town','sightseeing','Vilnius','A possible walking stop on the return.','']
  ].map((v,i) => ({ id:`idea-${i}`, leg:v[0], title:v[1], category:v[2], locality:v[3], description:v[4], source_url:v[5], stop_id:null, status:'suggested', proposed_by:'Starter idea' }))
});

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let state = seed();
let backend = localStorage.getItem('northbound_backend') || '';
let tripKey = sessionStorage.getItem('northbound_key') || '';
let displayName = localStorage.getItem('northbound_name') || '';
let activeView = 'parallel';
let activeFilter = 'all';
let maps = {};
let routeData = { out:null, back:null };
let routeCache = {};
let lastRouteFingerprint = '';
let routeRun = 0;
let editingStop = null;
let editingIdea = null;
let toastTimer;

function escapeHtml(v='') { return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function notify(message) { const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),3500); }
function safeUrl(raw) { try { const u=new URL(raw); return ['https:','http:'].includes(u.protocol)?u.href:''; } catch { return ''; } }
function km(meters) { return Number.isFinite(meters) ? `${Math.round(meters/1000).toLocaleString()} km` : '—'; }
function routeStops(leg) { return state.stops.filter(s=>s.leg===leg).sort((a,b)=>a.position-b.position); }
function points(leg) { const dest=DESTINATIONS[state.config.destination]||DESTINATIONS.oulu; return leg==='out'?[ORIGIN,...routeStops('out'),dest]:[dest,...routeStops('back'),ORIGIN]; }
function isShared() { return !!(backend && tripKey); }
async function api(path,method='GET',body,override) {
  const base=override?.backend ?? backend, key=override?.key ?? tripKey;
  const response=await fetch(`${base.replace(/\/$/,'')}/api${path}`,{method,headers:{'Content-Type':'application/json','X-Trip-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>({error:`HTTP ${response.status}`}));
  if(!response.ok) throw new Error(data.error||`HTTP ${response.status}`);
  return data;
}
async function loadState() {
  if(isShared()) {
    state=await api('/state');
    $('#sync-status').textContent='Shared trip · live';
  } else {
    try { state=JSON.parse(localStorage.getItem('northbound_draft'))||seed(); } catch { state=seed(); }
    $('#sync-status').textContent='Local draft';
  }
  render();
}
async function change(path,method,body,localMutation) {
  if(isShared()) { await api(path,method,body); await loadState(); }
  else { localMutation(); localStorage.setItem('northbound_draft',JSON.stringify(state)); render(); }
}

function render() {
  const dest=DESTINATIONS[state.config.destination]||DESTINATIONS.oulu;
  $('#destination').value=state.config.destination;
  $('#display-name').value=displayName;
  $('#out-route-label').textContent=`Bucharest → ${dest.name}`;
  $('#back-route-label').textContent=`${dest.name} → Bucharest`;
  renderStops('out'); renderStops('back'); renderIdeas(); updateRoutes();
}
function renderStops(leg) {
  const dest=DESTINATIONS[state.config.destination]||DESTINATIONS.oulu;
  const list=$(`#${leg}-stops`);
  const start=leg==='out'?ORIGIN:dest, end=leg==='out'?dest:ORIGIN;
  const items=routeStops(leg);
  const endpoint=(place,label)=>`<div class="stop-row endpoint"><span class="stop-index">●</span><div class="stop-main"><strong>${escapeHtml(place.name)}</strong><small>${label}</small></div></div>`;
  list.innerHTML=endpoint(start,'Start')+items.map((s,i)=>`<div class="stop-row"><span class="stop-index ${leg==='back'?'return':''}">${i+1}</span><div class="stop-main"><strong>${escapeHtml(s.name)}</strong><small>${s.nights?`${s.nights} night${s.nights===1?'':'s'}`:'Pass through'}${s.note?' · '+escapeHtml(s.note):''}</small></div><div class="stop-actions"><button class="icon-button" data-action="up" data-id="${escapeHtml(s.id)}" data-leg="${leg}" aria-label="Move ${escapeHtml(s.name)} up" ${i===0?'disabled':''}>↑</button><button class="icon-button" data-action="down" data-id="${escapeHtml(s.id)}" data-leg="${leg}" aria-label="Move ${escapeHtml(s.name)} down" ${i===items.length-1?'disabled':''}>↓</button><button class="icon-button" data-action="edit-stop" data-id="${escapeHtml(s.id)}" aria-label="Edit ${escapeHtml(s.name)}">✎</button><button class="icon-button" data-action="remove-stop" data-id="${escapeHtml(s.id)}" aria-label="Remove ${escapeHtml(s.name)}">×</button></div></div>`).join('')+endpoint(end,'Finish');
}
function renderIdeas() {
  const ideas=state.activities.filter(a=>activeFilter==='all'||a.leg===activeFilter);
  $('#ideas-list').innerHTML=ideas.length?ideas.map(a=>{
    const stop=state.stops.find(s=>s.id===a.stop_id);
    const location=a.locality||stop?.name||'On the route';
    const source=safeUrl(a.source_url);
    return `<article class="idea-card"><div class="idea-top"><span class="tag ${a.leg==='back'?'return':''}">${a.leg==='out'?'↗ Outbound':'↙ Return'} · ${escapeHtml(a.category||'other')}</span><button class="icon-button" data-action="edit-idea" data-id="${escapeHtml(a.id)}" aria-label="Edit ${escapeHtml(a.title)}">✎</button></div><h3>${escapeHtml(a.title)}</h3><span class="idea-location">📍 ${escapeHtml(location)}</span><p>${escapeHtml(a.description||'Proposed by the group.')}</p><footer><span>${escapeHtml(a.proposed_by||'Friend')} · ${escapeHtml(a.status||'suggested')}</span>${source?`<a href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer">Source ↗</a>`:''}</footer></article>`;
  }).join(''):'<div class="empty-state">No ideas for this route yet. Propose a place or ask AI for suggestions.</div>';
}

function initMaps() {
  if(!window.L) { $('#route-notice').textContent='Map library could not load. Check your connection and reload.'; return; }
  ensureMap('out','out-map');
  ensureMap('back','back-map');
}
function ensureMap(key,id) {
  if(maps[key]||!window.L) return;
  const map=L.map(id,{zoomControl:true,scrollWheelZoom:false}).setView([55,23],4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
  maps[key]={map,layer:L.layerGroup().addTo(map)};
}
function pinIcon(leg,label,isEnd=false) { return L.divIcon({className:'',html:`<span class="map-pin ${isEnd?'end':leg}">${label}</span>`,iconSize:[25,25],iconAnchor:[12,12]}); }
function drawMap(key) {
  if(!maps[key]) return;
  const {map,layer}=maps[key]; layer.clearLayers();
  const legs=key==='combined'?['out','back']:[key];
  const bounds=[];
  for(const leg of legs) {
    const pts=points(leg), color=leg==='out'?'#139f9c':'#e9953e';
    const route=routeData[leg];
    if(route?.geometry?.coordinates?.length) {
      const latlngs=route.geometry.coordinates.map(c=>[c[1],c[0]]);
      L.polyline(latlngs,{color,weight:key==='combined'?5:6,opacity:.86}).addTo(layer);
      bounds.push(...latlngs.filter((_,i)=>i%Math.max(1,Math.floor(latlngs.length/120))===0));
    } else {
      L.polyline(pts.map(p=>[p.lat,p.lon]),{color,weight:3,dashArray:'7 8',opacity:.6}).addTo(layer);
    }
    pts.forEach((p,i)=>{
      const latlng=[p.lat,p.lon]; bounds.push(latlng);
      L.marker(latlng,{icon:pinIcon(leg,i===0?'A':i===pts.length-1?'B':String(i),i===0||i===pts.length-1)}).bindPopup(`<strong>${escapeHtml(p.name)}</strong><br>${leg==='out'?'Outbound':'Return'}`).addTo(layer);
    });
  }
  if(bounds.length) map.fitBounds(bounds,{padding:[25,25],maxZoom:6});
}
async function fetchRoadRoute(leg) {
  const pts=points(leg), cacheKey=JSON.stringify([leg,pts.map(p=>[p.lon,p.lat]),isShared()?backend:'local']);
  if(routeCache[cacheKey]) return routeCache[cacheKey];
  let result;
  if(isShared()) result=await api('/route','POST',{coordinates:pts.map(p=>[p.lon,p.lat])});
  else {
    const coords=pts.map(p=>`${p.lon},${p.lat}`).join(';');
    const response=await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
    const data=await response.json();
    if(!response.ok||data.code!=='Ok'||!data.routes?.[0]) throw new Error(data.message||'Road route unavailable');
    result={distance_m:data.routes[0].distance,geometry:data.routes[0].geometry,provider:'OSRM demo'};
  }
  routeCache[cacheKey]=result;
  return result;
}
async function updateRoutes() {
  const fingerprint=JSON.stringify([state.config.destination,points('out').map(p=>[p.lat,p.lon]),points('back').map(p=>[p.lat,p.lon]),backend]);
  if(fingerprint===lastRouteFingerprint&&routeData.out&&routeData.back) return;
  lastRouteFingerprint=fingerprint;
  const run=++routeRun;
  $('#route-notice').textContent='Calculating road routes…';
  const settled=await Promise.allSettled(['out','back'].map(fetchRoadRoute));
  if(run!==routeRun) return;
  routeData.out=settled[0].status==='fulfilled'?settled[0].value:null;
  routeData.back=settled[1].status==='fulfilled'?settled[1].value:null;
  const out=routeData.out?.distance_m, back=routeData.back?.distance_m;
  $('#out-distance').textContent=$('#out-panel-distance').textContent=$('#out-combined-distance').textContent=km(out);
  $('#back-distance').textContent=$('#back-panel-distance').textContent=$('#back-combined-distance').textContent=km(back);
  const total=Number.isFinite(out)&&Number.isFinite(back)?out+back:NaN;
  $('#total-distance').textContent=km(total);
  $('#combined-total').textContent=`${km(total)} total`;
  const failures=settled.filter(s=>s.status==='rejected');
  $('#route-notice').textContent=failures.length?`A road route could not be calculated (${failures[0].reason?.message||'unknown error'}). Dashed lines are visual guides only; missing kilometers are not included.`:'Road kilometers are planning estimates. Ferry crossings, road closures, opening hours and border rules need checking before travel.';
  drawMap('out'); drawMap('back'); drawMap('combined');
}

async function reorder(leg,id,direction) {
  const items=routeStops(leg), index=items.findIndex(s=>s.id===id), other=index+direction;
  if(index<0||other<0||other>=items.length) return;
  [items[index],items[other]]=[items[other],items[index]];
  const ids=items.map(s=>s.id);
  await change('/stops/order','PUT',{leg,ids},()=>items.forEach((s,i)=>s.position=i));
}
function openStop(id) {
  editingStop=state.stops.find(s=>s.id===id); if(!editingStop) return;
  $('#stop-dialog-title').textContent=editingStop.name;
  $('#stop-nights').value=editingStop.nights||0;
  $('#stop-note').value=editingStop.note||'';
  $('#stop-dialog').showModal();
}
async function saveStop() {
  if(!editingStop) return;
  const id=editingStop.id, nights=Math.max(0,Math.min(30,Number($('#stop-nights').value)||0)), note=$('#stop-note').value.trim();
  await change(`/stops/${encodeURIComponent(id)}`,'PATCH',{nights,note},()=>Object.assign(editingStop,{nights,note}));
  $('#stop-dialog').close(); notify('Stop updated');
}
function refreshIdeaStops() {
  const leg=$('#idea-leg').value;
  $('#idea-stop').innerHTML='<option value="">Between stops / general</option>'+routeStops(leg).map(s=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
}
function openIdea(id=null) {
  editingIdea=state.activities.find(a=>a.id===id)||null;
  $('#idea-dialog-title').textContent=editingIdea?'Edit activity':'Propose an activity';
  $('#idea-leg').value=editingIdea?.leg||'out'; refreshIdeaStops();
  $('#idea-stop').value=editingIdea?.stop_id||'';
  $('#idea-title').value=editingIdea?.title||'';
  $('#idea-type').value=editingIdea?.category||'sightseeing';
  $('#idea-status').value=editingIdea?.status||'suggested';
  $('#idea-description').value=editingIdea?.description||'';
  $('#idea-url').value=editingIdea?.source_url||'';
  $('#delete-idea').classList.toggle('hidden',!editingIdea);
  $('#idea-error').textContent=''; $('#idea-dialog').showModal();
}
async function saveIdea() {
  const title=$('#idea-title').value.trim(); if(!title) { $('#idea-error').textContent='Add a place or activity name.'; return; }
  const body={leg:$('#idea-leg').value,stop_id:$('#idea-stop').value||null,title,category:$('#idea-type').value,description:$('#idea-description').value.trim(),source_url:$('#idea-url').value.trim(),proposed_by:editingIdea?.proposed_by||displayName||'Friend',status:$('#idea-status').value};
  if(body.source_url&&!safeUrl(body.source_url)) { $('#idea-error').textContent='Enter a valid http or https link.'; return; }
  try {
    if(editingIdea) { const old=editingIdea; await change(`/activities/${encodeURIComponent(old.id)}`,'PATCH',body,()=>Object.assign(old,body)); }
    else { await change('/activities','POST',body,()=>state.activities.push({...body,id:crypto.randomUUID(),locality:state.stops.find(s=>s.id===body.stop_id)?.name||''})); }
    $('#idea-dialog').close(); notify('Idea saved');
  } catch(e) { $('#idea-error').textContent=e.message; }
}

async function searchPlaces(form) {
  const leg=form.dataset.leg, query=form.querySelector('input[name="query"]').value.trim(), target=$(`#${leg}-results`);
  if(query.length<2) return;
  target.innerHTML='<p class="search-error">Searching…</p>';
  try {
    const response=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`,{headers:{'Accept-Language':'en'}});
    if(!response.ok) throw new Error('Place search is temporarily unavailable');
    const results=await response.json();
    target.replaceChildren();
    if(!results.length) { target.textContent='No places found. Try a city and country.'; return; }
    results.forEach(place=>{
      const row=document.createElement('div'); row.className='search-result';
      const text=document.createElement('span'); text.textContent=place.display_name;
      const button=document.createElement('button'); button.type='button'; button.textContent='Add stop';
      button.addEventListener('click',async()=>{
        const name=place.display_name.split(',').slice(0,2).join(',').trim();
        const item={leg,name,lat:Number(place.lat),lon:Number(place.lon),nights:1,note:'',created_by:displayName||'Friend'};
        try { await change('/stops','POST',item,()=>state.stops.push({...item,id:crypto.randomUUID(),position:Math.max(-1,...routeStops(leg).map(s=>s.position))+1})); target.replaceChildren(); form.reset(); notify(`${name} added to ${leg==='out'?'outbound':'return'}`); }
        catch(e) { notify(e.message); }
      });
      row.append(text,button); target.append(row);
    });
  } catch(e) { target.innerHTML=`<p class="search-error">${escapeHtml(e.message)}</p>`; }
}

function bindEvents() {
  $$('.dialog-close').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
  $$('[data-close]').forEach(button=>button.addEventListener('click',()=>document.getElementById(button.dataset.close).close()));
  $('#stop-dialog form').addEventListener('submit',e=>{ e.preventDefault(); if(e.submitter?.value==='cancel') $('#stop-dialog').close(); else saveStop().catch(err=>notify(err.message)); });
  $('#idea-dialog form').addEventListener('submit',e=>{ e.preventDefault(); if(e.submitter?.value==='cancel') $('#idea-dialog').close(); else saveIdea(); });
  $('#share-dialog form').addEventListener('submit',e=>{ e.preventDefault(); if(e.submitter?.value==='cancel') $('#share-dialog').close(); });
  $('#display-name').addEventListener('change',e=>{ displayName=e.target.value.trim(); localStorage.setItem('northbound_name',displayName); });
  $('#destination').addEventListener('change',async e=>{
    const destination=e.target.value;
    try { await change('/config','PUT',{destination},()=>{state.config.destination=destination;}); notify(`Destination set to ${DESTINATIONS[destination].name}`); }
    catch(err) { notify(err.message); render(); }
  });
  $$('.add-stop').forEach(form=>form.addEventListener('submit',e=>{e.preventDefault();searchPlaces(form);}));
  document.addEventListener('click',async e=>{
    const button=e.target.closest('[data-action]'); if(!button) return;
    const {action,id,leg}=button.dataset;
    try {
      if(action==='up'||action==='down') await reorder(leg,id,action==='up'?-1:1);
      if(action==='edit-stop') openStop(id);
      if(action==='remove-stop') {
        const stop=state.stops.find(s=>s.id===id);
        if(!stop||!confirm(`Remove ${stop.name} from this route?`)) return;
        await change(`/stops/${encodeURIComponent(id)}`,'DELETE',undefined,()=>{state.stops=state.stops.filter(s=>s.id!==id);state.activities.forEach(a=>{if(a.stop_id===id)a.stop_id=null;});}); notify('Stop removed');
      }
      if(action==='edit-idea') openIdea(id);
    } catch(err) { notify(err.message); }
  });
  $$('.view-tabs [data-view]').forEach(button=>button.addEventListener('click',()=>{
    activeView=button.dataset.view;
    $$('.view-tabs [data-view]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-selected',String(b===button));});
    $('#parallel-maps').classList.toggle('hidden',activeView!=='parallel');
    $('#combined-panel').classList.toggle('hidden',activeView!=='combined');
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(activeView==='combined') {
        ensureMap('combined','combined-map');
        maps.combined?.map.invalidateSize({pan:false});
        drawMap('combined');
      } else {
        for(const key of ['out','back']) { maps[key]?.map.invalidateSize({pan:false}); drawMap(key); }
      }
    }));
  }));
  $$('[data-filter]').forEach(button=>button.addEventListener('click',()=>{activeFilter=button.dataset.filter;$$('[data-filter]').forEach(b=>b.classList.toggle('active',b===button));renderIdeas();}));
  $('#idea-leg').addEventListener('change',refreshIdeaStops);
  $('#add-idea-button').addEventListener('click',()=>openIdea());
  $('#save-stop').addEventListener('click',()=>saveStop().catch(e=>notify(e.message)));
  $('#save-idea').addEventListener('click',saveIdea);
  $('#delete-idea').addEventListener('click',async()=>{
    if(!editingIdea||!confirm(`Delete ${editingIdea.title}?`)) return;
    try { const id=editingIdea.id; await change(`/activities/${encodeURIComponent(id)}`,'DELETE',undefined,()=>{state.activities=state.activities.filter(a=>a.id!==id);});$('#idea-dialog').close();notify('Idea removed'); } catch(e) { $('#idea-error').textContent=e.message; }
  });
  $('#suggest-button').addEventListener('click',async()=>{
    if(!isShared()) { notify('Connect the shared backend and add an OpenAI key to get new suggestions.'); $('#share-dialog').showModal(); return; }
    const button=$('#suggest-button'); button.disabled=true; button.textContent='Finding ideas…';
    try { const result=await api('/suggestions','POST',{leg:activeFilter==='all'?'both':activeFilter}); await loadState(); notify(`${result.added} new ideas added`); }
    catch(e) { notify(e.message); }
    finally { button.disabled=false; button.textContent='Suggest with AI'; }
  });
  $('#share-button').addEventListener('click',()=>{ $('#worker-url').value=backend;$('#trip-key').value=tripKey;$('#share-error').textContent='';$('#share-dialog').showModal(); });
  $('#connect-button').addEventListener('click',async()=>{
    const candidate=$('#worker-url').value.trim().replace(/\/$/,''), key=$('#trip-key').value;
    if(!safeUrl(candidate)||!key) { $('#share-error').textContent='Enter the Worker URL and shared passphrase.';return; }
    try { const remote=await api('/state','GET',undefined,{backend:candidate,key}); backend=candidate;tripKey=key;localStorage.setItem('northbound_backend',backend);sessionStorage.setItem('northbound_key',tripKey);state=remote;render();$('#sync-status').textContent='Shared trip · live';$('#share-dialog').close();notify('Connected to shared trip'); }
    catch(e) { $('#share-error').textContent=e.message; }
  });
  $('#disconnect-button').addEventListener('click',()=>{ backend='';tripKey='';localStorage.removeItem('northbound_backend');sessionStorage.removeItem('northbound_key');$('#share-dialog').close();loadState();notify('Using local draft'); });
}

document.addEventListener('DOMContentLoaded',async()=>{
  bindEvents(); initMaps();
  try { await loadState(); } catch(e) { notify(`Could not load shared trip: ${e.message}`);$('#sync-status').textContent='Connection needed';state=seed();render();$('#share-dialog').showModal(); }
  if(isShared()) setInterval(async()=>{ if(document.visibilityState==='visible'&&!$$('dialog[open]').length) { try { await loadState(); } catch { $('#sync-status').textContent='Sync offline'; } } },30000);
});
