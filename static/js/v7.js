
window.v7VehicleOrigin = window.v7VehicleOrigin || null;
function formatTrafficPeriod(a){
  if(!a || !a.start || !a.end) return "";
  try{
    const optsDate={day:"2-digit",month:"2-digit",year:"numeric"};
    const optsTime={hour:"2-digit",minute:"2-digit"};
    const start=new Date(a.start);
    const end=new Date(a.end);
    const sd=start.toLocaleDateString("fr-FR",optsDate);
    const st=start.toLocaleTimeString("fr-FR",optsTime).replace(":","h");
    const ed=end.toLocaleDateString("fr-FR",optsDate);
    const et=end.toLocaleTimeString("fr-FR",optsTime).replace(":","h");
    return `Du ${sd} à ${st} au ${ed} à ${et}`;
  }catch(e){
    return "";
  }
}


function setViewMode(mode){
 document.body.classList.remove("line-open","traffic-open");
 if(mode !== "home"){
  document.body.classList.remove("sidebar-open");
 }

 if(mode==="line"){
  document.body.classList.add("line-open");
 }else if(mode==="traffic"){
  document.body.classList.add("traffic-open");
 }

 const homeVisible = mode==="home";

 const topbar=document.querySelector(".v7-topbar"); if(topbar) topbar.style.display = homeVisible ? "" : "none";
 /* map stays visible in V7 */

 $("#lineView").classList.toggle("open", mode==="line");
 $("#trafficView").classList.toggle("open", mode==="traffic");

 v7MapFocus(mode !== "home");
 setTimeout(()=>{ try{ if(map) map.invalidateSize(); }catch(e){} },260);

}


let buses=[],pos=null,map=null,markers={},currentLine=null,lineTimer=null,geoWatchId=null,userMarker=null,userAccuracy=null,userFollow=true,userMovedMap=false;window.map=null;let v7GpsNav=false,v7MapBearing=0,v7DeviceBearing=null,v7OrientationReady=false,v7HeadingMarker=null,v7LastAcceptedPos=null,v7ProgrammaticMapMove=false,v7TileLayer=null,v7LastTileRefresh=0,v7NavStableCourse=null,v7NavCandidateCourse=null,v7NavCandidateHits=0,v7NavLastCourseAt=0;const $=s=>document.querySelector(s);

// === TCL V7 LINE FAVORITES ===
const V7_LINE_FAV_KEY = "tcl_v7_line_favorites";

function v7ReadLineFavs(){
 try{return new Set(JSON.parse(localStorage.getItem(V7_LINE_FAV_KEY)||"[]"));}
 catch(e){return new Set();}
}
function v7SaveLineFavs(set){
 localStorage.setItem(V7_LINE_FAV_KEY, JSON.stringify([...set]));
}
function v7IsLineFavorite(line){
 return v7ReadLineFavs().has(String(line||"").toUpperCase());
}
function v7ToggleLineFavorite(line){
 const k=String(line||"").toUpperCase();
 const favs=v7ReadLineFavs();
 if(favs.has(k)) favs.delete(k); else favs.add(k);
 v7SaveLineFavs(favs);
 v7RenderLineTitle(k);
 v7EnhanceTrackingFavorites();
}
function v7RenderLineTitle(line){
 const title=$("#lineTitle");
 if(!title) return;
 const k=String(line||"").toUpperCase();
 const active=v7IsLineFavorite(k);
 title.innerHTML = `<span>Ligne ${k}</span><button class="line-fav-btn ${active?'active':''}" type="button" data-line="${k}" title="Favori ligne">${active?'★':'☆'}</button>`;
 const btn=title.querySelector(".line-fav-btn");
 if(btn){
  btn.onclick=(e)=>{
   e.preventDefault();
   e.stopPropagation();
   v7ToggleLineFavorite(k);
  };
 }
}
function v7EnhanceTrackingFavorites(){
 const favs=v7ReadLineFavs();
 const root=$("#trackList");
 if(!root) return;
 if(!root) return;

 const items=[...root.querySelectorAll(".bubble.bus[data-line]")];
 items.forEach(el=>{
  const line=String(el.dataset.line||"").toUpperCase();
  const active=favs.has(line);
  el.classList.toggle("line-favorite",active);
  if(line && !el.dataset.v7LineFavDecorated){
   el.dataset.v7LineFavDecorated="1";
  }
  if(line){
   const raw=el.textContent.replace(/^★\s*/,"").replace(/^☆\s*/,"").trim();
   el.textContent=(active?"★ ":"") + raw;
  }
 });

 items.sort((a,b)=>{
  const la=String(a.dataset.line||"").toUpperCase();
  const lb=String(b.dataset.line||"").toUpperCase();
  const fa=favs.has(la), fb=favs.has(lb);
  if(fa && !fb) return -1;
  if(!fa && fb) return 1;
  return la.localeCompare(lb,"fr",{numeric:true});
 });
 items.forEach(el=>root.appendChild(el));
}

const V7_FAV_PREFIX="tcl_v7_vehicle";
function serviceDay(){
 const d=new Date();
 if(d.getHours()<2)d.setDate(d.getDate()-1);
 return d.toISOString().slice(0,10);
}
function storageKey(name){
 return `${V7_FAV_PREFIX}_${serviceDay()}_${name}`;
}
function readJSON(key,fallback){
 try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback));}
 catch(e){return fallback}
}
function writeJSON(key,value){
 localStorage.setItem(key,JSON.stringify(value));
}
function cleanOldFavoriteDays(){
 const current=serviceDay();
 Object.keys(localStorage).forEach(k=>{
  if(k.startsWith(V7_FAV_PREFIX+"_") && !k.includes("_"+current+"_")){
   localStorage.removeItem(k);
  }
 });
}
cleanOldFavoriteDays();

const favVehicles=new Set(readJSON(storageKey("favorites"),[]));
let vehicleOrder=readJSON(storageKey("order"),{});
let orderSeq=Number(readJSON(storageKey("orderSeq"),0));

function saveVehicleFavs(){
 writeJSON(storageKey("favorites"),[...favVehicles]);
}
function saveVehicleOrder(){
 writeJSON(storageKey("order"),vehicleOrder);
 writeJSON(storageKey("orderSeq"),orderSeq);
}
function stableVehicleKey(line,vehicle){
 return String(line||currentLine||"?")+"|"+String(vehicle||"?");
}
function rememberVehicleOrder(line,vehicle){
 const k=stableVehicleKey(line,vehicle);
 if(vehicleOrder[k]===undefined){
  vehicleOrder[k]=++orderSeq;
  saveVehicleOrder();
 }
 return vehicleOrder[k];
}
function favRank(k){
 const arr=[...favVehicles];
 const i=arr.indexOf(k);
 return i<0 ? 999999 : i;
}
function applyVehicleFavoriteOrder(root=document){
 const cards=[...root.querySelectorAll(".live-card[data-vehicle]")];
 cards.forEach((card,idx)=>{
  const v=card.dataset.vehicle||"?";
  const k=stableVehicleKey(currentLine,v);
  rememberVehicleOrder(currentLine,v);

  const btn=card.querySelector(".vehicle-fav-btn");
  const active=favVehicles.has(k);

  card.classList.toggle("vehicle-favorite",active);
  if(btn){
   btn.textContent=active?"★":"☆";
   btn.classList.toggle("active",active);
   btn.onclick=(e)=>{
    e.preventDefault();
    e.stopPropagation();
    if(favVehicles.has(k)) favVehicles.delete(k);
    else favVehicles.add(k);
    saveVehicleFavs();
    applyVehicleFavoriteOrder(document);
    renderTracking();
   };
  }
 });

 cards.sort((a,b)=>{
  const va=stableVehicleKey(currentLine,a.dataset.vehicle);
  const vb=stableVehicleKey(currentLine,b.dataset.vehicle);
  const fa=favVehicles.has(va), fb=favVehicles.has(vb);

  if(fa && fb) return favRank(va)-favRank(vb);
  if(fa) return -1;
  if(fb) return 1;

  return (vehicleOrder[va]||999999)-(vehicleOrder[vb]||999999);
 });

 const parent=cards[0]?.parentElement;
 if(parent) cards.forEach(c=>parent.appendChild(c));
}

function color(l){l=String(l);return l.startsWith("C")?"#f97316":l.startsWith("T")?"#8b5cf6":"#38bdf8"}function icon(l){l=String(l);return l.startsWith("T")?"🚊":l.startsWith("C")?"🚍":"🚌"}
function initMap(){
 const el=document.getElementById("map");
 if(!el || typeof L==="undefined") return;

 if(map){
  try{ map.invalidateSize(true); }catch(e){}
  return;
 }

 map=L.map("map",{zoomControl:false,attributionControl:false}).setView([45.75,4.85],13);
 window.map=map;

 const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
 const tileUrl = isDark
  ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
  : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

 v7TileLayer=L.tileLayer(tileUrl,{
  subdomains:"abcd",
  maxZoom:19,
  keepBuffer:8,
  updateInterval:180,
  updateWhenIdle:false,
  updateWhenZooming:true,
  crossOrigin:true
 });
 const baseTileBounds=v7TileLayer._getTiledPixelBounds;
 if(typeof baseTileBounds === "function"){
  v7TileLayer._getTiledPixelBounds=function(center){
   const bounds=baseTileBounds.call(this,center);
   if(v7GpsNav){
    const pad=L.point(512,512);
    bounds.min=bounds.min.subtract(pad);
    bounds.max=bounds.max.add(pad);
   }
   return bounds;
  };
 }
 v7TileLayer.addTo(map);

 setTimeout(()=>map.invalidateSize(true),100);
 setTimeout(()=>map.invalidateSize(true),500);
 setTimeout(()=>map.invalidateSize(true),1200);

 map.on("dragstart zoomstart",()=>{
  if(v7ProgrammaticMapMove) return;
  if(userFollow){
   userFollow=false;
   userMovedMap=true;
   v7SetGpsNavigation(false,false);
   updateRecenterButton();
  }
 });

 map.on("click",()=>{
  clearSelectedLineMap();
  Object.values(markers||{}).forEach(m=>{
   const el=m.getElement && m.getElement();
   if(el){
    el.classList.remove("map-line-selected","map-line-dimmed");
   }
  });
 });
}


function queryText(){
 return ($("#q")?.value || "").trim().toUpperCase();
}
function queryLine(){
 const q=queryText();
 if(!q) return "";
 const exact=buses.find(b=>String(b.line).toUpperCase()===q);
 if(exact) return String(exact.line);
 const starts=buses.find(b=>String(b.line).toUpperCase().startsWith(q));
 return starts ? String(starts.line) : q;
}

function uniqueSearchLines(){
 const seen=new Set();
 return (buses||[]).reduce((out,b)=>{
  const line=String(b.line||"").trim();
  const key=line.toUpperCase();
  if(!line || seen.has(key)) return out;
  seen.add(key);
  out.push(line);
  return out;
 },[]).sort((a,b)=>String(a).localeCompare(String(b),"fr",{numeric:true}));
}

function v7NormalizeSearch(v){
 return String(v || "").trim().toUpperCase().replace(/\s+/g, "");
}

function escapeHtml(v){
 return String(v ?? "")
  .replace(/&/g,"&amp;")
  .replace(/</g,"&lt;")
  .replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;")
  .replace(/'/g,"&#39;");
}

const V7_SEARCH_LINES = [
 "A","B","C","D",
 "T1","T2","T3","T4","T5","T6","T7","T8","T9","T10",
 "F1","F2",
 "C1","C2","C3","C4","C5","C6","C7","C8","C9","C10","C11","C12","C13","C14","C15","C16","C17","C18","C19","C20","C21","C22","C24","C25","C26",
 "1E","2","3","5","6","7","8","9","10","11","12","14","15","15E","17","18","19","20","21","22","23","24","25","26","27","31","32","33","34","35","37","38","39","40","43","45","46","49","50","52","54","55","57","60","61","62","63","64","65","67","68","69","70","71","72","73","73E","76","77","78","79","80","81","82","83","84","85","86","87","88","89","90","93","95","96","97","98","100","111","112","113","114","115","118","120","123","171","172","179","185"
];

function v7SearchValue(value){
 if(value !== undefined) return String(value || "").trim();
 return String(document.querySelector("#q")?.value || "").trim();
}
function v7LineRank(line, needle){
 const l=v7NormalizeSearch(line);
 if(l === needle) return 0;
 if(l.startsWith(needle)) return 1;
 if(l.includes(needle)) return 2;
 return 9;
}
function searchVehicles(q){
 const vehicleQuery = v7NormalizeSearch(q).replace(/\D/g, "");
 if(!vehicleQuery) return [];

 const seen = new Set();
 const out = [];

 (window.buses || buses || []).forEach(b => {
   const vehicle = String(b.vehicle || b.vehicule || "").trim();
   const line = String(b.line || b.ligne || currentLine || "").trim().toUpperCase();
   const key = line + "|" + vehicle;
   if(!vehicle || !line || seen.has(key)) return;
   if(vehicle.includes(vehicleQuery)){
     seen.add(key);
     out.push({
       line,
       vehicle,
       destination: String(b.destination || b.dest || b.bt_destination || ""),
       source:"map"
     });
   }
 });

 document.querySelectorAll(".live-card[data-vehicle]").forEach(card => {
   const vehicle = String(card.dataset.vehicle || "").trim();
   const line = String(currentLine || document.querySelector("#lineTitle")?.textContent?.replace("Ligne","").trim() || "").toUpperCase();
   const dest = card.querySelector(".dest")?.textContent?.replace(/^Direction\s+/,"") || "";
   const key = line + "|" + vehicle;
   if(!vehicle || !line || seen.has(key)) return;
   if(vehicle.includes(vehicleQuery)){
     seen.add(key);
     out.push({line, vehicle, destination: dest, source:"line"});
   }
 });

 return out.sort((a,b) => {
   const av = String(a.vehicle || "");
   const bv = String(b.vehicle || "");
   const ap = av === vehicleQuery ? 0 : av.startsWith(vehicleQuery) ? 1 : 2;
   const bp = bv === vehicleQuery ? 0 : bv.startsWith(vehicleQuery) ? 1 : 2;
   if(ap !== bp) return ap - bp;
   const lineCmp = String(a.line||"").localeCompare(String(b.line||""), "fr", {numeric:true});
   if(lineCmp) return lineCmp;
   return av.localeCompare(bv, "fr", {numeric:true});
 });
}

function ensureSearchBox(){
 const search = document.querySelector(".v7-search");
 if(!search) return null;

 let box = search.querySelector(".v7-search-suggest");
 if(!box){
   box = document.createElement("div");
   box.className = "v7-search-suggest";
   search.appendChild(box);
 }
 return box;
}

function buildSearchSuggestions(q){
 const raw = v7SearchValue(q);
 const needle = v7NormalizeSearch(raw);
 if(!needle) return {raw, lines:[], vehicles:[], total:0};

 const seen = new Set();
 const lines = V7_SEARCH_LINES
   .map(line => ({line, rank:v7LineRank(line, needle)}))
   .filter(item => item.rank < 9)
   .sort((a,b) => a.rank - b.rank || String(a.line).localeCompare(String(b.line), "fr", {numeric:true}))
   .filter(item => {
     const key=v7NormalizeSearch(item.line);
     if(seen.has(key)) return false;
     seen.add(key);
     return true;
   })
   .slice(0, 32)
   .map(item => ({
     type:"line",
     line:item.line,
     title:"Ligne " + item.line,
     meta:"Ouvrir la ligne"
   }));

 const vehicles = searchVehicles(raw).slice(0, 48).map(b => ({
   type:"vehicle",
   line:b.line,
   vehicle:b.vehicle,
   title:"Bus " + b.vehicle,
   meta:(b.line ? "Ligne " + b.line : "Carrosserie") + (b.destination ? " · " + b.destination : "")
 }));

 return {raw, lines, vehicles, total:lines.length + vehicles.length};
}

function renderSearchSuggestions(q){
 const box = ensureSearchBox();
 if(!box) return;

 const groups = buildSearchSuggestions(q);
 const input = document.querySelector("#q");
 const wrap = document.querySelector(".v7-search");
 if(wrap) wrap.classList.toggle("has-value", !!groups.raw);

 if(!groups.raw || !groups.total){
   box.classList.remove("open");
   box.innerHTML = "";
   box.scrollTop = 0;
   return;
 }

 const renderItem = item => {
   const icon = item.type === "vehicle" ? "🚌" : "L";
   const data = item.type === "vehicle"
     ? `data-type="vehicle" data-line="${escapeHtml(item.line)}" data-vehicle="${escapeHtml(item.vehicle)}"`
     : `data-type="line" data-line="${escapeHtml(item.line)}"`;

   return `<button class="v7-search-suggestion ${item.type}" type="button" ${data}>
    <span class="v7-search-suggestion-icon">${icon}</span>
    <span class="v7-search-suggestion-text">
      <strong>${escapeHtml(item.title)}</strong>
      <small>${escapeHtml(item.meta || "")}</small>
    </span>
   </button>`;
 };

 const chunks = [];
 if(groups.lines.length){
   chunks.push(`<div class="v7-search-suggest-section" role="presentation"><div class="v7-search-suggest-title">Lignes</div>${groups.lines.map(renderItem).join("")}</div>`);
 }
 if(groups.vehicles.length){
   chunks.push(`<div class="v7-search-suggest-section" role="presentation"><div class="v7-search-suggest-title">Carrosseries disponibles</div>${groups.vehicles.map(renderItem).join("")}</div>`);
 }

 box.innerHTML = chunks.join("");
 box.classList.add("open");
 if(input) input.setAttribute("aria-expanded", "true");
}
function hideSearchSuggestions(){
 const box = document.querySelector(".v7-search-suggest");
 if(box){
   box.classList.remove("open");
   box.innerHTML = "";
   box.scrollTop = 0;
 }
 const input = document.querySelector("#q");
 if(input) input.setAttribute("aria-expanded", "false");
}

async function openVehicleFromSearch(line, vehicle){
 line = String(line || "").trim().toUpperCase();
 vehicle = String(vehicle || "").trim();
 if(!line || !vehicle) return;

 window.v7VehicleOrigin = "search";
 window.mapVehicleToOpen = { line, vehicle };

 hideSearchSuggestions();

 const q = document.querySelector("#q");
 if(q) q.blur();

 await openLine(line, true);

 const findCard = () => {
   const root = document.querySelector("#lineContent");
   if(!root) return null;

   const card = root.querySelector(`.live-card[data-vehicle="${CSS.escape(vehicle)}"]`);
   if(!card) return null;

   const hasRealContent =
     card.querySelector(".bus-pill") &&
     card.querySelector(".dest") &&
     card.querySelector(".tcl-timeline-v3");

   return hasRealContent ? card : null;
 };

 let card = null;
 for(let i = 0; i < 60 && !card; i++){
   await new Promise(r => setTimeout(r, 120));
   card = findCard();
 }

 if(card && typeof window.openVehiclePortrait === "function"){
   window.mapVehicleToOpen = null;
   window.openVehiclePortrait(card);
   return;
 }

 window.mapVehicleToOpen = null;
 console.warn("V7 search vehicle: carte véhicule introuvable ou incomplète", {line, vehicle});
}

function markerIcon(b){
 const line=String(b.line||"?").toUpperCase();
 return L.divIcon({
  className:"v7-line-marker-icon",
  html:`<div class="v7-line-marker"><span>${line}</span></div>`,
  iconSize:[24,24],
  iconAnchor:[12,12]
 });
}


// === V7 — LOAD MARKERS BUS ===
async function load(){
  try{
    const raw = await (await fetch("/api/realtime?t=" + Date.now(), {cache:"no-store"})).json();

    buses = [];
    window.buses = buses;

    Object.entries(raw || {}).forEach(([line, arr]) => {
      (arr || []).forEach(b => {
        const lat = parseFloat(b.map_engine_latitude ?? b.latitude ?? b.lat);
        const lon = parseFloat(b.map_engine_longitude ?? b.longitude ?? b.lon);
        if(!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        buses.push({
          line: String(b.ligne || b.line || line || "?"),
          vehicle: String(b.vehicule || b.vehicle || "?"),
          destination: b.destination || b.bt_destination || "",
          stop: b.bt_next_stop || b.arret_courant || "",
          lat,
          lon,
          raw: b
        });
      });
    });

    if(typeof renderMap === "function"){
      renderMap();
    }else if(map){
      try{ map.invalidateSize(true); }catch(e){}
    }
    renderTracking();
    loadTraffic();

    /* V7 — widget proximité/favoris géré par le rendu final */
  }catch(e){
    console.warn("V7 load realtime failed", e);
  }
}



/* V7 — rendu carte, ligne et widgets restauré depuis la sauvegarde de référence. */
async function refreshLine(){
 if(!currentLine) return;
 const requestedLine=String(currentLine);

 try{
  const html=await (await fetch("/api/line_html?line="+encodeURIComponent(requestedLine)+"&t="+Date.now())).text();
  if(String(currentLine)!==requestedLine) return;

  const target=$("#busCards")||$("#lineContent");
  if(!target) return;

  const tpl=document.createElement("template");
  tpl.innerHTML=html||"";

  const incoming=[...tpl.content.querySelectorAll(".live-card[data-vehicle]")];

  // Si l'API ne renvoie pas de cartes, on garde le comportement simple.
  if(!incoming.length){
    target.innerHTML=html||"";
    try{ window.v7SplitApproachBadge && window.v7SplitApproachBadge(); }catch(e){}
    return;
  }

  // Réutilisation des cartes existantes pour éviter les sauts visuels.
  const existing=new Map(
    [...target.querySelectorAll(".live-card[data-vehicle]")]
      .map(card=>[card.dataset.vehicle||"", card])
  );

  const frag=document.createDocumentFragment();

  incoming.forEach(newCard=>{
    const v=newCard.dataset.vehicle||"";
    const oldCard=existing.get(v);

    if(oldCard){
      // On garde le noeud de carte existant, mais on remplace son contenu.
      oldCard.className=newCard.className;
      oldCard.setAttribute("data-vehicle", v);
      oldCard.innerHTML=newCard.innerHTML;
      frag.appendChild(oldCard);
      existing.delete(v);
    }else{
      frag.appendChild(newCard);
    }
  });


  target.replaceChildren(frag);

  try{ window.v7SplitApproachBadge && window.v7SplitApproachBadge(); }catch(e){}

  if(window.mapVehicleToOpen){
    const wantedLine=String(window.mapVehicleToOpen.line||"");
    const wantedVehicle=String(window.mapVehicleToOpen.vehicle||"");

    if(String(currentLine)===wantedLine){
      const wantedCard=document.querySelector(
        `.live-card[data-vehicle="${CSS.escape(wantedVehicle)}"]`
      );

      if(wantedCard && window.openVehiclePortrait){
        window.v7VehicleOrigin = window.v7VehicleOrigin || "line";

        window.openVehiclePortrait(wantedCard);
        window.mapVehicleToOpen=null;
      }
    }
  }

  applyVehicleFavoriteOrder(document);

  document.querySelectorAll("#lineContent .live-card").forEach(card=>{
    const v=card.dataset.vehicle||"";
    const btn=card.querySelector(".vehicle-fav-btn");

    if(btn){
      const active=favVehicles.has(currentLine+"|"+v);
      btn.textContent=active?"★":"☆";
      card.classList.toggle("vehicle-favorite",active);

      btn.onclick=(e)=>{
        e.preventDefault();
        e.stopPropagation();

        const k=currentLine+"|"+v;
        if(favVehicles.has(k)){
          favVehicles.delete(k);
        }else{
          favVehicles.add(k);
        }

        saveVehicleFavs();
        renderTracking();
        applyVehicleFavoriteOrder(document);
        refreshLine();
      };
    }

    // Recalage direct : le backend décide.
    // Le bus peut avancer OU reculer sans animation qui le retient.
    // Le terminus garde son rendu spécifique.
    const bus=card.querySelector(".tcl-timeline-v3-bus");
    if(bus){
      bus.style.transition="none";
    }
  });

 }catch(e){
  $("#lineContent").innerHTML="Impossible de rafraîchir la ligne.";
 }
}


window.mapVehicleToOpen=null;

let selectedMapLine=null;
let selectedMapPathRef=null;
let selectedLineLayer=null;
let selectedStopLayer=null;
let btPathCache={};

function clearSelectedLineMap(){
 if(selectedLineLayer && map){
  try{ map.removeLayer(selectedLineLayer); }catch(e){}
 }
 if(selectedStopLayer && map){
  try{ map.removeLayer(selectedStopLayer); }catch(e){}
 }
 selectedLineLayer=null;
 selectedStopLayer=null;
 selectedMapLine=null;
 selectedMapPathRef=null;
}

async function getOfficialPath(pathRef){
 if(!pathRef) return [];
 if(btPathCache[pathRef]) return btPathCache[pathRef];

 try{
  const j=await (await fetch("/api/bt_path?ref="+encodeURIComponent(pathRef)+"&t="+Date.now())).json();
  const pts=(j.p||[])
   .map(x=>[parseFloat(x[0]),parseFloat(x[1])])
   .filter(x=>Number.isFinite(x[0]) && Number.isFinite(x[1]));

  btPathCache[pathRef]=pts;
  return pts;
 }catch(e){
  return [];
 }
}

function fallbackCallsForLine(line){
 const same=buses.filter(b=>String(b.line)===String(line));
 for(const b of same){
  const calls=(b.raw && Array.isArray(b.raw.bt_calls)) ? b.raw.bt_calls : [];
  const coords=calls
   .map(c=>[parseFloat(c.latitude),parseFloat(c.longitude),c])
   .filter(x=>Number.isFinite(x[0]) && Number.isFinite(x[1]));
  if(coords.length>=2) return coords;
 }
 return [];
}

async function focusLineOnMap(line,pathRef){
 if(!map) return;

 selectedMapLine=String(line);
 selectedMapPathRef=pathRef||selectedMapPathRef||"";

 const same=buses.filter(b=>String(b.line)===String(line));

 if(selectedLineLayer){
  try{ map.removeLayer(selectedLineLayer); }catch(e){}
 }
 if(selectedStopLayer){
  try{ map.removeLayer(selectedStopLayer); }catch(e){}
 }

 let latlngs=[];
 if(selectedMapPathRef){
  latlngs=await getOfficialPath(selectedMapPathRef);
 }

 if(latlngs.length<2){
  const calls=fallbackCallsForLine(line);
  latlngs=calls.map(x=>[x[0],x[1]]);
 }

 if(latlngs.length>=2){
  selectedLineLayer=L.polyline(latlngs,{
   weight:8,
   opacity:.94,
   color:color(line),
   lineCap:"round",
   lineJoin:"round",
   smoothFactor:1.2
  }).addTo(map);
 }

 Object.entries(markers).forEach(([id,m])=>{
  const isSame=id.startsWith(String(line)+"|");
  const el=m.getElement && m.getElement();
  if(el){
   el.classList.toggle("map-line-selected", isSame);
   el.classList.toggle("map-line-dimmed", !isSame);
  }
 });

 const bounds=[];
 latlngs.forEach(x=>bounds.push(x));
 same.forEach(b=>bounds.push([b.lat,b.lon]));

 if(bounds.length){
  try{
   map.fitBounds(bounds,{padding:[42,42],maxZoom:15,animate:true});
  }catch(e){}
 }
}


function busPopupHtml(b){
 const raw=b.raw||{};
 const line=escapeHtml(String(b.line||raw.ligne||"?").toUpperCase());
 const vehicle=escapeHtml(String(b.vehicle||raw.vehicule||"?"));
 const dest=escapeHtml(raw.bt_destination||b.destination||raw.destination||"Destination inconnue");
 const next=escapeHtml(raw.bt_next_stop||b.stop||raw.arret_courant||"Prochain arrêt indisponible");

 return `
  <div class="v7-map-popup">
    <div class="v7-map-popup-title">${line} · Bus ${vehicle}</div>
    <div class="v7-map-popup-row"><b>Direction</b><span>${dest}</span></div>
    <div class="v7-map-popup-row"><b>Prochain arrêt</b><span>${next}</span></div>
    <button class="v7-map-popup-open" type="button" data-line="${line}" data-vehicle="${vehicle}">Ouvrir</button>
  </div>
 `;
}

function bindBusPopup(marker,b){
 marker.bindPopup(busPopupHtml(b),{
  closeButton:false,
  autoPan:true,
  className:"v7-leaflet-popup"
 });

 marker.on("popupopen",()=>{
  setTimeout(()=>{
   document.querySelectorAll(".v7-map-popup-open[data-line]").forEach(btn=>{
    btn.onclick=e=>{
     e.preventDefault();
     e.stopPropagation();

     window.mapVehicleToOpen = {
       line: btn.dataset.line,
       vehicle: btn.dataset.vehicle
     };

     openLine(btn.dataset.line,true);
    };
   });
  },30);
 });
}

function renderMap(){
 if(!map || !Array.isArray(buses)) return;

 const seen=new Set();

 buses.forEach(b=>{
  let id=b.line+"|"+b.vehicle;
  seen.add(id);

  if(markers[id]){
   markers[id].setLatLng([b.lat,b.lon]);

   const iconHtml=markerIcon(b);
   try{
    markers[id].setIcon(iconHtml);
   }catch(e){}
  }else{
   markers[id]=L.marker([b.lat,b.lon],{icon:markerIcon(b)})
    .addTo(map);

   bindBusPopup(markers[id],b);

   markers[id].on("click",(e)=>{
      if(e && e.originalEvent) L.DomEvent.stopPropagation(e);

      const pathRef=b.raw && b.raw.bt_path_ref ? b.raw.bt_path_ref : "";

      focusLineOnMap(b.line,pathRef);

      try{
        markers[id].openPopup();
      }catch(err){}
    });
  }

  const el=markers[id].getElement && markers[id].getElement();
  if(el && selectedMapLine){
   const isSame=String(b.line)===String(selectedMapLine);
   el.classList.toggle("map-line-selected", isSame);
   el.classList.toggle("map-line-dimmed", !isSame);
  }
 });

 Object.keys(markers).forEach(id=>{
  if(!seen.has(id)){
   try{
    map.removeLayer(markers[id]);
   }catch(e){}
   delete markers[id];
  }
 });

 if(selectedMapLine){
  focusLineOnMap(selectedMapLine,selectedMapPathRef);
 }
}
function renderTracking(){
 try {
 if(!$("#trackList")) return;
 const q=queryText();
 let arr=buses.filter(b=>!q||String(b.line).toUpperCase().includes(q)||String(b.vehicle).includes(q)||String(b.destination).toUpperCase().includes(q));

 if(q){
  const byLine={};
  arr.forEach(b=>{
   const l=String(b.line);
   byLine[l]=byLine[l]||{line:l,count:0};
   byLine[l].count++;
  });

  const lines=Object.values(byLine).sort((a,b)=>String(a.line).localeCompare(String(b.line),"fr",{numeric:true}));

  $("#trackList").innerHTML=`<div class="widget-bubbles">`+
   (lines.length
    ? lines.map(x=>`<button class="bubble bus" data-line="${x.line}">${icon(x.line)} ${x.line} · ${x.count}</button>`).join("")
    : `<div class="bubble empty">Aucune ligne trouvée</div>`) +
   `</div>`;

  document.querySelectorAll("#trackList .bubble.bus[data-line]").forEach(c=>c.onclick=e=>{
   e.preventDefault();
   e.stopPropagation();
   openLine(c.dataset.line, false);
  });
  return;
 }

 buses.forEach(b=>rememberVehicleOrder(b.line,b.vehicle));

 arr.sort((a,b)=>{
   const ka=stableVehicleKey(a.line,a.vehicle);
   const kb=stableVehicleKey(b.line,b.vehicle);
   const fa=favVehicles.has(ka);
   const fb=favVehicles.has(kb);
   if(fa && fb) return favRank(ka)-favRank(kb);
   if(fa) return -1;
   if(fb) return 1;
   return (vehicleOrder[ka]||999999)-(vehicleOrder[kb]||999999);
 });

 arr=arr.slice(0,18);

 $("#trackList").innerHTML=`<div class="widget-bubbles">`+
  (arr.length
   ? arr.map(b=>{
      const k=stableVehicleKey(b.line,b.vehicle);
      const active=favVehicles.has(k);
      return `<button class="bubble bus ${active?'vehicle-favorite':''}" data-line="${b.line}" data-vehicle="${b.vehicle}">${active?'★':'🚌'} ${b.line} · ${b.vehicle}</button>`;
    }).join("")
   : `<div class="bubble empty">Aucun bus</div>`) +
  `</div>`;

 document.querySelectorAll("#trackList .bubble.bus[data-line]").forEach(c=>c.onclick=e=>{
   e.preventDefault();
   e.stopPropagation();
   openLine(c.dataset.line, false);
 });

 } finally {
  v7EnhanceTrackingFavorites();
 }
}

async function loadTraffic(){
 try{
  const j = await (await fetch("/api/traffic?t="+Date.now())).json();
  const alerts = sortTrafficAlertsByDate(j.alerts || j.items || []);
  window.v7TrafficAlerts = alerts;

  const box = $("#trafficList");
  if(!box) return;

  if(!alerts.length){
   box.innerHTML = `<div class="v7-lines-empty">Aucune perturbation majeure</div>`;
   return;
  }

  const byLine = {};
  alerts.forEach(a=>{
   const l = String(a.line || "").trim();
   if(!l) return;
   byLine[l] = byLine[l] || { line:l, count:0, alerts:[] };
   byLine[l].count++;
   byLine[l].alerts.push(a);
  });

  const allLines = Object.values(byLine).sort((a,b)=>
   String(a.line).localeCompare(String(b.line),"fr",{numeric:true})
  );

  const groups = [
   {
    title:"Métro",
    test:l => /^[ABCD]$/.test(l)
   },
   {
    title:"Tramway",
    test:l => /^T/.test(l)
   },
   {
    title:"Funiculaire",
    test:l => /^F/.test(l)
   },
   {
    title:"Lignes fortes",
    test:l => /^C\d+/.test(l)
   },
   {
    title:"Bus",
    test:l => /^\d+$|^\d+[A-Z]$|^[A-Z]+\d+$/.test(l) && !/^C\d+/.test(l) && !/^T/.test(l) && !/^F/.test(l) && !/^JD/.test(l)
   },
   {
    title:"Junior Direct",
    test:l => /^JD/.test(l)
   },
   {
    title:"Autres lignes",
    test:l => true
   }
  ];

  const used = new Set();

  function badgeClass(line){
   if(/^[ABCD]$/.test(line)) return "metro";
   if(/^T/.test(line)) return "tram";
   if(/^F/.test(line)) return "funi";
   if(/^C\d+/.test(line)) return "forte";
   if(/^JD/.test(line)) return "jd";
   return "bus";
  }

  const html = groups.map(g=>{
   const lines = allLines.filter(x=>{
    if(used.has(x.line)) return false;
    if(!g.test(x.line)) return false;
    used.add(x.line);
    return true;
   });

   if(!lines.length) return "";

   return `
    <section class="v7-traffic-group">
      <div class="v7-traffic-group-title"><span>${g.title}</span></div>
      <div class="v7-traffic-grid">
        ${lines.map(x=>`
          <button class="v7-traffic-line-card" data-line="${x.line}">
            <span class="v7-traffic-line-badge ${badgeClass(x.line)}">${x.line}</span>
            <span class="v7-traffic-line-count">${x.count} info${x.count>1 ? "s" : ""}</span>
          </button>
        `).join("")}
      </div>
    </section>
   `;
  }).join("");

  box.innerHTML = html || `<div class="v7-lines-empty">Aucune perturbation majeure</div>`;

  box.querySelectorAll(".v7-traffic-line-card[data-line]").forEach(btn=>{
   btn.onclick = e=>{
    e.preventDefault();
    e.stopPropagation();
    openTrafficPage(btn.dataset.line);
   };
  });

 }catch(e){
  const box = $("#trafficList");
  if(box) box.innerHTML = `<div class="v7-lines-empty">Info trafic indisponible</div>`;
 }
}

function trafficSortTimestamp(a){
  if(a && a.start){
    const d = new Date(a.start);
    if(!isNaN(d.getTime())) return d.getTime();
  }

  const label = String((a && a.period_label) || "");
  const m = label.match(/Du\s+(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+à\s+(\d{1,2}):(\d{2}))?/i);
  if(m){
    const dd = String(m[1]).padStart(2,"0");
    const mm = String(m[2]).padStart(2,"0");
    const yyyy = m[3];
    const hh = String(m[4] || "00").padStart(2,"0");
    const mi = String(m[5] || "00").padStart(2,"0");
    const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00`);
    if(!isNaN(d.getTime())) return d.getTime();
  }

  return 9999999999999;
}

function sortTrafficAlertsByDate(alerts){
  return [...(alerts || [])].sort((a,b)=>{
    const da = trafficSortTimestamp(a);
    const db = trafficSortTimestamp(b);
    if(da !== db) return da - db;
    return String(a.line||"").localeCompare(String(b.line||""),"fr",{numeric:true});
  });
}


function trafficIconForText(text){
 text=String(text||"").toLowerCase();
 if(text.includes("travaux")) return "🚧";
 if(text.includes("déviation") || text.includes("deviation")) return "↪";
 if(text.includes("interrompu") || text.includes("suppression")) return "⛔";
 return "⚠";
}

async function ensureTrafficAlerts(){
 if(window.v7TrafficAlerts && window.v7TrafficAlerts.length) return window.v7TrafficAlerts;
 try{
  const j=await (await fetch("/api/traffic?t="+Date.now())).json();
  window.v7TrafficAlerts=j.alerts||j.items||[];
 }catch(e){
  window.v7TrafficAlerts=[];
 }
 return window.v7TrafficAlerts;
}

async function renderInlineTrafficForLine(line){
 const box=$("#lineTrafficInline");
 if(!box) return;

 const all=await ensureTrafficAlerts();
 const alerts=sortTrafficAlertsByDate(all.filter(a=>String(a.line||"").toUpperCase()===String(line).toUpperCase()));

 if(!alerts.length){
  box.remove();
  return;
 }else{
  box.innerHTML=`
   <div class="line-traffic-head">
    <span>Info trafic · Ligne ${line} · ${alerts.length}</span>
    <span>⌄</span>
   </div>
   <div class="line-traffic-body">
    ${alerts.map(a=>{
      const ico=trafficIconForText((a.text||"")+" "+(a.title||""));
      return `<div class="line-traffic-card"><b>${ico} ${a.title||"Info trafic"}</b>${formatTrafficPeriod(a) ? `<small class="traffic-period">${formatTrafficPeriod(a)}</small>` : ""}
<small>${a.text||""}${a.period_label?`<br><br><b>${a.period_label}</b>`:""}</small></div>`;
    }).join("")}
   </div>`;
 }

 box.onclick=()=>box.classList.toggle("open");
}


async function renderTrafficPage(line){
 const box=$("#trafficContent");
 if(!box) return;

 try{
  const alerts = (window.v7TrafficAlerts || await ensureTrafficAlerts())
   .filter(a=>String(a.line||"").toUpperCase()===String(line||"").toUpperCase());

  if(!alerts.length){
   box.innerHTML=`<div class="bubble empty">Aucune info trafic pour la ligne ${line}</div>`;
   return;
  }

  box.innerHTML = alerts.map(a=>{
   const ico = trafficIconForText((a.text||"")+" "+(a.title||""));
   return `<div class="line-traffic-card">
    <b>${ico} ${a.title||"Info trafic"}</b>
    ${formatTrafficPeriod(a) ? `<small class="traffic-period">${formatTrafficPeriod(a)}</small>` : ""}
<small>${a.text||""}${a.period_label?`<br><br><b>${a.period_label}</b>`:""}</small>
   </div>`;
  }).join("");
 }catch(e){
  box.innerHTML=`<div class="bubble empty">Info trafic indisponible</div>`;
 }
}


function openTrafficPage(line){
 currentLine=null;
 if(lineTimer){clearInterval(lineTimer);lineTimer=null}
 document.body.classList.remove("search-focus");
 try{
  hideSearchSuggestions();
  const q=document.querySelector("#q");
  if(q) q.blur();
 }catch(e){}
 setViewMode("traffic");
 v7RefreshMapSize();
 $("#trafficTitle").textContent="Info trafic "+line;
 renderTrafficPage(line);
}

async function openLine(line, withTraffic=true){
 currentLine=line;
 if(lineTimer){clearInterval(lineTimer);lineTimer=null}
 document.body.classList.remove("search-focus");
 try{
  hideSearchSuggestions();
  const q=document.querySelector("#q");
  if(q) q.blur();
 }catch(e){}
 setViewMode("line");
 v7RefreshMapSize();

 v7RenderLineTitle(line);
 $("#lineContent").innerHTML=`
  ${withTraffic ? '<div class="line-traffic-inline" id="lineTrafficInline"></div>' : ''}
  <div id="busCards">Chargement des bus…</div>
 `;

 if(withTraffic){
  await renderInlineTrafficForLine(line);
 }
 await refreshLine();

 lineTimer=setInterval(refreshLine,1000);
}

function home(){
 v7RefreshMapSize();
 try{ window.v7Itineraire?.close?.(false); }catch(e){}
 if(lineTimer){
  clearInterval(lineTimer);
  lineTimer=null;
 }

 currentLine=null;

 const q = document.querySelector("#q");
 if(q){
  q.value = "";
 }
  const search = document.querySelector(".v7-search");
  if(search) search.classList.remove("has-value");

 setViewMode("home");

 try{
  renderTracking();
  loadTraffic();
 }catch(e){}
}
if($("#lineBack")) $("#lineBack").onclick=home;if($("#trafficBack")) $("#trafficBack").onclick=home;
["lineBack","trafficBack"].forEach(function(id){
 const b=document.getElementById(id);
 if(!b) return;
 if(!b.getAttribute("aria-label")) b.setAttribute("aria-label","Retour");
 if((b.textContent||"").trim().length>2) b.textContent="";
});
const mainSearchInput = $("#q");
if(mainSearchInput){
 mainSearchInput.oninput=()=>{
  renderSearchSuggestions();
  try{ renderTracking(); }catch(e){ console.warn("V7 search input tracking skipped", e); }
  try{ Promise.resolve(loadTraffic()).catch(err=>console.warn("V7 search input traffic skipped", err)); }catch(e){ console.warn("V7 search input traffic skipped", e); }
 };
}

function updateRecenterButton(){
 const btn=$("#recenterMap");
 if(!btn) return;
 btn.classList.toggle("active", !!userFollow);
}

function v7DegToRad(v){ return v * Math.PI / 180; }
function v7NormalizeBearing(v){
 v=Number(v);
 if(!Number.isFinite(v)) return null;
 return ((v % 360) + 360) % 360;
}
function v7AngleDelta(from,to){
 return ((to - from + 540) % 360) - 180;
}
function v7DistanceMeters(a,b){
 if(!a || !b) return 0;
 const R=6371000;
 const dLat=v7DegToRad(b.lat-a.lat);
 const dLon=v7DegToRad(b.lon-a.lon);
 const lat1=v7DegToRad(a.lat), lat2=v7DegToRad(b.lat);
 const s=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
 return 2*R*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
}
function v7BearingBetween(a,b){
 if(!a || !b) return null;
 const lat1=v7DegToRad(a.lat), lat2=v7DegToRad(b.lat);
 const dLon=v7DegToRad(b.lon-a.lon);
 const y=Math.sin(dLon)*Math.cos(lat2);
 const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
 return v7NormalizeBearing(Math.atan2(y,x)*180/Math.PI);
}
function v7GpsNavPrecisionOk(next){
 return !!next && Number(next.accuracy||999) <= 30;
}
function v7PositionAcceptable(next){
 if(!next || !Number.isFinite(next.lat) || !Number.isFinite(next.lon)) return false;
 if(next.accuracy && next.accuracy > 250) return false;
 if(!v7LastAcceptedPos) return true;
 const dist=v7DistanceMeters(v7LastAcceptedPos,next);
 const dt=Math.max(.25,(next.t-v7LastAcceptedPos.t)/1000);
 const impliedSpeed=dist/dt;
 if((next.accuracy||999) > 75 && dist > Math.max(120,(next.accuracy||0)*2.5)) return false;
 if(impliedSpeed > 80 && (next.accuracy||999) > 30) return false;
 return true;
}
function v7ApplyMapBearing(){ return null; }
function v7RefreshGpsTiles(force=false){
 if(!v7TileLayer) return;
 const now=Date.now();
 if(!force && now-v7LastTileRefresh < 900) return;
 v7LastTileRefresh=now;
 try{ if(v7TileLayer._update) v7TileLayer._update(); }catch(e){}
}
function v7ResetNavigationCourse(){
 v7NavStableCourse=null;
 v7NavCandidateCourse=null;
 v7NavCandidateHits=0;
 v7NavLastCourseAt=0;
}
function v7ResetMapBearing(){
 v7MapBearing=0;
 const pane=map && map.getPane && map.getPane("mapPane");
 if(pane){
  pane.style.rotate="0deg";
  pane.style.scale="";
  pane.style.transformOrigin="";
  pane.style.willChange="";
 }
}
function v7SetGpsNavigation(){ return null; }
function v7HandleDeviceOrientation(e){
 let h=null;
 if(typeof e.webkitCompassHeading === "number") h=e.webkitCompassHeading;
 else if(e.absolute && typeof e.alpha === "number") h=360-e.alpha;
 h=v7NormalizeBearing(h);
 if(h===null) return;
 v7DeviceBearing=h;

}
async function v7RequestDeviceOrientation(){
 if(v7OrientationReady) return true;
 try{
  if(window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function"){
   const res=await window.DeviceOrientationEvent.requestPermission();
   if(res !== "granted") return false;
  }
  window.addEventListener("deviceorientation", v7HandleDeviceOrientation, true);
  window.addEventListener("deviceorientationabsolute", v7HandleDeviceOrientation, true);
  v7OrientationReady=true;
  return true;
 }catch(e){
  console.warn("Orientation appareil indisponible", e);
  return false;
 }
}
function v7UpdateHeadingMarker(){ return null; }
function v7RawCourseFromPosition(next){
 if(!next) return null;
 const c=next.raw && next.raw.coords;
 const speed=Number(c && c.speed);
 if(c && Number.isFinite(c.heading) && c.heading >= 0 && speed >= 5 && (next.accuracy||999) <= 25){
  return v7NormalizeBearing(c.heading);
 }
 if(v7LastAcceptedPos && (next.accuracy||999) <= 30 && (v7LastAcceptedPos.accuracy||999) <= 35){
  const dist=v7DistanceMeters(v7LastAcceptedPos,next);
  const dt=Math.max(.25,(next.t-v7LastAcceptedPos.t)/1000);
  if(dt <= 12 && dist >= Math.max(18,(next.accuracy||0)*.75)) return v7BearingBetween(v7LastAcceptedPos,next);
 }
 return null;
}
function v7StableNavigationCourse(raw,next){
 raw=v7NormalizeBearing(raw);
 if(raw===null || !next) return null;
 const speed=Number(next.raw && next.raw.coords && next.raw.coords.speed || 0);
 const now=next.t||Date.now();
 if(!v7NavStableCourse || now-v7NavLastCourseAt > 10000){
  if(v7NavCandidateCourse===null || Math.abs(v7AngleDelta(v7NavCandidateCourse,raw)) > 35){
   v7NavCandidateCourse=raw;
   v7NavCandidateHits=1;
   return null;
  }
  v7NavCandidateCourse=v7NormalizeBearing(v7NavCandidateCourse + v7AngleDelta(v7NavCandidateCourse,raw)*.35);
  v7NavCandidateHits++;
  if(v7NavCandidateHits < 2) return null;
  v7NavStableCourse=v7NavCandidateCourse;
  v7NavLastCourseAt=now;
  return v7NavStableCourse;
 }
 const delta=v7AngleDelta(v7NavStableCourse,raw);
 if(Math.abs(delta) > 95 && speed < 12){
  if(v7NavCandidateCourse===null || Math.abs(v7AngleDelta(v7NavCandidateCourse,raw)) > 30){
   v7NavCandidateCourse=raw;
   v7NavCandidateHits=1;
   return v7NavStableCourse;
  }
  v7NavCandidateHits++;
  if(v7NavCandidateHits < 2) return v7NavStableCourse;
 }else{
  v7NavCandidateCourse=null;
  v7NavCandidateHits=0;
 }
 const alpha=speed >= 13 ? .20 : speed >= 8 ? .15 : .10;
 const maxStep=speed >= 13 ? 20 : speed >= 8 ? 14 : 8;
 const step=Math.max(-maxStep,Math.min(maxStep,delta*alpha));
 v7NavStableCourse=Math.abs(delta) < 4 ? raw : v7NormalizeBearing(v7NavStableCourse + step);
 v7NavLastCourseAt=now;
 return v7NavStableCourse;
}
function v7GpsHeadingFromPosition(next){
 return v7StableNavigationCourse(v7RawCourseFromPosition(next),next);
}
function v7NavigationZoom(){
 return v7GpsNav ? 15 : Math.max(map.getZoom() || 15, 16);
}
function v7ProgrammaticSetView(latlng,zoom,opts){
 if(!map) return;
 v7ProgrammaticMapMove=true;
 map.setView(latlng, zoom, opts||{});
 setTimeout(()=>{ v7ProgrammaticMapMove=false; }, 350);
}

function updateUserPosition(p, initial=false){
 const next={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy||0,t:Date.now(),raw:p};
 window.__v7GpsRaw={lat:next.lat,lon:next.lon,accuracy:next.accuracy,heading:p.coords.heading,speed:p.coords.speed,t:next.t};
 if(!v7PositionAcceptable(next)){
  console.warn("Position GPS ignorée: précision/saut incohérent", window.__v7GpsRaw);
  if(v7GpsNav && userFollow && !v7GpsNavPrecisionOk(next)) v7SetGpsNavigation(false,false);
  updateRecenterButton();
  return;
 }
 if(v7GpsNav && userFollow && !v7GpsNavPrecisionOk(next)){
  console.warn("Mode GPS navigation désactivé: précision insuffisante", window.__v7GpsRaw);
  v7SetGpsNavigation(false,false);
 }
 const heading=v7GpsNav ? v7GpsHeadingFromPosition(next) : null;
 pos={lat:next.lat,lon:next.lon,accuracy:next.accuracy};
 v7LastAcceptedPos=next;
 window.__v7GpsAccepted={...pos,heading:heading,t:next.t};

 if(!map) return;

 const latlng=[pos.lat,pos.lon];

 if(!userMarker){
  userMarker=L.circleMarker(latlng,{
   radius:8,
   color:"#ffffff",
   weight:3,
   fillColor:"#2563eb",
   fillOpacity:1,
   opacity:1,
   className:"v7-user-dot"
  }).addTo(map);
 }else{
  userMarker.setLatLng(latlng);
 }

 if(!userAccuracy){
  userAccuracy=L.circle(latlng,{
   radius:Math.min(Math.max(pos.accuracy||20,20),120),
   color:"#2563eb",
   weight:1,
   fillColor:"#2563eb",
   fillOpacity:.12,
   opacity:.25,
   className:"v7-user-accuracy"
  }).addTo(map);
 }else{
  userAccuracy.setLatLng(latlng);
  userAccuracy.setRadius(Math.min(Math.max(pos.accuracy||20,20),120));
 }

 if(userFollow || initial){
  v7ProgrammaticSetView(latlng, v7NavigationZoom(), {animate:false});
  if(v7GpsNav){
   requestAnimationFrame(()=>{
    try{ map.invalidateSize({pan:false,animate:false}); }catch(e){}
    v7ApplyMapBearing(heading !== null ? heading : v7MapBearing);
    v7RefreshGpsTiles();
   });
  }
 }

 if(v7GpsNav && userFollow && heading !== null && (pos.accuracy||999) <= 100){
  v7ApplyMapBearing(heading);
  v7UpdateHeadingMarker(latlng,heading);
 }else{
  v7UpdateHeadingMarker(latlng,null);
 }

 updateRecenterButton();
}

function recenterUser(enableGpsNav=true){
 if(!pos || !map) return;
 userFollow=true;
 userMovedMap=false;
 if(enableGpsNav && v7GpsNavPrecisionOk(pos)){
  v7SetGpsNavigation(true,false);
  v7ProgrammaticSetView([pos.lat,pos.lon], v7NavigationZoom(), {animate:true});
 }else{
  v7SetGpsNavigation(false,false);
  v7ProgrammaticSetView([pos.lat,pos.lon], Math.max(map.getZoom() || 15, 16), {animate:true});
 }
 updateRecenterButton();
}

function initGeolocation(){
 if(!navigator.geolocation) return;

 const btn=$("#recenterMap");
 if(btn){
  btn.onclick=(e)=>{
   e.preventDefault();
   e.stopPropagation();
   recenterUser();
  };
 }

 navigator.geolocation.getCurrentPosition(
  p=>updateUserPosition(p,true),
  e=>console.warn("GPS initial indisponible",e),
  {enableHighAccuracy:true,maximumAge:0,timeout:20000}
 );

 if(!geoWatchId){
  geoWatchId=navigator.geolocation.watchPosition(
   p=>updateUserPosition(p,false),
   e=>console.warn("GPS watch indisponible",e),
   {enableHighAccuracy:true,maximumAge:0,timeout:20000}
  );
 }
}

function v7Boot(){
 initMap();
 initGeolocation();
 load();
 if(!window.v7LoadTimer){
  window.v7LoadTimer=setInterval(load,5000);
 }
}

if(document.readyState==="loading"){
 document.addEventListener("DOMContentLoaded", v7Boot);
}else{
 v7Boot();
}


// === TCL TEMPS REEL V7 BASE ===


function v7RefreshMapSize(){
 if(map){
  setTimeout(()=>map.invalidateSize(),80);
  setTimeout(()=>map.invalidateSize(),350);
 }
}




// === V7_MAP_FIRST_IMMERSION ===

function v7MapFocus(active){
 const shell=document.querySelector(".v7-map-shell");
 if(!shell) return;

 if(active){
  shell.style.transition="transform .28s ease, filter .28s ease";
  shell.style.filter="brightness(.92)";
 }else{
  shell.style.filter="";
 }
}

// === V7_SEARCH_FOCUS ===
(function(){
  function v7SyncSearchMarquee(input){
    var wrap = document.querySelector(".v7-search");
    if(!wrap || !input) return;
    wrap.classList.toggle("has-value", !!input.value.trim());
  }

  function v7InitSearchMarquee(input){
    var wrap = document.querySelector(".v7-search");
    if(!wrap || !input || wrap.dataset.v7SearchMarqueeReady === "1") return;

    wrap.dataset.v7SearchMarqueeReady = "1";
    wrap.classList.add("marquee-ready");

    var label = input.getAttribute("placeholder") || "Rechercher une ligne ou une carrosserie...";
    input.setAttribute("aria-label", label);

    var marquee = document.createElement("div");
    marquee.className = "v7-search-marquee";
    marquee.setAttribute("aria-hidden", "true");
    var track = document.createElement("span");
    track.className = "v7-search-marquee-track";
    track.textContent = label;
    marquee.appendChild(track);
    wrap.appendChild(marquee);

    v7SyncSearchMarquee(input);
  }

  function v7SetSearchFocus(active){
    document.body.classList.toggle("search-focus", !!active);
    try{
      if(window.map){
        setTimeout(function(){ window.map.invalidateSize(); }, 120);
      }else if(typeof map !== "undefined" && map){
        setTimeout(function(){ map.invalidateSize(); }, 120);
      }
    }catch(e){}
  }

  function initSearchFocus(){
    var input = document.querySelector("#q");
    if(!input || input.dataset.v7SearchFocusReady === "1") return;

    input.dataset.v7SearchFocusReady = "1";
    v7InitSearchMarquee(input);

    input.addEventListener("focus", function(){
      v7SetSearchFocus(true);
      v7SyncSearchMarquee(input);
    });

    input.addEventListener("input", function(){
      v7SyncSearchMarquee(input);
    });

    input.addEventListener("blur", function(){
      v7SyncSearchMarquee(input);
      setTimeout(function(){
        if(!input.value.trim()){
          v7SetSearchFocus(false);
        }
      }, 160);
    });

    input.addEventListener("input", function(){
      v7SetSearchFocus(!!input.value.trim() || document.activeElement === input);
    });
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", initSearchFocus);
  }else{
    initSearchFocus();
  }

  
async function planWithTclOfficial(){
  if(typeof window.__itiPlan === "function"){
    return window.__itiPlan();
  }
  const out = document.querySelector("#itiOutput");
  if(out) out.innerHTML = `<div class="iti-error">Module itinéraire non initialisé.</div>`;
}

window.__tclPlanOfficial = planWithTclOfficial;

document.addEventListener("click", async function(e){
    const btn = e.target && e.target.closest && e.target.closest("#itiPlanBtn,[data-iti-plan]");
    if(!btn) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      await planWithTclOfficial();
    } catch(err) {
      console.error("ITI_TCL_CLICK_ERROR", err);
      const out = document.querySelector("#itiOutput");
      if(out) out.innerHTML = `<div class="iti-error">Calcul d’itinéraire indisponible pour le moment.</div>`;
    }
  }, true);

})();











// V7_OPEN_SEARCH_FINAL
(function(){
  function cleanLineInput(){
    return String(document.querySelector("#q")?.value || "")
      .trim()
      .toUpperCase()
      .replace(/^LIGNE\s+/,"");
  }

  function resolveLine(q){
    if(!q) return "";

    // exact : C10 -> C10
    let exact = (window.buses || buses || []).find(b => String(b.line || "").toUpperCase() === q);
    if(exact) return String(exact.line);

    // fallback direct : même si les bus ne sont pas encore chargés
    return q;
  }

  function openSearchNow(){
    const q = cleanLineInput();
    if(!q) return;

    try{
      const input = document.querySelector("#q");
      if(input) input.blur();
    }catch(e){}

    const groups = buildSearchSuggestions(q);
    const exactLine = groups.lines.find(item => v7NormalizeSearch(item.line) === v7NormalizeSearch(q));
    if(exactLine){
      hideSearchSuggestions();
      openLine(exactLine.line, true);
      return;
    }

    const vehicle = groups.vehicles[0];
    if(vehicle){
      openVehicleFromSearch(vehicle.line, vehicle.vehicle);
      return;
    }

    const firstLine = groups.lines[0];
    if(firstLine){
      hideSearchSuggestions();
      openLine(firstLine.line, true);
    }
  }

  document.addEventListener("click", function(e){
    const suggestion = e.target.closest(".v7-search-suggestion");
    if(suggestion){
      e.preventDefault();
      e.stopPropagation();

      if(suggestion.dataset.type === "vehicle"){
        openVehicleFromSearch(suggestion.dataset.line, suggestion.dataset.vehicle);
      }else{
        hideSearchSuggestions();
        openLine(suggestion.dataset.line, true);
      }
      return;
    }

    const btn = e.target.closest("#openSearch");
    if(!btn) return;

    e.preventDefault();
    e.stopPropagation();
    openSearchNow();
  }, true);

  document.addEventListener("input", function(e){
    if(e.target && e.target.id === "q"){
      renderSearchSuggestions();
    }
  }, true);

  document.addEventListener("click", function(e){
    if(e.target.closest(".v7-search")) return;
    hideSearchSuggestions();
  });

  document.addEventListener("keydown", function(e){
    if(e.key !== "Enter") return;
    if(e.target && e.target.id === "q"){
      e.preventDefault();
      openSearchNow();
    }
  }, true);

})();


// V7_MAP_THEME_AUTO_RELOAD
try{
 const mq = window.matchMedia("(prefers-color-scheme: dark)");
 mq.addEventListener("change", ()=>{
  location.reload();
 });
}catch(e){}

/* V7 — rendu favoris accueil centralisé */

/* V7 — watchdog GPS : relance si le GPS ne remonte plus */
(function(){
  setInterval(function(){
    try{
      if(!navigator.geolocation || !geoWatchId) return;
      const last = window.__v7GpsRaw?.t || window.__v7GpsStable?.t || 0;
      if(last && Date.now() - last > 25000){
        navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = navigator.geolocation.watchPosition(
          p=>updateUserPosition(p,false),
          e=>console.warn("GPS watchdog indisponible",e),
          {enableHighAccuracy:true,maximumAge:0,timeout:20000}
        );
      }
    }catch(e){}
  }, 10000);
})();


/* === V7 VEHICLE PORTRAIT VIEW START === */
(function(){
  let selectedVehicle = null;
  let selectedLine = null;
  let refreshTimer = null;

  function qs(sel, root=document){ return root.querySelector(sel); }
  function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

  function ensureVehiclePortrait(){
    let view = qs("#vehiclePortraitView");
    if(view) return view;

    view = document.createElement("section");
    view.id = "vehiclePortraitView";
    view.innerHTML = `
      <div class="vehicle-portrait-backdrop"></div>
      <div class="vehicle-portrait-panel">
          <div class="vehicle-portrait-topbar">
            <button class="vehicle-portrait-close" type="button" aria-label="Retour"></button>
            <div class="vehicle-portrait-title" id="vehiclePortraitTitle"></div>
            <div class="vehicle-portrait-spacer"></div>
          </div>
          <div class="vehicle-portrait-content" id="vehiclePortraitContent"></div>
        </div>
    `;
    document.body.appendChild(view);

    qs(".vehicle-portrait-backdrop", view).onclick = closeVehiclePortrait;
    qs(".vehicle-portrait-close", view).onclick = closeVehiclePortrait;
    return view;
  }

  function pctFromStyle(el){
    const st = el ? (el.getAttribute("style") || "") : "";
    const m = st.match(/left\s*:\s*([0-9.]+)%/i);
    return m ? Math.max(0, Math.min(100, parseFloat(m[1]))) : 10;
  }

  function textOf(sel, root){
    const el = qs(sel, root);
    return el ? el.textContent.trim() : "";
  }

  function buildVerticalTimeline(card){
    const old = qs(".tcl-timeline-v3", card);
    if(!old) return `<div class="vehicle-portrait-empty">Timeline indisponible</div>`;

    const bus = qs(".tcl-timeline-v3-bus", old);
    const busPct = pctFromStyle(bus);
    const busClasses = bus ? bus.className : "";
    const busIcon = bus ? bus.textContent.trim() : "🚌";

    const stopData = qsa(".tcl-timeline-v3-stop", old).map(st => ({
      pct: pctFromStyle(st),
      name: textOf(".tcl-timeline-v3-name", st),
      cls: st.className
    }));

    const vStops = stopData.map(st => `
      <div class="${st.cls.replaceAll("tcl-timeline-v3", "vehicle-timeline-v")}" style="top:${st.pct}%;--pct:${st.pct}%">
        <div class="vehicle-timeline-v-dot"></div>
        <div class="vehicle-timeline-v-name">${st.name}</div>
      </div>
    `).join("");

    const term = old.classList.contains("terminus") ? "terminus" : "";
    const singleStop = stopData.length <= 1 ? "single-stop" : "";

    const nativeHorizontal = old.cloneNode(true);
    nativeHorizontal.classList.add("vehicle-timeline-native-h");
    nativeHorizontal.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));

    return `
      <div class="vehicle-timeline-v ${term} ${singleStop}">
        <div class="vehicle-timeline-v-rail"></div>
        <div class="${busClasses.replaceAll("tcl-timeline-v3", "vehicle-timeline-v")}" style="top:${busPct}%;--pct:${busPct}%">${busIcon}</div>
        ${vStops}
      </div>

      <div class="vehicle-timeline-native-wrap ${term}">
        ${nativeHorizontal.outerHTML}
      </div>
    `;
  }

  function renderVehiclePortraitFromCard(card){
    if(!card) return false;

    const view = ensureVehiclePortrait();
    const content = qs("#vehiclePortraitContent", view);

      const title = qs("#vehiclePortraitTitle", view);
      const vehicle = card.getAttribute("data-vehicle") || selectedVehicle || "";
    const line = selectedLine || window.currentLine || currentLine || "";
    const favKey = line + "|" + vehicle;
    const isFav = (typeof favVehicles !== "undefined") && favVehicles.has(favKey);
    const pill = textOf(".bus-pill", card).replace("☆","").replace("★","").trim();
    const dest = textOf(".dest", card);
    const stateEl = qs(".bus-state", card);
    const state = stateEl ? stateEl.innerHTML.trim() : "";
    let stateClass = stateEl ? stateEl.className : "bus-state";

    // V7 — vue portrait immersive : si le texte indique "À proximité",
    // on force immédiatement les classes vertes même si la carte source ne les a pas.
    const plainState = state.replace(/<[^>]*>/g, "").trim();
    const isFullProximityState = /^À proximité|^A proximité/i.test(plainState);
      const isPortraitApproachState = /En approche|À proximité|A proximité/i.test(plainState);

    if(isPortraitApproachState){
      if(!/\bproximity\b/.test(stateClass)) stateClass += " proximity";
      if(!/\bapproach\b/.test(stateClass)) stateClass += " approach";
      if(!/\bstate-approach\b/.test(stateClass)) stateClass += " state-approach";
    }

    const delay = textOf(".delay", card);
    const delayClass = qs(".delay", card)?.className || "delay heure";
    const stopCount = qsa(".tcl-timeline-v3-stop", card).length;
    const cleanDest = dest.replace(/^Direction\s+/i, "").trim();

    const portraitStateFlags = isPortraitApproachState
      ? " proximity approach state-approach"
      : "";

      let portraitStateHtml = state;
      if(isPortraitApproachState){
        const plain = plainState.replace(/\s+/g, " ").trim();
        const m = plain.match(/^(.*?)(\s+En approche)$/i);
        if(m){
          portraitStateHtml = `<span class="next-stop-badge">${m[1].trim()}</span><span class="approach-badge">En approche</span>`;
        }
      }

          if(title){
        const lineId = String(line || "").trim();
        let lineFavs = [];
        try { lineFavs = JSON.parse(localStorage.getItem("tcl_v7_line_favorites") || "[]"); } catch(e) { lineFavs = []; }
        const lineIsFav = lineFavs.includes(lineId);
        title.innerHTML = `<span>Ligne ${lineId}</span><button class="vehicle-portrait-title-fav ${lineIsFav ? "active" : ""}" type="button" data-line="${lineId}">${lineIsFav ? "★" : "☆"}</button>`;
      }

      content.innerHTML = `
      <div class="vehicle-portrait-head live-card vehicle-portrait-card${portraitStateFlags} ${isFav ? "vehicle-favorite" : ""}">
        <div class="vehicle-portrait-topline">
          <div class="bus-pill vehicle-portrait-pill">
            <span class="vehicle-portrait-pill-label">${pill || ("Véhicule " + vehicle)}</span>
            <button class="vehicle-fav-btn vehicle-portrait-fav ${isFav ? "active" : ""}" type="button" data-line="${line}" data-vehicle="${vehicle}">${isFav ? "★" : "☆"}</button>
          </div>
          <div class="${delayClass}">${delay || "À l’heure"}</div>
          <div class="dest">${dest}</div>
          ${state ? `<div class="${stateClass} vehicle-portrait-state" ${isPortraitApproachState ? 'style="background:rgba(186,230,253,.42)!important;border-color:rgba(56,189,248,.26)!important;box-shadow:none!important;"' : ""}>${portraitStateHtml}</div>` : ""}
        </div>
      </div>

      ${buildVerticalTimeline(card)}
    `;
    const favBtn = qs(".vehicle-portrait-fav", content);
    if(favBtn){
      favBtn.onclick = function(ev){
        ev.stopPropagation();
        if(typeof favVehicles === "undefined") return;
        const k = favBtn.dataset.line + "|" + favBtn.dataset.vehicle;
        if(favVehicles.has(k)) favVehicles.delete(k);
        else favVehicles.add(k);
        if(typeof saveFavs === "function") saveFavs();
        if(typeof applyVehicleFavorites === "function") applyVehicleFavorites();
        favBtn.classList.toggle("active", favVehicles.has(k));
        favBtn.textContent = favVehicles.has(k) ? "★" : "☆";
      };
    }

    view.classList.add("open");
    document.body.classList.add("vehicle-portrait-open");
    return true;
  }

  function openVehiclePortrait(card){
    if(!card) return;
    selectedVehicle = card.getAttribute("data-vehicle");
    selectedLine = window.currentLine || currentLine || selectedLine;
    renderVehiclePortraitFromCard(card);

    clearInterval(refreshTimer);
    refreshTimer = setInterval(syncVehiclePortrait, 1000);
  }

  function syncVehiclePortrait(){
    if(!selectedVehicle || !document.body.classList.contains("vehicle-portrait-open")) return;
    const card = qs(`.live-card[data-vehicle="${CSS.escape(selectedVehicle)}"]`);
    if(card) renderVehiclePortraitFromCard(card);
  }

  function closeVehiclePortrait(){
    // Guard anti-double-appel
    if(closeVehiclePortrait._closing) return;
    closeVehiclePortrait._closing = true;
    setTimeout(() => { closeVehiclePortrait._closing = false; }, 600);

    // Capture origin and line before any cleanup
    const origin = window.v7VehicleOrigin || null;
    const lineToRestore = (origin !== "search") ? (selectedLine || currentLine || null) : null;
    window.v7VehicleOrigin = null;
    selectedVehicle = null;
    selectedLine = null;

    try{
      if(refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
    }catch(e){}

    try{
      const view = document.querySelector("#vehiclePortraitView");
      if(view){
        view.classList.remove("open");
        view.style.display = "";
        view.style.visibility = "";
      }
      const backdrop = document.querySelector(".vehicle-portrait-backdrop");
      if(backdrop){
        backdrop.style.opacity = "";
        backdrop.style.pointerEvents = "";
      }
      // Clear any stale inline display:none on the inner panel to avoid backdrop-stuck bug
      const innerPanel = document.querySelector(".vehicle-portrait-panel");
      if(innerPanel) innerPanel.style.display = "";
    }catch(e){}

    try{
      document.body.classList.remove("vehicle-portrait-open");
      document.body.classList.remove("search-focus");
    }catch(e){}

    if(lineToRestore){
      // Return to line view (opened from a line card)
      try{
        document.body.classList.add("line-open");
        document.body.classList.remove("traffic-open");
        const lineView = document.querySelector("#lineView");
        if(lineView) lineView.classList.add("open");
        const trafficView = document.querySelector("#trafficView");
        if(trafficView) trafficView.classList.remove("open");
        const topbar = document.querySelector(".v7-topbar");
        if(topbar) topbar.style.display = "none";
        v7MapFocus(true);
        v7RefreshMapSize();
      }catch(e){}
    } else {
      // Return to home (opened from search or unknown origin)
      try{
        document.body.classList.remove("line-open");
        document.body.classList.remove("traffic-open");
      }catch(e){}

      try{
        currentLine = null;
        if(lineTimer) clearInterval(lineTimer);
        lineTimer = null;
      }catch(e){}

      try{
        const q = document.querySelector("#q");
        if(q){ q.value = ""; q.blur(); }
        const box = document.querySelector(".v7-search-suggest");
        if(box){ box.classList.remove("open"); box.innerHTML = ""; }
        const wrap = document.querySelector(".v7-search");
        if(wrap) wrap.classList.remove("has-value");
      }catch(e){}

      try{
        setViewMode("home");
      }catch(e){}

      try{
        renderTracking();
        loadTraffic();
      }catch(e){}

      try{
        setTimeout(function(){
          if(window.map) window.map.invalidateSize();
        }, 120);
      }catch(e){}
    }
  }

  document.addEventListener("click", function(e){
    if(e.target.closest(".vehicle-fav-btn")) return;
    const card = e.target.closest(".live-card[data-vehicle]");
    if(!card) return;
    if(!window.v7VehicleOrigin) window.v7VehicleOrigin = "line";
    openVehiclePortrait(card);
  }, true);

  document.addEventListener("keydown", function(e){
    if(e.key === "Escape") closeVehiclePortrait();
  });

  window.openVehiclePortrait = openVehiclePortrait;
  window.closeVehiclePortrait = closeVehiclePortrait;
})();
/* === V7 VEHICLE PORTRAIT VIEW END === */



/* === V7 — SPLIT BADGE PROCHAIN ARRÊT / EN APPROCHE === */
(function(){
  function splitApproachBadge(){
    document.querySelectorAll(".bus-state, .vehicle-portrait-state").forEach(function(el){
      const txt0 = (el.textContent || "").trim().toLowerCase();
      if(txt0.includes("arrivé au terminus") || txt0.includes("arrive au terminus") || txt0 === "terminus"){
        el.innerHTML = '<span class="next-stop-label">Terminus</span><span class="approach-label">Arrivé</span>';
        return;
      }
      if(!el || el.querySelector(".approach-badge")) return;

      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      const m = txt.match(/^(.*?)(\s+En approche)$/i);
      if(!m) return;

      const before = m[1].trim();
      el.innerHTML =
        '<span class="next-stop-badge">' + before + '</span>' +
        '<span class="approach-badge">En approche</span>';

      el.classList.add("approach", "state-approach");
    });
  }

  window.v7SplitApproachBadge = splitApproachBadge;
  document.addEventListener("DOMContentLoaded", splitApproachBadge);
  document.addEventListener("click", function(){ setTimeout(splitApproachBadge, 80); }, true);
})();





/* V7 search empty guard - added cleanly */
(function __v7EmptySearchGuard(){
    function clearResultsIfEmpty(input){
        if (!input || String(input.value || "").trim()) return;
        const box =
            document.querySelector(".search-results") ||
            document.querySelector("#searchResults") ||
            document.querySelector(".v7-search-results") ||
            document.querySelector("[data-search-results]");
        if (box) box.innerHTML = "";
    }

    document.addEventListener("focusin", function(e){
        const input = e.target;
        if (!input) return;
        const isSearch =
            input.matches && (
                input.matches("input[type='search']") ||
                input.matches(".search-input") ||
                input.matches("#searchInput") ||
                input.matches("[data-search-input]")
            );
        if (isSearch) clearResultsIfEmpty(input);
    });

    document.addEventListener("input", function(e){
        const input = e.target;
        if (!input) return;
        const isSearch =
            input.matches && (
                input.matches("input[type='search']") ||
                input.matches(".search-input") ||
                input.matches("#searchInput") ||
                input.matches("[data-search-input]")
            );
        if (isSearch) clearResultsIfEmpty(input);
    });
})();



function v7CloseVehiclePortraitSmart(){
    // Délègue à la fonction canonique pour éviter le bug fond flou bloqué
    if(typeof window.closeVehiclePortrait === "function"){
        window.closeVehiclePortrait();
    }
}




// bindV7VehiclePortraitBackOnce — neutralisé, closeVehiclePortrait gère l'origine
window.__v7VehiclePortraitBackBound = true;





/* === V7 IMMERSIVE RETURN HOME FORCE — SOURCE UNIQUE === */
document.addEventListener("click", function(e){
  const btn = e.target.closest(".vehicle-portrait-close");
  if(btn && typeof closeVehiclePortrait === "function"){
    e.preventDefault();
    e.stopPropagation();
    closeVehiclePortrait();
  }
}, true);




/* === V7 SEARCH SAFE CANCEL ONLY === */

/* V7 CLEAN: ancien GPS simple supprimé, GPS principal conservé. */


/* ================================================================
   FIN V7 — MODULE HORAIRES PREMIUM
================================================================ */

/* ================================================================
   V7 NOUVELLE ARCHITECTURE — SIDEBAR + SECTIONS
   2026-06-12
================================================================ */

(function(){
  "use strict";

  // ── état ────────────────────────────────────────────────────────
  let _activeSection = "home";

  // ── utils ────────────────────────────────────────────────────────
  function qs(sel, root){ return (root||document).querySelector(sel); }
  function qsa(sel, root){ return Array.from((root||document).querySelectorAll(sel)); }
  function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function spin(msg){ return `<div class="v7-section-loading"><div class="v7-section-spinner"></div><div>${esc(msg||"Chargement…")}</div></div>`; }

  // ── sidebar open/close ──────────────────────────────────────────
  function openSidebar(){
    document.body.classList.add("sidebar-open");
  }
  function closeSidebar(){
    document.body.classList.remove("sidebar-open");
  }
  function toggleSidebar(){
    document.body.classList.toggle("sidebar-open");
  }

  // ── nav item active ─────────────────────────────────────────────
  function setNavActive(section){
    qsa(".v7-nav-item").forEach(el => {
      el.classList.toggle("active", el.dataset.section === section);
    });
  }

  // ── fermer tous les panneaux de section ─────────────────────────
  const SECTION_STATES = ["lignes-open","autour-open","favoris-open","reglages-open"];
  const SECTION_VIEWS  = ["lignesView","autourView","favorisView","reglagensView"];

  function closeAllSectionPanels(){
    SECTION_STATES.forEach(s => document.body.classList.remove(s));
    SECTION_VIEWS.forEach(id => {
      const el = qs("#"+id);
      if(el) el.classList.remove("open");
    });
  }

  // ── router principal ─────────────────────────────────────────────
  function v7Navigate(section){
    _activeSection = section;
    setNavActive(section);

    if(typeof window.v7Itineraire?.close === "function") window.v7Itineraire.close(false);

    // Fermer la sidebar sur mobile
    if(window.innerWidth < 768) closeSidebar();

    // Fermer l'horaires si ouvert
    if(section !== "horaires" && typeof window.v7Horaires === "object"){
      // Fermer sans changer de mode si on navigue ailleurs
      document.body.classList.remove("horaires-open");
      const hv = qs("#horairesView");
      if(hv) hv.classList.remove("open");
    }

    // Fermer les panneaux existants
    if(section !== "lignes" && section !== "trafic"){
      if(typeof setViewMode === "function") {
        // Ne pas appeler home() si on ouvre une section qui gère son propre état
      }
    }
    closeAllSectionPanels();

    if(section !== "trafic"){
      document.body.classList.remove("traffic-open");
      qs("#trafficView")?.classList.remove("open");
    }
    if(section !== "home" && section !== "trafic"){
      document.body.classList.remove("line-open");
      qs("#lineView")?.classList.remove("open");
    }

    switch(section){
      case "home":
        if(typeof home === "function") home();
        else if(typeof setViewMode === "function") setViewMode("home");
        break;

      case "horaires":
        closeAllSectionPanels();
        document.body.classList.remove("line-open","traffic-open","lignes-open","favoris-open","reglages-open","autour-open","vehicle-portrait-open","sidebar-open");
        document.body.classList.add("horaires-open");

        if(typeof window.v7NearbyWidget === "object" && typeof window.v7NearbyWidget.close === "function") window.v7NearbyWidget.close();
        document.getElementById("horairesView")?.classList.add("open");

        setTimeout(() => {
          if(typeof window.v7Horaires === "object" && typeof window.v7Horaires.open === "function"){
            window.v7Horaires.open();
          }
        }, 30);
        break;

      case "lignes":
        _openLignes();
        break;

      case "autour":
        _openAutour();
        break;

      case "trafic":
        if(typeof setViewMode === "function") setViewMode("traffic");
        // Mettre à jour le titre
        const tTitle = qs("#trafficTitle");
        if(tTitle) tTitle.textContent = "Info trafic";
        if(typeof loadTraffic === "function") loadTraffic();
        break;

      case "favoris":
        _openFavoris();
        break;

      case "reglages":
        _openReglages();
        break;
    }
  }

  // ── panel helper ────────────────────────────────────────────────
  function _openPanel(id, stateClass){
    // Masquer les autres panels existants
    if(typeof setViewMode === "function"){
      document.body.classList.remove("line-open","traffic-open");
      qs("#lineView")?.classList.remove("open");
      qs("#trafficView")?.classList.remove("open");
    }
    document.body.classList.add(stateClass);
    const el = qs("#"+id);
    if(el) el.classList.add("open");
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION : LIGNES
  // ═══════════════════════════════════════════════════════════════

  const LINE_CATEGORIES = [
    { id:"metro",   label:"Métro",          color:"#1d4ed8", patterns:[/^[ABCD]$/i] },
    { id:"tram",    label:"Tramway",        color:"#7c3aed", patterns:[/^T\d+$/i] },
    { id:"funi",    label:"Funiculaire",    color:"#0891b2", patterns:[/^F\d+$/i] },
    { id:"chrono",  label:"Lignes fortes",  color:"#ea580c", patterns:[/^C\d+$/i] },
    { id:"bus",     label:"Bus",            color:"#16a34a", patterns:[/.+/] },
  ];

  function _lineCategory(short){
    for(const cat of LINE_CATEGORIES){
      if(cat.patterns.some(p => p.test(short))) return cat;
    }
    return LINE_CATEGORIES[LINE_CATEGORIES.length-1];
  }

  async function _openLignes(){
    _openPanel("lignesView","lignes-open");
    const content = qs("#lignesContent");
    if(!content) return;
    content.innerHTML = `
      <div class="v7-lignes-search">
        <input id="v7LignesSearchInput" type="search" placeholder="Rechercher une ligne" autocomplete="off">
      </div>
      <div class="v7-section-loading" id="v7LignesLoader">
        <div class="v7-section-spinner"></div>
        <div>Chargement des lignes…</div>
      </div>
    `;

    // Bind search
    const searchInput = qs("#v7LignesSearchInput",content);
    if(searchInput){
      searchInput.addEventListener("input", () => _filterLignes(searchInput.value, liveCounts));
    }

    // Lignes live actives (depuis buses[])
    const liveCounts = {};
    try {
      (window.buses||[]).forEach(b => {
        const l = String(b.line||"").trim().toUpperCase();
        if(l) liveCounts[l] = (liveCounts[l]||0)+1;
      });
    } catch(e){}

    // Lignes GTFS
    try {
      const data = await fetch("/api/horaires/lignes").then(r=>r.json());
      const all = data.lignes||[];
      _renderLignesAll(content, all, liveCounts);
    } catch(e){
      const loader = qs("#v7LignesLoader", content);
      if(loader) loader.remove();
      if(content) content.innerHTML += `<div class="v7-lignes-empty">Erreur de chargement</div>`;
    }
  }

  let _allLignesData = [];

  function _renderLignesAll(content, lignes, liveCounts){
    _allLignesData = lignes;
    const searchInput = qs("#v7LignesSearchInput",content);
    const filtered = _filterLignesData(lignes, searchInput?.value||"");
    _renderLignesFiltered(content, filtered, liveCounts);
  }

  function _filterLignesData(lignes, q){
    if(!q||!q.trim()) return lignes;
    const n = q.trim().toUpperCase().replace(/\s+/g,"");
    return lignes.filter(l =>
      String(l.short||"").toUpperCase().includes(n) ||
      String(l.long||"").toUpperCase().includes(n)
    );
  }

  function _filterLignes(q, liveCounts){
    const content = qs("#lignesContent");
    if(!content) return;
    const filtered = _filterLignesData(_allLignesData, q);
    _renderLignesFiltered(content, filtered, liveCounts);
  }

  function _renderLignesFiltered(content, lignes, liveCounts){
    const loader = qs("#v7LignesLoader", content);
    if(loader) loader.remove();

    // Garder la barre de recherche
    const searchBar = qs(".v7-lignes-search", content);
    if(!lignes.length){
      const old = qs(".v7-lignes-body", content);
      if(old) old.remove();
      const empty = document.createElement("div");
      empty.className = "v7-lignes-body";
      empty.innerHTML = `<div class="v7-lignes-empty">Aucune ligne trouvée</div>`;
      content.appendChild(empty);
      return;
    }

    // Grouper par catégorie
    const bycat = {};
    lignes.forEach(l => {
      const cat = _lineCategory(l.short);
      bycat[cat.id] = bycat[cat.id]||{cat,lines:[]};
      bycat[cat.id].lines.push(l);
    });

    let html = "<div class=\"v7-lignes-body\">";
    LINE_CATEGORIES.forEach(cat => {
      const group = bycat[cat.id];
      if(!group) return;
      html += `<div class="v7-lignes-category">
        <div class="v7-lignes-category-title">${esc(cat.label)}</div>
        <div class="v7-lignes-grid">`;
      group.lines.forEach(l => {
        const count = liveCounts[l.short?.toUpperCase()] || 0;
        const isLive = count > 0;
        html += `<button class="v7-ligne-pill${isLive?" live":""}" type="button"
          data-line="${esc(l.id)}" data-short="${esc(l.short)}">
          <span class="v7-ligne-pill-badge" style="background:${esc(l.color)};color:${esc(l.text_color||"#fff")}">${esc(l.short)}</span>
          <span class="v7-ligne-pill-count">${isLive ? count+" 🔴" : "—"}</span>
        </button>`;
      });
      html += `</div></div>`;
    });
    html += "</div>";

    const old = qs(".v7-lignes-body", content);
    if(old) old.remove();
    const div = document.createElement("div");
    div.innerHTML = html;
    content.appendChild(div.firstChild);

    // Bind clicks
    qsa(".v7-ligne-pill", content).forEach(btn => {
      btn.onclick = () => {
        const line = btn.dataset.short || btn.dataset.line;
        if(typeof openLine === "function") openLine(line, true);
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION : AUTOUR DE MOI
  // ═══════════════════════════════════════════════════════════════

  async function _openAutour(){
    _openPanel("autourView","autour-open");
    const content = qs("#autourContent");
    if(!content) return;
    content.innerHTML = `
      <div class="v7-autour-header">
        <div class="v7-autour-gps-badge">📡</div>
        <div class="v7-autour-gps-info">
          <b>Arrêts autour de moi</b>
          <small>Localisation en cours…</small>
        </div>
      </div>
      ${spin("Localisation GPS…")}
    `;

    if(!navigator.geolocation){
      content.innerHTML += `<div class="v7-section-loading">⚠️ Géolocalisation non disponible</div>`;
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async pos => {
        const lat = pos.coords.lat || pos.coords.latitude;
        const lon = pos.coords.lon || pos.coords.longitude;
        const acc = Math.round(pos.coords.accuracy||0);
        const info = qs(".v7-autour-gps-info small", content);
        if(info) info.textContent = `Précision : ${acc} m`;

        content.innerHTML = `
          <div class="v7-autour-header">
            <div class="v7-autour-gps-badge">📡</div>
            <div class="v7-autour-gps-info">
              <b>Autour de moi</b>
              <small>Précision : ${acc} m · Rayon 700 m</small>
            </div>
          </div>
          ${spin("Recherche des arrêts…")}
        `;

        try {
          const data = await fetch(`/api/horaires/proche?lat=${lat}&lon=${lon}&radius=700`).then(r=>r.json());
          _renderAutourStops(content, data.arrets||[], lat, lon, acc);
        } catch(e){
          content.innerHTML += `<div class="v7-section-loading">⚠️ Erreur réseau</div>`;
        }
      },
      err => {
        content.innerHTML = `<div class="v7-autour-header">
          <div class="v7-autour-gps-badge">📡</div>
          <div class="v7-autour-gps-info"><b>Autour de moi</b><small>Position GPS indisponible</small></div>
        </div>
        <div class="v7-section-loading">⚠️ Impossible d'obtenir la position GPS.<br>Vérifiez les autorisations de localisation.</div>`;
      },
      {enableHighAccuracy:true, timeout:12000, maximumAge:5000}
    );
  }

  function _renderAutourStops(content, stops, lat, lon, acc){
    const header = `<div class="v7-autour-header">
      <div class="v7-autour-gps-badge">📡</div>
      <div class="v7-autour-gps-info">
        <b>Autour de moi</b>
        <small>Précision : ${acc} m · ${stops.length} arrêt${stops.length>1?"s":""} dans 700 m</small>
      </div>
    </div>`;

    if(!stops.length){
      content.innerHTML = header + `<div class="v7-section-loading">Aucun arrêt dans un rayon de 700 m</div>`;
      return;
    }

    let html = header + `<div class="v7-autour-stop-list">`;
    stops.forEach(st => {
      const chips = (st.lines||[]).slice(0,5).map(l =>
        `<span class="v7-autour-line-chip" style="background:${esc(l.color)};color:#fff">${esc(l.short)}</span>`
      ).join("");
      html += `<button class="v7-autour-stop" type="button"
        data-id="${esc(st.id)}" data-name="${esc(st.name)}">
        <span class="v7-autour-stop-icon">📍</span>
        <span class="v7-autour-stop-info">
          <strong>${esc(st.name)}</strong>
          <small>${chips}</small>
        </span>
        <span class="v7-autour-stop-dist">${esc(st.distance)} m</span>
      </button>`;
    });
    html += `</div>`;
    content.innerHTML = html;

    qsa(".v7-autour-stop", content).forEach(btn => {
      btn.onclick = () => {
        if(typeof window.v7Horaires === "object"){
          window.v7Horaires.openArret(btn.dataset.id, btn.dataset.name);
        }
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION : FAVORIS
  // ═══════════════════════════════════════════════════════════════

  function _openFavoris(){
    _openPanel("favorisView","favoris-open");
    const content = qs("#favorisContent");
    if(!content) return;
    _renderFavoris(content);
  }

  function _renderFavoris(content){
    let html = "";

    // Lignes favorites
    const lineFavs = typeof v7ReadLineFavs === "function" ? [...v7ReadLineFavs()] : [];
    html += `<div class="v7-favoris-group">
      <div class="v7-favoris-group-title">Lignes favorites</div>`;
    if(lineFavs.length){
      // Fetch couleurs depuis l'API si possible, sinon fallback
      lineFavs.forEach(line => {
        html += `<button class="v7-fav-row" type="button" data-type="ligne" data-line="${esc(line)}">
          <span class="v7-fav-badge" style="background:rgba(56,189,248,.18);color:#38bdf8;border-radius:10px;min-width:44px;height:34px">${esc(line)}</span>
          <span class="v7-fav-info">
            <strong>Ligne ${esc(line)}</strong>
            <small>Suivi temps réel</small>
          </span>
          <span style="color:var(--muted);font-size:14px">›</span>
        </button>`;
      });
    } else {
      html += `<div class="v7-fav-empty">Aucune ligne favorite — étoilez ★ une ligne pour l'ajouter</div>`;
    }
    html += `</div>`;

    // Véhicules favoris (du jour)
    let vehicleFavs = [];
    try {
      if(typeof favVehicles !== "undefined"){
        vehicleFavs = [...favVehicles];
      }
    } catch(e){}

    html += `<div class="v7-favoris-group">
      <div class="v7-favoris-group-title">Véhicules favoris (aujourd'hui)</div>`;
    if(vehicleFavs.length){
      vehicleFavs.slice(0,8).forEach(vk => {
        const parts = vk.split("|");
        const line = parts[0]||"?";
        const veh = parts[1]||"?";
        html += `<button class="v7-fav-row" type="button" data-type="vehicle" data-line="${esc(line)}" data-vehicle="${esc(veh)}">
          <span class="v7-fav-badge" style="background:rgba(251,146,60,.15);color:#fb923c;border-radius:10px;min-width:44px;height:34px;font-size:18px">🚌</span>
          <span class="v7-fav-info">
            <strong>Bus ${esc(veh)}</strong>
            <small>Ligne ${esc(line)}</small>
          </span>
          <span style="color:var(--muted);font-size:14px">›</span>
        </button>`;
      });
    } else {
      html += `<div class="v7-fav-empty">Aucun véhicule favori aujourd'hui — étoilez ★ un bus depuis sa fiche</div>`;
    }
    html += `</div>`;

    content.innerHTML = html;

    qsa(".v7-fav-row[data-type='ligne']", content).forEach(btn => {
      btn.onclick = () => {
        if(typeof openLine === "function") openLine(btn.dataset.line, true);
      };
    });
    qsa(".v7-fav-row[data-type='vehicle']", content).forEach(btn => {
      btn.onclick = () => {
        if(typeof openLine === "function") openLine(btn.dataset.line, true);
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION : RÉGLAGES
  // ═══════════════════════════════════════════════════════════════

  function _openReglages(){
    _openPanel("reglagensView","reglages-open");
    const content = qs("#reglagensContent");
    if(!content) return;
    _renderReglages(content);
  }

  function _renderReglages(content){
    const isLight = window.matchMedia("(prefers-color-scheme:light)").matches;

    content.innerHTML = `
      <div class="v7-reglages-section">
        <div class="v7-reglages-section-title">Affichage</div>
        <div class="v7-reglage-row" id="v7ReglageTheme">
          <span class="v7-reglage-icon">${isLight?"☀️":"🌙"}</span>
          <span class="v7-reglage-info">
            <strong>Thème</strong>
            <small>Actuellement : ${isLight?"Mode clair (système)":"Mode sombre (système)"}</small>
          </span>
          <span class="v7-reglage-action">Système</span>
        </div>
        <div class="v7-reglage-row" id="v7ReglageMap">
          <span class="v7-reglage-icon">🗺️</span>
          <span class="v7-reglage-info">
            <strong>Fond de carte</strong>
            <small>Changement automatique selon thème</small>
          </span>
          <span class="v7-reglage-action">Auto</span>
        </div>
      </div>

      <div class="v7-reglages-section">
        <div class="v7-reglages-section-title">Données</div>
        <div class="v7-reglage-row" id="v7ReglageRefresh">
          <span class="v7-reglage-icon">🔄</span>
          <span class="v7-reglage-info">
            <strong>Actualisation</strong>
            <small>Temps réel toutes les 5 secondes</small>
          </span>
          <span class="v7-reglage-action">5 s</span>
        </div>
        <div class="v7-reglage-row" id="v7ReglageCache">
          <span class="v7-reglage-icon">🗑️</span>
          <span class="v7-reglage-info">
            <strong>Vider le cache</strong>
            <small>Recharge toutes les données</small>
          </span>
          <span class="v7-reglage-action">Vider</span>
        </div>
        <div class="v7-reglage-row danger" id="v7ReglageReset">
          <span class="v7-reglage-icon">⚠️</span>
          <span class="v7-reglage-info">
            <strong>Réinitialiser les favoris</strong>
            <small>Supprime tous les favoris lignes et véhicules</small>
          </span>
          <span class="v7-reglage-action">Réinitialiser</span>
        </div>
      </div>

      <div class="v7-reglages-section">
        <div class="v7-reglages-section-title">À propos</div>
        <div class="v7-reglage-row">
          <span class="v7-reglage-icon">ℹ️</span>
          <span class="v7-reglage-info">
            <strong>TCL Temps Réel</strong>
            <small>Version 7 · Données GTFS TCL · Bus Tracker</small>
          </span>
        </div>
      </div>

      <div class="v7-reglages-version">Propulsé par les données ouvertes TCL</div>
    `;

    qs("#v7ReglageCache",content)?.addEventListener("click", () => {
      location.href = "/kill-cache";
    });
    qs("#v7ReglageReset",content)?.addEventListener("click", () => {
      if(confirm("Supprimer tous les favoris ?")) {
        localStorage.clear();
        location.reload();
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // BADGES DE NAVIGATION
  // ═══════════════════════════════════════════════════════════════

  function _updateNavBadges(){
    // Badge trafic — nombre d'alertes
    try {
      const alerts = window.v7TrafficAlerts||[];
      const badge = qs("#v7NavBadgeTrafic");
      if(badge){
        const count = alerts.length;
        badge.textContent = count > 0 ? String(count) : "";
      }
    } catch(e){}

    // Badge autour — si GPS disponible
    try {
      const badge = qs("#v7NavBadgeAutour");
      if(badge && window.__v7GpsRaw?.t){
        const age = Date.now() - window.__v7GpsRaw.t;
        badge.textContent = age < 15000 ? "GPS" : "";
      }
    } catch(e){}
  }

  // ═══════════════════════════════════════════════════════════════
  // INITIALISATION
  // ═══════════════════════════════════════════════════════════════

  document.addEventListener("DOMContentLoaded", function(){

    // Hamburger
    const hamburger = qs("#v7Hamburger");
    if(hamburger) hamburger.onclick = toggleSidebar;

    // Overlay sidebar
    const overlay = qs("#v7SidebarOverlay");
    if(overlay) overlay.onclick = closeSidebar;

    // Close button sidebar
    const closeBtn = qs("#v7SidebarClose");
    if(closeBtn) closeBtn.onclick = closeSidebar;

    // Nav items
    qsa(".v7-nav-item").forEach(item => {
      item.onclick = () => v7Navigate(item.dataset.section);
    });

    // Overlay scrim derrière les section sheets (tap pour fermer)
    const sheetOverlay = qs("#v7SheetOverlay");
    if(sheetOverlay) sheetOverlay.onclick = () => {
      closeAllSectionPanels();
      if(typeof setViewMode === "function") setViewMode("home");
      else if(typeof home === "function") home();
      setNavActive("home");
      _activeSection = "home";
    };

    // Back buttons pour nouvelles sections
    ["lignesBack","autourBack","favorisBack","reglagensBack"].forEach(id => {
      const btn = qs("#"+id);
      if(btn) btn.onclick = () => {
        closeAllSectionPanels();
        if(typeof setViewMode === "function") setViewMode("home");
        else if(typeof home === "function") home();
        setNavActive("home");
        _activeSection = "home";
      };
    });

    // Badge refresh
    setInterval(_updateNavBadges, 6000);
    setTimeout(_updateNavBadges, 2000);

    // Cacher le bouton horaires standalone (sidebar gère)
    const horBtn = qs("#v7HorairesBtn");
    if(horBtn) horBtn.style.display = "none";

    // Sur desktop, sidebar toujours visible → aucune action d'ouverture
    // Sur mobile, fermer sidebar si on navigue via setViewMode (ligne, trafic…)
    const _origSetVM = typeof setViewMode === "function" ? setViewMode : null;
    if(_origSetVM && typeof setViewMode === "function"){
      const prev = window.setViewMode;
      window.setViewMode = function(mode){
        if(mode !== "home") {
          // Fermer sections sidebar si on passe en mode ligne/trafic via JS existant
          closeAllSectionPanels();
        }
        prev(mode);
      };
    }

  });

  // Exposer
  window.v7Sidebar = {
    open: openSidebar,
    close: closeSidebar,
    navigate: v7Navigate,
  };

})();

/* ================================================================
   FIN V7 NOUVELLE ARCHITECTURE
================================================================ */

/* =========================================================
   V7 NEARBY - WIDGET BINAIRE
   0 = ferme, 1 = ouvert avec prochains passages.
========================================================= */
(function(){
  const card = document.getElementById("v7HomeNearbyCard");
  const meta = document.getElementById("v7HomeNearbyMeta");
  const list = document.getElementById("v7HomeNearbyList");
  const closeBtn = document.getElementById("v7HomeNearbyClose");
  const allBtn = document.getElementById("v7HomeNearbyAll");
  const title = card?.querySelector("h2");

  if(!card || !meta || !list || !title) return;

  const KEY = "tcl_v7_home_nearby_collapsed";
  const HORAIRES_REFRESH_MS = 30000;
  let widgetOpen = false;
  let lastStops = [];
  let lastPos = null;
  let lastFetchLat = null;
  let lastFetchLon = null;
  let lastFetchAt = 0;
  let fetching = false;
  let watchId = null;
  let horairesTimer = null;

  const esc = v => String(v ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[m]));

  const stopLabel = st => st?.name || st?.nom || st?.stop_name || st?.label || "Arrêt proche";

  function minuteLabel(minutes){
    const n = Number(minutes);
    if(!Number.isFinite(n)) return "--";
    if(n <= 0) return "À l'approche";
    return `${n} min`;
  }

  function distMeters(a,b,c,d){
    const R = 6371000, toRad = x => x * Math.PI / 180;
    const dLat = toRad(c-a), dLon = toRad(d-b);
    const lat1 = toRad(a), lat2 = toRad(c);
    const x = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x)));
  }

  function shouldRefresh(lat, lon){
    if(lastFetchLat === null || lastFetchLon === null) return true;
    if(distMeters(lastFetchLat, lastFetchLon, lat, lon) >= 25) return true;
    if(Date.now() - lastFetchAt > 15000) return true;
    return false;
  }

  function syncTitle(){
    title.textContent = lastStops[0] ? stopLabel(lastStops[0]) : "Autour de vous";
  }

  function clearHorairesTimer(){
    if(horairesTimer){
      clearInterval(horairesTimer);
      horairesTimer = null;
    }
  }

  function startHorairesTimer(){
    clearHorairesTimer();
    horairesTimer = setInterval(() => {
      if(widgetOpen) renderNearbyHoraires(false);
    }, HORAIRES_REFRESH_MS);
  }

  function setWidgetOpen(open){
    widgetOpen = Boolean(open);
    card.classList.toggle("is-collapsed", !widgetOpen);
    card.classList.toggle("is-open", widgetOpen);
    syncTitle();

    if(widgetOpen){
      renderNearbyHoraires(true);
      startHorairesTimer();
    }else{
      clearHorairesTimer();
    }

    try{ localStorage.setItem(KEY, widgetOpen ? "0" : "1"); }catch(e){}
  }

  function closeOtherViews(){
    document.body.classList.remove("line-open","traffic-open","horaires-open","lignes-open","favoris-open","reglages-open","vehicle-portrait-open");
    ["lineView","trafficView","horairesView","lignesView","favorisView","reglagensView","vehiclePortraitView"]
      .forEach(id => document.getElementById(id)?.classList.remove("open"));
  }

  function renderAutourPanel(stops, pos){
    const view = document.getElementById("autourView");
    const content = document.getElementById("autourContent");
    if(!view || !content) return;

    closeOtherViews();
    document.body.classList.add("autour-open");
    view.classList.add("open");

    const firstName = stops[0] ? stopLabel(stops[0]) : "Arrêts proches";
    const acc = pos?.coords?.accuracy ? Math.round(pos.coords.accuracy) : "?";
    const panelTitle = view.querySelector(".v7-detail-head h2");
    if(panelTitle) panelTitle.textContent = firstName;

    let html = `
      <div class="v7-autour-header">
        <div class="v7-autour-gps-badge">📍</div>
        <div class="v7-autour-gps-info">
          <b>${esc(firstName)}</b>
          <small>Précision : ${esc(acc)} m · ${stops.length} arrêt${stops.length>1?"s":""} dans 700 m</small>
        </div>
      </div>
    `;

    if(!stops.length){
      content.innerHTML = html + `<div class="v7-lines-empty">Aucun arrêt proche détecté.</div>`;
      return;
    }

    html += `<div class="v7-autour-stop-list">`;
    stops.slice(0,5).forEach(st => {
      const lines = (st.lines || []).slice(0,6).map(l =>
        `<span class="v7-autour-line-chip" style="background:${esc(l.color || "#E5282B")};color:#fff">${esc(l.short || l)}</span>`
      ).join("");

      html += `
        <button class="v7-autour-stop" type="button" data-stop-id="${esc(st.id || "")}">
          <span class="v7-autour-stop-icon">📍</span>
          <span class="v7-autour-stop-info">
            <b>${esc(stopLabel(st))}</b>
            <small>${lines || "Arrêt TCL"}</small>
          </span>
          <span class="v7-autour-stop-dist">${esc(st.distance ?? "?")} m</span>
        </button>
      `;
    });
    html += `</div>`;
    content.innerHTML = html;
  }

  async function fetchNearby(lat, lon){
    const r = await fetch(`/api/horaires/proche?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radius=700&t=${Date.now()}`);
    const data = await r.json();
    return data.arrets || data.stops || data.items || [];
  }

  function setLoadingHoraires(){
    meta.textContent = "Chargement des horaires...";
    list.innerHTML = `<div class="v7-home-nearby-loading">Chargement des horaires...</div>`;
  }

  function passageRows(data){
    const rows = [];
    (data?.passages || []).forEach(group => {
      (group.passages || []).forEach(p => {
        rows.push({
          line: group.line || "?",
          color: group.line_color || "#E5282B",
          textColor: group.line_text_color || "#fff",
          destination: group.headsign || "Direction non précisée",
          wait: minuteLabel(p.minutes),
          time: p.time || "",
          source: p.source || "theorique",
          sort: Number.isFinite(Number(p.minutes)) ? Number(p.minutes) : 9999
        });
      });
    });
    return rows.sort((a,b) => a.sort - b.sort).slice(0, 12);
  }

  async function renderNearbyHoraires(showLoading=true){
    const st = lastStops[0];
    if(!st){
      syncTitle();
      if(fetching || !lastFetchAt){
        setLoadingHoraires();
      }else{
        meta.textContent = "Aucun arrêt proche détecté";
        list.innerHTML = `<div class="v7-home-nearby-loading">Aucun arrêt proche.</div>`;
      }
      return;
    }

    const stopId = st.id || st.stop_id || st.code || "";
    const name = stopLabel(st);
    title.textContent = name;
    meta.textContent = `${st.distance ?? "?"} m · prochains passages`;

    if(!stopId){
      list.innerHTML = `<div class="v7-home-nearby-loading">Aucun horaire disponible pour ${esc(name)}.</div>`;
      return;
    }

    if(showLoading) setLoadingHoraires();

    try{
      const r = await fetch(`/api/horaires/arret/${encodeURIComponent(stopId)}/prochains?t=${Date.now()}`);
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if(data?.ok === false) throw new Error(data.error || "Horaires indisponibles");
      const rows = passageRows(data);

      if(!rows.length){
        meta.textContent = `${st.distance ?? "?"} m · aucun passage disponible`;
        list.innerHTML = `<div class="v7-home-nearby-loading">Aucun horaire disponible pour ${esc(name)}.</div>`;
        return;
      }

      meta.textContent = `${st.distance ?? "?"} m · prochains passages`;
      list.innerHTML = `
        <div class="v7-nearby-full-times">
          ${rows.map(row => `
            <div class="v7-nearby-time-row">
              <b style="background:${esc(row.color)};color:${esc(row.textColor)}">${esc(row.line)}</b>
              <span>${esc(row.destination)}${row.time ? ` · ${esc(row.time)}` : ""}<em>${row.source === "reel" ? "temps réel" : "théorique"}</em></span>
              <strong>${esc(row.wait)}</strong>
            </div>
          `).join("")}
        </div>
      `;
    }catch(e){
      list.innerHTML = `<div class="v7-home-nearby-loading">Horaires indisponibles.</div>`;
    }
  }

  async function updateFromPosition(pos, force=false){
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    lastPos = pos;

    if(fetching) return;
    if(!force && !shouldRefresh(lat, lon)) return;

    fetching = true;
    try{
      lastFetchLat = lat;
      lastFetchLon = lon;
      lastFetchAt = Date.now();
      lastStops = await fetchNearby(lat, lon);
      syncTitle();
      if(widgetOpen) renderNearbyHoraires(true);
      if(document.body.classList.contains("autour-open")) renderAutourPanel(lastStops, lastPos);
    }catch(e){
      meta.textContent = "Arrêts proches indisponibles";
      if(widgetOpen) list.innerHTML = `<div class="v7-home-nearby-loading">Impossible de charger les arrêts proches.</div>`;
    }finally{
      fetching = false;
    }
  }

  function startRealtime(){
    meta.textContent = "Recherche des arrêts proches...";
    list.innerHTML = `<div class="v7-home-nearby-loading">Localisation en cours...</div>`;

    if(!navigator.geolocation){
      meta.textContent = "GPS indisponible";
      return;
    }

    if(watchId !== null){
      try{ navigator.geolocation.clearWatch(watchId); }catch(e){}
    }

    watchId = navigator.geolocation.watchPosition(
      pos => updateFromPosition(pos, false),
      () => {
        meta.textContent = "Localisation refusée";
        if(widgetOpen) list.innerHTML = `<div class="v7-home-nearby-loading">Activez la localisation pour voir les arrêts proches.</div>`;
      },
      {enableHighAccuracy:true, timeout:12000, maximumAge:5000}
    );

    navigator.geolocation.getCurrentPosition(
      pos => updateFromPosition(pos, true),
      () => {},
      {enableHighAccuracy:true, timeout:10000, maximumAge:0}
    );
  }

  if(closeBtn) closeBtn.remove();
  if(allBtn) allBtn.remove();
  card.onclick = null;

  let handle = card.querySelector(".v7-nearby-handle");
  if(!handle){
    handle = document.createElement("button");
    handle.type = "button";
    handle.className = "v7-nearby-handle";
    card.prepend(handle);
  }
  handle.setAttribute("aria-label", "Ouvrir ou fermer les horaires proches");

  ["click","touchend"].forEach(evt => {
    handle.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      setWidgetOpen(!widgetOpen);
    }, {passive:false});
  });

  card.addEventListener("click", e => {
    if(widgetOpen) return;
    if(e.target.closest(".v7-nearby-handle")) return;
    setWidgetOpen(true);
  });

  window.v7NearbyWidget = {
    open: () => setWidgetOpen(true),
    close: () => setWidgetOpen(false),
    toggle: () => setWidgetOpen(!widgetOpen),
    isOpen: () => widgetOpen
  };

  try{ localStorage.setItem(KEY, "1"); }catch(e){}
  setWidgetOpen(false);
  startRealtime();

  setTimeout(() => {
    if(!document.body.classList.contains("autour-open")) setWidgetOpen(false);
  }, 90);
})();



/* =========================================================
   V7 HORAIRES - PAGE GUIDEE
   Source unique pour l'onglet Horaires.
========================================================= */
(function(){
  // Horaires correction: keep the premium flow module below as active source.
  // This guided implementation is left dormant as fallback only.
  return;
  "use strict";

  const REFRESH_MS = 30000;
  const NEARBY_RADIUS = 700;
  const MAX_NEARBY = 3;

  const state = {
    lines: [],
    lineQuery: "",
    selectedLine: null,
    selectedLineData: null,
    selectedDirectionIndex: null,
    selectedStop: null,
    selectedStopMode: "guided",
    nearbyPosition: null,
    nearbyStops: [],
    nearbyTimer: null,
    passagesTimer: null,
    linesLoaded: false,
    nearbyStarted: false
  };

  function qs(sel, root){ return (root || document).querySelector(sel); }
  function esc(value){
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function norm(value){
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }
  function clampColor(value, fallback){
    const v = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  }
  function minuteLabel(minutes){
    const n = Number(minutes);
    if(!Number.isFinite(n)) return "--";
    if(n <= 0) return "À l'approche";
    return `${n} min`;
  }
  function endpoint(path){ return `${path}${path.includes("?") ? "&" : "?"}t=${Date.now()}`; }
  async function fetchJson(path){
    const response = await fetch(endpoint(path), { cache: "no-store" });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if(data && data.ok === false) throw new Error(data.error || "API Horaires indisponible");
    return data;
  }
  function clearTimers(){
    if(state.nearbyTimer){ clearInterval(state.nearbyTimer); state.nearbyTimer = null; }
    if(state.passagesTimer){ clearInterval(state.passagesTimer); state.passagesTimer = null; }
  }
  function isOpen(){ return document.body.classList.contains("horaires-open") && qs("#horairesView")?.classList.contains("open"); }
  function skeletonRows(count){ return Array.from({length: count}, () => '<div class="hor-skeleton-row"></div>').join(""); }
  function cleanLegacySurfaces(){
    ["#horairesFicheLigne", "#horairesFicheArret", "#horairesProchains", "#horairesSearchResults"].forEach(sel => {
      const el = qs(sel);
      if(el){ el.hidden = true; el.innerHTML = ""; }
    });
  }

  function openHorairesPanel(){
    document.body.classList.remove("line-open", "traffic-open", "lignes-open", "favoris-open", "reglages-open", "autour-open", "vehicle-portrait-open");
    document.body.classList.add("horaires-open");
    qs("#horairesView")?.classList.add("open");
    cleanLegacySurfaces();
  }

  function closeHorairesPanel(){
    document.body.classList.remove("horaires-open");
    qs("#horairesView")?.classList.remove("open");
    clearTimers();
  }

  function resetGuidedState(){
    state.lineQuery = "";
    state.selectedLine = null;
    state.selectedLineData = null;
    state.selectedDirectionIndex = null;
    state.selectedStop = null;
    state.selectedStopMode = "guided";
    const input = qs("#horairesSearchInput");
    if(input) input.value = "";
    renderLines();
    renderDirections();
    renderStops();
    renderPassagesIdle();
  }

  function showHome(){
    cleanLegacySurfaces();
    const home = qs("#horairesHome");
    if(home) home.hidden = false;
    resetGuidedState();
    loadLines();
    startNearbyAuto();
  }

  function openHoraires(){ openHorairesPanel(); showHome(); }

  async function loadLines(){
    const box = qs("#horairesLinePills");
    if(!box) return;
    if(state.linesLoaded && state.lines.length){ renderLines(); return; }
    box.innerHTML = skeletonRows(4);
    try{
      const data = await fetchJson("/api/horaires/lignes");
      state.lines = Array.isArray(data.lignes) ? data.lignes : [];
      state.linesLoaded = true;
      renderLines();
    }catch(error){ box.innerHTML = `<div class="hor-empty">Impossible de charger les lignes pour le moment.</div>`; }
  }

  function visibleLines(){
    const needle = norm(state.lineQuery);
    let lines = state.lines;
    if(needle){ lines = lines.filter(line => norm(line.short).includes(needle) || norm(line.long).includes(needle)); }
    return lines.slice(0, needle ? 48 : 36);
  }

  function renderLines(){
    const box = qs("#horairesLinePills");
    if(!box) return;
    if(!state.linesLoaded){ box.innerHTML = skeletonRows(4); return; }
    const lines = visibleLines();
    if(!lines.length){ box.innerHTML = `<div class="hor-empty">Aucune ligne trouvée.</div>`; return; }
    box.innerHTML = lines.map(line => {
      const active = state.selectedLine && state.selectedLine.id === line.id;
      const bg = clampColor(line.color, "#0ea5e9");
      const fg = clampColor(line.text_color, "#ffffff");
      return `<button class="hor-line-pill${active ? " is-active" : ""}" type="button" data-line-id="${esc(line.id)}" style="--line-bg:${esc(bg)};--line-fg:${esc(fg)}">
        <span>${esc(line.short)}</span>
        <small>${esc(line.type_label || "Ligne")}</small>
      </button>`;
    }).join("");
  }

  async function selectLine(lineId){
    const line = state.lines.find(item => String(item.id) === String(lineId));
    if(!line) return;
    state.selectedLine = line;
    state.selectedLineData = null;
    state.selectedDirectionIndex = null;
    state.selectedStop = null;
    state.selectedStopMode = "guided";
    if(state.passagesTimer){ clearInterval(state.passagesTimer); state.passagesTimer = null; }
    renderLines();
    renderDirections(true);
    renderStops();
    renderPassagesIdle();
    try{
      const data = await fetchJson(`/api/horaires/ligne/${encodeURIComponent(line.id)}/arrets`);
      state.selectedLineData = data;
      renderDirections();
      qs("#horairesDirectionStep")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }catch(error){
      const step = qs("#horairesDirectionStep");
      if(step) step.innerHTML = `<div class="hor-step-title"><span>2</span> Choisir une direction</div><div class="hor-empty">Impossible de charger les directions de cette ligne.</div>`;
    }
  }

  function renderDirections(loading=false){
    const step = qs("#horairesDirectionStep");
    if(!step) return;
    if(!state.selectedLine){
      step.className = "hor-step is-muted";
      step.innerHTML = `<div class="hor-step-title"><span>2</span> Choisir une direction</div><div class="hor-hint">Choisissez d'abord une ligne.</div>`;
      return;
    }
    step.className = "hor-step";
    if(loading){ step.innerHTML = `<div class="hor-step-title"><span>2</span> Choisir une direction</div>${skeletonRows(2)}`; return; }
    const directions = state.selectedLineData?.directions || [];
    if(!directions.length){
      step.innerHTML = `<div class="hor-step-title"><span>2</span> Choisir une direction</div><div class="hor-empty">Aucune direction disponible pour cette ligne.</div>`;
      return;
    }
    step.innerHTML = `<div class="hor-step-title"><span>2</span> Choisir une direction</div>
      <div class="hor-direction-list">
        ${directions.map((direction, index) => {
          const active = state.selectedDirectionIndex === index;
          const headsign = direction.headsign || `Direction ${index + 1}`;
          return `<button class="hor-direction-btn${active ? " is-active" : ""}" type="button" data-direction-index="${index}">
            <strong>${esc(headsign)}</strong>
            <small>${esc((direction.stops || []).length)} arrêts</small>
          </button>`;
        }).join("")}
      </div>`;
  }

  function selectDirection(index){
    const directions = state.selectedLineData?.directions || [];
    const direction = directions[index];
    if(!direction) return;
    state.selectedDirectionIndex = index;
    state.selectedStop = null;
    state.selectedStopMode = "guided";
    if(state.passagesTimer){ clearInterval(state.passagesTimer); state.passagesTimer = null; }
    renderDirections();
    renderStops();
    renderPassagesIdle();
    qs("#horairesStopStep")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function currentDirection(){
    if(state.selectedDirectionIndex === null || state.selectedDirectionIndex === undefined) return null;
    return (state.selectedLineData?.directions || [])[state.selectedDirectionIndex] || null;
  }

  function renderStops(){
    const step = qs("#horairesStopStep");
    if(!step) return;
    const direction = currentDirection();
    if(!direction){
      step.className = "hor-step is-muted";
      step.innerHTML = `<div class="hor-step-title"><span>3</span> Choisir un arrêt</div><div class="hor-hint">Choisissez une direction pour afficher ses arrêts.</div>`;
      return;
    }
    const stops = direction.stops || [];
    step.className = "hor-step";
    if(!stops.length){ step.innerHTML = `<div class="hor-step-title"><span>3</span> Choisir un arrêt</div><div class="hor-empty">Aucun arrêt disponible dans ce sens.</div>`; return; }
    step.innerHTML = `<div class="hor-step-title"><span>3</span> Choisir un arrêt</div>
      <div class="hor-stop-list">
        ${stops.map((stop, index) => {
          const active = state.selectedStop && String(state.selectedStop.id) === String(stop.id) && state.selectedStopMode === "guided";
          return `<button class="hor-stop-row${active ? " is-active" : ""}" type="button" data-stop-id="${esc(stop.id)}" data-stop-name="${esc(stop.name)}">
            <span class="hor-stop-index">${index + 1}</span>
            <span class="hor-stop-name">${esc(stop.name)}</span>
            <span class="hor-chevron">›</span>
          </button>`;
        }).join("")}
      </div>`;
  }

  function renderPassagesIdle(){
    const step = qs("#horairesPassagesStep");
    if(!step) return;
    step.className = "hor-step is-muted";
    step.innerHTML = `<div class="hor-step-title"><span>4</span> Prochains passages</div><div class="hor-hint">Choisissez un arrêt pour afficher les prochains passages.</div>`;
  }

  async function selectGuidedStop(stopId, stopName){
    const direction = currentDirection();
    if(!direction) return;
    const stop = (direction.stops || []).find(item => String(item.id) === String(stopId)) || { id: stopId, name: stopName };
    state.selectedStop = stop;
    state.selectedStopMode = "guided";
    renderStops();
    await loadPassages({ filtered: true, scroll: true });
  }

  async function openStopPassages(stopId, stopName){
    openHorairesPanel();
    state.selectedStop = { id: stopId, name: stopName };
    state.selectedStopMode = "nearby";
    await loadPassages({ filtered: false, scroll: true });
  }

  function filterPassageGroups(groups, filtered){
    if(!filtered || !state.selectedLine) return groups;
    const lineKey = norm(state.selectedLine.short || state.selectedLine.id);
    let lineGroups = groups.filter(group => norm(group.line) === lineKey || norm(group.line).includes(lineKey));
    const direction = currentDirection();
    const headsignKey = norm(direction?.headsign || "");
    if(headsignKey){ lineGroups = lineGroups.filter(group => norm(group.headsign) === headsignKey); }
    return lineGroups;
  }

  async function loadPassages(options={}){
    const step = qs("#horairesPassagesStep");
    const stop = state.selectedStop;
    if(!step || !stop) return;
    const filtered = Boolean(options.filtered);
    if(state.passagesTimer){ clearInterval(state.passagesTimer); state.passagesTimer = null; }
    step.className = "hor-step";
    step.innerHTML = `<div class="hor-step-title"><span>4</span> Prochains passages</div>${skeletonRows(3)}`;
    try{
      const data = await fetchJson(`/api/horaires/arret/${encodeURIComponent(stop.id)}/prochains`);
      const groups = filterPassageGroups(data.passages || [], filtered);
      renderPassages(stop, groups, data.ts, filtered);
      if(options.scroll){ step.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
      state.passagesTimer = setInterval(() => {
        if(!isOpen() || !state.selectedStop) return;
        loadPassages({ filtered: state.selectedStopMode === "guided", scroll: false });
      }, REFRESH_MS);
    }catch(error){ step.innerHTML = `<div class="hor-step-title"><span>4</span> Prochains passages</div><div class="hor-empty">Impossible de charger les prochains passages.</div>`; }
  }

  function renderPassages(stop, groups, ts, filtered){
    const step = qs("#horairesPassagesStep");
    if(!step) return;
    const direction = currentDirection();
    const line = state.selectedLine;
    const intro = filtered && line ? `${line.short}${direction?.headsign ? " · direction " + direction.headsign : ""}` : "Toutes lignes disponibles";
    let html = `<div class="hor-step-title"><span>4</span> Prochains passages</div>
      <div class="hor-passages-card">
        <div class="hor-passages-top">
          <div>
            <h4>${esc(stop.name)}</h4>
            <p>${esc(intro)}${ts ? ` · actualisé à ${esc(ts)}` : ""}</p>
          </div>
          <button class="hor-refresh-btn" type="button" data-refresh-passages="1">Rafraîchir</button>
        </div>`;
    if(!groups.length){ html += `<div class="hor-empty">Aucun prochain passage disponible pour cette sélection.</div>`; }
    else{
      groups.forEach(group => {
        const bg = clampColor(group.line_color, "#0ea5e9");
        const fg = clampColor(group.line_text_color, "#ffffff");
        const rows = (group.passages || []).slice(0, 6).map(passage => `<div class="hor-passage-row">
          <span class="hor-line-badge" style="--line-bg:${esc(bg)};--line-fg:${esc(fg)}">${esc(group.line)}</span>
          <span class="hor-passage-destination">${esc(group.headsign || "Direction non précisée")}</span>
          <span class="hor-passage-wait">${esc(minuteLabel(passage.minutes))}</span>
          <span class="hor-passage-time">${esc(passage.time || "")}</span>
          <span class="hor-source-badge ${passage.source === "reel" ? "is-live" : ""}">${passage.source === "reel" ? "temps réel" : "théorique"}</span>
        </div>`).join("");
        html += `<div class="hor-passage-group">${rows || '<div class="hor-empty">Aucun passage.</div>'}</div>`;
      });
    }
    html += `</div>`;
    step.innerHTML = html;
  }

  async function startNearbyAuto(){
    const list = qs("#horairesNearbyList");
    if(!list) return;
    if(state.nearbyStarted && state.nearbyPosition){ refreshNearby(false); return; }
    state.nearbyStarted = true;
    list.innerHTML = skeletonRows(3);
    if(!navigator.geolocation){ list.innerHTML = `<div class="hor-empty">La géolocalisation n'est pas disponible sur cet appareil.</div>`; return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        state.nearbyPosition = pos;
        refreshNearby(true);
        if(state.nearbyTimer) clearInterval(state.nearbyTimer);
        state.nearbyTimer = setInterval(() => { if(isOpen()) refreshNearby(false); }, REFRESH_MS);
      },
      () => { list.innerHTML = `<div class="hor-empty">Autorisez la localisation pour afficher les arrêts proches.</div>`; },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
    );
  }

  async function refreshNearby(scroll){
    const list = qs("#horairesNearbyList");
    const pos = state.nearbyPosition;
    if(!list || !pos) return;
    if(scroll) list.innerHTML = skeletonRows(3);
    try{
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const data = await fetchJson(`/api/horaires/proche?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radius=${NEARBY_RADIUS}`);
      const stops = (data.arrets || []).slice(0, MAX_NEARBY);
      const enriched = await Promise.all(stops.map(async stop => {
        try{
          const detail = await fetchJson(`/api/horaires/arret/${encodeURIComponent(stop.id)}/prochains`);
          return { ...stop, passages: detail.passages || [] };
        }catch(error){ return { ...stop, passages: [] }; }
      }));
      state.nearbyStops = enriched;
      renderNearby(enriched);
    }catch(error){ list.innerHTML = `<div class="hor-empty">Arrêts proches indisponibles pour le moment.</div>`; }
  }

  function collectTimes(stop){
    const times = [];
    (stop.passages || []).forEach(group => {
      (group.passages || []).forEach(passage => {
        times.push({ line: group.line, minutes: passage.minutes, time: passage.time, source: passage.source, sort: Number.isFinite(Number(passage.minutes)) ? Number(passage.minutes) : 9999 });
      });
    });
    return times.sort((a,b) => a.sort - b.sort).slice(0, 3);
  }

  function renderNearby(stops){
    const list = qs("#horairesNearbyList");
    if(!list) return;
    if(!stops.length){ list.innerHTML = `<div class="hor-empty">Aucun arrêt proche détecté.</div>`; return; }
    list.innerHTML = stops.map(stop => {
      const lines = (stop.lines || []).slice(0, 5).map(line => {
        const bg = clampColor(line.color, "#0ea5e9");
        return `<span class="hor-mini-line" style="--line-bg:${esc(bg)}">${esc(line.short || line)}</span>`;
      }).join("");
      const times = collectTimes(stop);
      const timeHtml = times.length ? times.map(item => `<span class="hor-mini-time">${esc(minuteLabel(item.minutes))}</span>`).join("") : `<span class="hor-no-time">Aucun passage disponible</span>`;
      return `<button class="hor-nearby-stop" type="button" data-stop-id="${esc(stop.id)}" data-stop-name="${esc(stop.name)}">
        <span class="hor-nearby-icon" aria-hidden="true">⌖</span>
        <span class="hor-nearby-main">
          <strong>${esc(stop.name)}</strong>
          <small>${esc(stop.distance ?? "?")} m</small>
          <span class="hor-mini-lines">${lines || '<em>Arrêt TCL</em>'}</span>
          <span class="hor-mini-times">${timeHtml}</span>
        </span>
        <span class="hor-chevron">›</span>
      </button>`;
    }).join("");
  }

  function handleClick(event){
    const target = event.target;
    const lineBtn = target.closest?.(".hor-line-pill");
    if(lineBtn){ event.preventDefault(); selectLine(lineBtn.dataset.lineId); return; }
    const directionBtn = target.closest?.(".hor-direction-btn");
    if(directionBtn){ event.preventDefault(); selectDirection(Number(directionBtn.dataset.directionIndex)); return; }
    const stopBtn = target.closest?.(".hor-stop-row");
    if(stopBtn){ event.preventDefault(); selectGuidedStop(stopBtn.dataset.stopId, stopBtn.dataset.stopName); return; }
    const nearbyBtn = target.closest?.(".hor-nearby-stop");
    if(nearbyBtn){ event.preventDefault(); openStopPassages(nearbyBtn.dataset.stopId, nearbyBtn.dataset.stopName); return; }
    const refreshBtn = target.closest?.(".hor-refresh-btn");
    if(refreshBtn){ event.preventDefault(); loadPassages({ filtered: state.selectedStopMode === "guided", scroll: false }); }
  }

  function initHoraires(){
    const view = qs("#horairesView");
    if(view && !view.dataset.horairesInit){ view.dataset.horairesInit = "1"; view.addEventListener("click", handleClick); }
    const back = qs("#horairesBack");
    if(back && !back.dataset.horairesInit){
      back.dataset.horairesInit = "1";
      back.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); closeHorairesPanel(); });
    }
    const overlay = qs("#horairesOverlay");
    if(overlay && !overlay.dataset.horairesInit){ overlay.dataset.horairesInit = "1"; overlay.addEventListener("click", closeHorairesPanel); }
    const input = qs("#horairesSearchInput");
    if(input && !input.dataset.horairesInit){
      input.dataset.horairesInit = "1";
      input.addEventListener("input", () => { state.lineQuery = input.value; renderLines(); });
      input.addEventListener("keydown", event => {
        if(event.key === "Escape"){
          input.value = "";
          state.lineQuery = "";
          renderLines();
        }
      });
    }
    const searchBtn = qs("#horairesSearchBtn");
    if(searchBtn && !searchBtn.dataset.horairesInit){
      searchBtn.dataset.horairesInit = "1";
      searchBtn.addEventListener("click", event => {
        event.preventDefault();
        const inputEl = qs("#horairesSearchInput");
        state.lineQuery = inputEl?.value || "";
        renderLines();
        inputEl?.focus();
      });
    }
  }

  window.v7Horaires = {
    open: openHoraires,
    close: closeHorairesPanel,
    openNearby: startNearbyAuto,
    openArret: openStopPassages,
    openLigne: selectLine,
    refresh: function(){ if(isOpen()){ refreshNearby(false); loadLines(); } }
  };

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", initHoraires);
  else initHoraires();
})();

/* =========================================================
   V7 REMOVE SEARCH BAR — RUNTIME GUARD
========================================================= */
(function(){
  function killSearch(){
    document.body.classList.remove("search-focus");

    [
      ".v7-search",
      ".v7-search-shell",
      ".v7-searchbar",
      ".v7-search-marquee",
      ".v7-search-suggest",
      ".v7-open-search",
      "#q",
      "#openSearch",
      "#searchBox",
      "#searchInput",
      "#v7Search"
    ].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.remove();
      });
    });
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", killSearch);
  }else{
    killSearch();
  }

  setTimeout(killSearch, 250);
  setTimeout(killSearch, 1000);
})();


/* =========================================================
   V7 HORAIRES PREMIUM FLOW
   UX propre : recherche -> arrêt -> ligne -> passages -> horaires journée
========================================================= */
(function(){
  const REFRESH_MS = 30000;
  const RADIUS = 700;

  const state = {
    selectedStop: null,
    selectedLine: null,
    selectedLineData: null,
    currentDetail: null,
    currentNext: null,
    refreshTimer: null,
    nearbyTimer: null,
    nearbyPosition: null,
    queryTimer: null
  };

  function qs(sel, root){ return (root || document).querySelector(sel); }
  function qsa(sel, root){ return Array.from((root || document).querySelectorAll(sel)); }
  function esc(v){ return String(v ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  async function getJson(url){
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), {cache:"no-store"});
    return await r.json();
  }

  function minuteLabel(v){
    const n = Number(v);
    if(!Number.isFinite(n)) return String(v || "");
    if(n <= 0) return "maintenant";
    return n + " min";
  }

  function color(v, fallback){ return /^#[0-9a-f]{6}$/i.test(String(v || "")) ? v : fallback; }

  function skeleton(n){
    return Array.from({length:n}).map(() => `<div class="hor-skeleton-row"></div>`).join("");
  }

  function clearTimers(){
    if(state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }

  function openPanel(){
    document.body.classList.remove("line-open","traffic-open","lignes-open","favoris-open","reglages-open","autour-open","vehicle-portrait-open","sidebar-open");
    document.body.classList.add("horaires-open");
    qs("#horairesView")?.classList.add("open");

    const title = qs("#horairesTitle");
    const sub = qs(".hor-page-heading p");
    if(title) title.textContent = "Horaires";
    if(sub) sub.textContent = "Arrêts proches et recherche par arrêt";
  }

  function closePanel(){
    document.body.classList.remove("horaires-open");
    qs("#horairesView")?.classList.remove("open");
    clearTimers();
  }

  function resetSelection(){
    state.selectedStop = null;
    state.selectedLine = null;
    state.selectedLineData = null;
    state.currentDetail = null;
    state.currentNext = null;
    clearTimers();
  }

  function renderHome(){
    resetSelection();
    const content = qs("#horairesContent");
    if(!content) return;

    content.className = "hor-page-content";
    content.innerHTML = `
      <div class="hor-premium-flow">
        <section class="hor-panel hor-nearby-panel">
          <div class="hor-section-head">
            <div>
              <h3>Arrêts proches</h3>
              <p>Prochains passages autour de vous</p>
            </div>
            <span class="hor-live-dot" aria-label="Actualisation automatique"></span>
          </div>
          <div id="horairesNearbyList" class="hor-nearby-list">${skeleton(2)}</div>
        </section>

        <section class="hor-panel hor-search-panel">
          <div class="hor-section-head">
            <div>
              <h3>Rechercher un arrêt</h3>
              <p>Tapez le nom d’un arrêt pour consulter ses lignes</p>
            </div>
          </div>

          <div class="hor-stop-search-box">
            <span class="hor-stop-search-icon" aria-hidden="true">⌕</span>
            <input id="horairesStopSearchInput" type="search" placeholder="Rechercher un arrêt" autocomplete="off" autocorrect="off" spellcheck="false">
          </div>

          <div id="horairesStopResults" class="hor-stop-results"></div>
        </section>

        <section class="hor-panel hor-stop-detail-panel" id="horairesStopDetail" hidden></section>
      </div>
    `;

    bindSearch();
    startNearby();
  }

  function renderStopCards(stops, target){
    const box = qs(target);
    if(!box) return;

    if(!stops.length){
      box.innerHTML = `<div class="hor-empty">Aucun arrêt trouvé.</div>`;
      return;
    }

    box.innerHTML = stops.map(stop => {
      const lines = (stop.lines || []).slice(0,6).map(l => {
        const bg = color(l.color, "#0ea5e9");
        return `<span class="hor-mini-line" style="--line-bg:${esc(bg)}">${esc(l.short || l)}</span>`;
      }).join("");

      return `<button class="hor-nearby-stop" type="button" data-stop-id="${esc(stop.id)}" data-stop-name="${esc(stop.name)}">
        <span class="hor-nearby-icon" aria-hidden="true">⌖</span>
        <span class="hor-nearby-main">
          <strong>${esc(stop.name)}</strong>
          <small>${stop.distance !== undefined ? esc(stop.distance) + " m" : "Arrêt TCL"}</small>
          <span class="hor-mini-lines">${lines || "<em>Lignes disponibles après sélection</em>"}</span>
        </span>
        <span class="hor-chevron">›</span>
      </button>`;
    }).join("");
  }

  function bindSearch(){
    const input = qs("#horairesStopSearchInput");
    if(!input) return;

    input.addEventListener("input", () => {
      clearTimeout(state.queryTimer);
      const q = input.value.trim();
      const box = qs("#horairesStopResults");
      if(!box) return;

      if(q.length < 2){
        box.innerHTML = "";
        return;
      }

      box.innerHTML = skeleton(3);

      state.queryTimer = setTimeout(async () => {
        try{
          const data = await getJson("/api/horaires/arrets?q=" + encodeURIComponent(q));
          renderStopCards(data.arrets || [], "#horairesStopResults");
        }catch(e){
          box.innerHTML = `<div class="hor-empty">Recherche indisponible.</div>`;
        }
      }, 80);
    });
  }

  function startNearby(){
    const list = qs("#horairesNearbyList");
    if(!list) return;

    if(!navigator.geolocation){
      list.innerHTML = `<div class="hor-empty">Localisation indisponible sur cet appareil.</div>`;
      return;
    }

    navigator.geolocation.getCurrentPosition(
      pos => {
        state.nearbyPosition = pos;
        refreshNearby(true);
        if(state.nearbyTimer) clearInterval(state.nearbyTimer);
        state.nearbyTimer = setInterval(() => {
          if(document.body.classList.contains("horaires-open") && !state.selectedStop) refreshNearby(false);
        }, REFRESH_MS);
      },
      () => {
        list.innerHTML = `<div class="hor-empty">Autorisez la localisation pour afficher les arrêts proches.</div>`;
      },
      {enableHighAccuracy:true, timeout:12000, maximumAge:15000}
    );
  }

  async function refreshNearby(loading){
    const list = qs("#horairesNearbyList");
    const pos = state.nearbyPosition;
    if(!list || !pos || state.selectedStop) return;

    if(loading) list.innerHTML = skeleton(2);

    try{
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const data = await getJson(`/api/horaires/proche?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radius=${RADIUS}`);
      renderStopCards((data.arrets || []).slice(0,4), "#horairesNearbyList");
    }catch(e){
      list.innerHTML = `<div class="hor-empty">Arrêts proches indisponibles.</div>`;
    }
  }

  function collapseSearchAfterStop(stopName){
    const searchPanel = qs(".hor-search-panel");
    const nearbyPanel = qs(".hor-nearby-panel");

    if(nearbyPanel) nearbyPanel.hidden = true;

    if(searchPanel){
      searchPanel.innerHTML = `
        <button class="hor-change-stop" type="button" data-change-stop="1">
          <span>‹</span>
          <strong>Changer d’arrêt</strong>
          <small>${esc(stopName || "")}</small>
        </button>
      `;
    }
  }

  async function openStop(stopId, stopName){
    const panel = qs("#horairesStopDetail");
    if(!panel) return;

    state.selectedStop = {id: stopId, name: stopName};
    state.selectedLine = null;
    state.selectedLineData = null;

    collapseSearchAfterStop(stopName);

    panel.hidden = false;
    panel.innerHTML = skeleton(4);
    panel.scrollIntoView({block:"start", behavior:"smooth"});

    try{
      const detail = await getJson(`/api/horaires/arret/${encodeURIComponent(stopId)}/detail`);
      const next = await getJson(`/api/horaires/arret/${encodeURIComponent(stopId)}/prochains`);
      state.currentDetail = detail;
      state.currentNext = next;
      renderStopLineChoice(detail, next);
      startSelectedRefresh();
    }catch(e){
      panel.innerHTML = `<div class="hor-empty">Impossible de charger cet arrêt.</div>`;
    }
  }

  function startSelectedRefresh(){
    clearTimers();
    state.refreshTimer = setInterval(() => {
      if(document.body.classList.contains("horaires-open") && state.selectedStop){
        refreshSelectedStop(false);
      }
    }, REFRESH_MS);
  }

  async function refreshSelectedStop(showLoading){
    if(!state.selectedStop) return;
    const panel = qs("#horairesStopDetail");
    if(showLoading && panel) panel.innerHTML = skeleton(3);

    try{
      const detail = await getJson(`/api/horaires/arret/${encodeURIComponent(state.selectedStop.id)}/detail`);
      const next = await getJson(`/api/horaires/arret/${encodeURIComponent(state.selectedStop.id)}/prochains`);
      state.currentDetail = detail;
      state.currentNext = next;

      if(state.selectedLine){
        const dayBox = qs("#horairesDaySchedule");
        const dayWasOpen = dayBox && !dayBox.hidden && dayBox.innerHTML.trim();
        if(dayWasOpen){
          renderLivePassagesOnly();
        }else{
          renderLineDetail();
        }
      }else{
        renderStopLineChoice(detail, next);
      }
    }catch(e){}
  }

  function nextPreviewForLine(lineShort){
    const groups = (state.currentNext?.passages || []).filter(g => String(g.line).toUpperCase() === String(lineShort).toUpperCase());
    const all = [];
    groups.forEach(g => (g.passages || []).forEach(p => all.push({...p, headsign:g.headsign})));
    all.sort((a,b) => Number(a.minutes ?? 9999) - Number(b.minutes ?? 9999));
    return all[0] ? `${minuteLabel(all[0].minutes)} · ${all[0].headsign || ""}` : "Voir les horaires";
  }

  function renderStopLineChoice(detail, next){
    const panel = qs("#horairesStopDetail");
    if(!panel) return;

    const arret = detail.arret || next.arret || state.selectedStop || {};
    const lignes = detail.lignes || [];

    panel.innerHTML = `
      <div class="hor-stop-card-clean">
        <div class="hor-stop-clean-head">
          <div>
            <h3>${esc(arret.name || "Arrêt")}</h3>
            <p>${esc(lignes.length)} ligne${lignes.length > 1 ? "s" : ""} à cet arrêt${next?.ts ? " · actualisé à " + esc(next.ts) : ""}</p>
          </div>
        </div>

        <div class="hor-line-filter-title">Choisir une ligne</div>

        <div class="hor-stop-line-list hor-stop-line-list-premium">
          ${lignes.map(l => {
            const bg = color(l.color, "#0ea5e9");
            const fg = color(l.text_color, "#ffffff");
            return `<button class="hor-stop-line-btn" type="button" data-line="${esc(l.short)}" data-stop-id="${esc(arret.id)}" style="--line-bg:${esc(bg)};--line-fg:${esc(fg)}">
              <span>${esc(l.short)}</span>
              <strong>${esc(nextPreviewForLine(l.short))}</strong>
              <small>${esc(l.long || "Horaires de la ligne")}</small>
            </button>`;
          }).join("") || `<div class="hor-empty">Aucune ligne trouvée pour cet arrêt.</div>`}
        </div>
      </div>
    `;
  }

  function groupsForSelectedLine(){
    if(!state.selectedLine || !state.currentNext) return [];
    return (state.currentNext.passages || [])
      .filter(g => String(g.line).toUpperCase() === String(state.selectedLine.short).toUpperCase())
      .sort((a,b) => {
        const am = Math.min(...(a.passages || []).map(p => Number(p.minutes ?? 9999)));
        const bm = Math.min(...(b.passages || []).map(p => Number(p.minutes ?? 9999)));
        return am - bm;
      });
  }

  function renderLineDetail(){
    const panel = qs("#horairesStopDetail");
    if(!panel || !state.selectedStop || !state.selectedLine) return;

    const line = state.selectedLine;
    const groups = groupsForSelectedLine();
    const bg = color(line.color, "#0ea5e9");
    const fg = color(line.text_color, "#ffffff");

    panel.innerHTML = `
      <div class="hor-stop-card-clean hor-line-focus-card">
        <div class="hor-line-topbar">
          <button class="hor-inline-back" type="button" data-back-stop-lines="1">‹ Lignes de l’arrêt</button>
        </div>

        <div class="hor-line-hero">
          <span class="hor-line-badge hor-line-badge-xl" style="--line-bg:${esc(bg)};--line-fg:${esc(fg)}">${esc(line.short)}</span>
          <div>
            <h3>${esc(state.selectedStop.name || "Arrêt")}</h3>
            <p>${esc(line.long || "Prochains passages")}</p>
            <small id="horairesLineTs">${state.currentNext?.ts ? "Actualisé à " + esc(state.currentNext.ts) : ""}</small>
          </div>
        </div>

        <div class="hor-section-label">Prochains passages</div>
        <div id="horairesLivePassages" class="hor-live-passages">
          ${renderSelectedLineRows(groups)}
        </div>

        <button class="hor-day-toggle" type="button" data-load-day-schedule="1">
          Afficher les horaires complets du jour
        </button>

        <div id="horairesDaySchedule" class="hor-day-schedule hor-day-sheet" hidden></div>
      </div>
    `;
  }

  function renderLivePassagesOnly(){
    const list = qs("#horairesLivePassages");
    const ts = qs("#horairesLineTs");
    if(!list || !state.selectedLine) return;
    list.innerHTML = renderSelectedLineRows(groupsForSelectedLine());
    if(ts && state.currentNext?.ts) ts.textContent = "Actualisé à " + state.currentNext.ts;
  }

  function renderSelectedLineRows(groups){
    if(!groups.length) return `<div class="hor-empty">Aucun prochain passage disponible pour cette ligne.</div>`;

    return groups.map(group => {
      const first = (group.passages || [])[0];
      const rest = (group.passages || []).slice(1,4);

      return `<section class="hor-direction-card">
        <div class="hor-direction-main">
          <div>
            <h4>${esc(group.headsign || "Direction non précisée")}</h4>
            <p>Direction</p>
          </div>
          ${first ? `<div class="hor-next-big">
            <strong>${esc(minuteLabel(first.minutes))}</strong>
            <span>${esc(first.time || "")}</span>
          </div>` : ""}
        </div>
        ${rest.length ? `<div class="hor-next-chips">
          ${rest.map(p => `<span>${esc(p.time || minuteLabel(p.minutes))}</span>`).join("")}
        </div>` : ""}
      </section>`;
    }).join("");
  }

  function selectLine(lineShort){
    const detail = state.currentDetail;
    if(!detail) return;

    const found = (detail.lignes || []).find(l => String(l.short).toUpperCase() === String(lineShort).toUpperCase());
    if(!found) return;

    state.selectedLine = found;
    renderLineDetail();
    qs("#horairesStopDetail")?.scrollIntoView({block:"start", behavior:"smooth"});
  }

  async function openDaySchedule(){
    if(!state.selectedStop || !state.selectedLine) return;

    const box = qs("#horairesDaySchedule");
    const btn = qs("[data-load-day-schedule]");
    if(!box) return;

    box.hidden = false;
    box.innerHTML = skeleton(3);
    if(btn) btn.hidden = true;

    try{
      const line = state.selectedLine.short;
      const stopId = state.selectedStop.id;
      const data = await getJson(`/api/horaires/ligne/${encodeURIComponent(line)}/arret/${encodeURIComponent(stopId)}/journee`);

      if(!data.ok || !data.directions?.length){
        box.innerHTML = `<div class="hor-empty">Aucun horaire journée disponible pour cette ligne.</div>`;
        return;
      }

      box.innerHTML = `
        <div class="hor-day-head hor-day-head-clean">
          <div>
            <strong>Horaires complets du jour</strong>
            <small>${esc(data.count)} départ${data.count > 1 ? "s" : ""}</small>
          </div>
        </div>

        <div class="hor-day-directions-clean">
          ${data.directions.map((d, idx) => `
            <details class="hor-day-direction-clean" ${idx === 0 ? "open" : ""}>
              <summary>
                <span>Direction ${esc(d.headsign)}</span>
                <em>${esc((d.times || []).length)} horaires</em>
              </summary>
              <div class="hor-day-times-clean">
                ${(d.times || []).map(t => `<span>${esc(t)}</span>`).join("") || `<em>Aucun horaire</em>`}
              </div>
            </details>
          `).join("")}
        </div>
      `;

      box.scrollIntoView({block:"nearest", behavior:"smooth"});
    }catch(e){
      box.innerHTML = `<div class="hor-empty">Impossible de charger les horaires journée.</div>`;
    }
  }

  function changeStop(){
    renderHome();
    setTimeout(() => qs("#horairesStopSearchInput")?.focus(), 80);
  }

  function bindGlobal(){
    document.addEventListener("click", e => {
      const back = e.target.closest?.("#horairesBack");
      if(back){
        e.preventDefault();
        e.stopPropagation();
        closePanel();
        return;
      }

      const change = e.target.closest?.("[data-change-stop]");
      if(change){
        e.preventDefault();
        changeStop();
        return;
      }

      const stop = e.target.closest?.(".hor-nearby-stop");
      if(stop && document.body.classList.contains("horaires-open")){
        e.preventDefault();
        openStop(stop.dataset.stopId, stop.dataset.stopName);
        return;
      }

      const line = e.target.closest?.(".hor-stop-line-btn");
      if(line){
        e.preventDefault();
        selectLine(line.dataset.line);
        return;
      }

      const backLines = e.target.closest?.("[data-back-stop-lines]");
      if(backLines){
        e.preventDefault();
        state.selectedLine = null;
        renderStopLineChoice(state.currentDetail, state.currentNext);
        return;
      }

      const day = e.target.closest?.("[data-load-day-schedule]");
      if(day){
        e.preventDefault();
        openDaySchedule();
      }
    }, true);
  }

  function open(){
    openPanel();
    renderHome();
  }

  bindGlobal();

  window.v7Horaires = {
    open,
    close: closePanel,
    openArret: function(id, name){ openPanel(); renderHome(); setTimeout(() => openStop(id, name), 120); },
    openStop: function(id, name){ openPanel(); renderHome(); setTimeout(() => openStop(id, name), 120); },
    refresh: function(){ if(document.body.classList.contains("horaires-open")) refreshSelectedStop(false); }
  };
})();








/* =========================================================
   V7 ITINERAIRE — SMART REBUILD FINAL
========================================================= */
(function(){
  const qs = (s,r=document)=>r.querySelector(s);
  const qsa = (s,r=document)=>Array.from(r.querySelectorAll(s));
  const esc = v => String(v ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  const LYON_CENTER = {lat:45.764, lon:4.835};
  const state = {
    from:null,
    to:null,
    mode:"depart",
    timer:null,
    result:null,
    offset:0
  };

  function todayValue(){
    const d = new Date();
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }

  function nowTimeValue(){
    const d = new Date();
    return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
  }

  function addMinutesToTime(t, delta){
    const m = String(t || nowTimeValue()).match(/^(\d{1,2}):(\d{2})/);
    const base = m ? (Number(m[1])*60 + Number(m[2])) : 0;
    let n = Math.max(0, Math.min(1439, base + delta));
    return String(Math.floor(n/60)).padStart(2,"0") + ":" + String(n%60).padStart(2,"0");
  }

  async function getJson(url){
    const finalUrl = url.startsWith("http") ? url : url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
    const r = await fetch(finalUrl, {cache:"no-store"});
    return r.json();
  }

  async function postJson(url, payload){
    const r = await fetch(url, {
      method:"POST",
      cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload || {})
    });
    return r.json();
  }

  function closeOther(){
    document.body.classList.remove("line-open","traffic-open","lignes-open","favoris-open","reglages-open","autour-open","vehicle-portrait-open","sidebar-open","horaires-open");
    ["lineView","trafficView","lignesView","autourView","favorisView","reglagensView","horairesView"].forEach(id => qs("#"+id)?.classList.remove("open"));
    try{ window.v7NearbyWidget?.close?.(); }catch(e){}
  }

  function ensureView(){
    let view = qs("#itineraireView");
    if(view) return view;

    view = document.createElement("section");
    view.id = "itineraireView";
    view.className = "v7-itineraire-view";
    view.innerHTML = `
      <header class="iti-top">
        <button id="itineraireBack" type="button" class="iti-back" aria-label="Retour à la carte">‹</button>
        <div>
          <h2>Itinéraire</h2>
          <p>Calculer le meilleur trajet TCL</p>
        </div>
      </header>
      <main id="itineraireContent" class="iti-main"></main>
    `;
    document.body.appendChild(view);
    return view;
  }

  function closeItiPopup(){
    qs("#itiRoutePopup")?.classList.remove("open");
    document.body.classList.remove("iti-result-modal-open");
  }

  function openPanel(){
    closeItiPopup();
    closeOther();
    document.body.classList.add("itineraire-open","iti-hide-nearby");
    qsa(".v7-nav-item").forEach(el => el.classList.toggle("active", el.dataset.section === "itineraire"));
    ensureView().classList.add("open");
    render();
  }

  function closePanel(restoreHome){
    if(restoreHome === undefined) restoreHome = true;
    closeItiPopup();
    document.body.classList.remove("itineraire-open","iti-hide-nearby","sidebar-open","search-focus");
    qs("#itineraireView")?.classList.remove("open");
    qsa(".v7-nav-item").forEach(el => el.classList.toggle("active", el.dataset.section === "home"));
    try{
      if(typeof closeSidebar === "function") closeSidebar();
    }catch(e){}
    if(restoreHome){
      try{
        if(typeof v7RefreshMapSize === "function") v7RefreshMapSize();
        else if(typeof setViewMode === "function") setViewMode("home");
      }catch(e){}
    }
  }

  function render(){
    const box = qs("#itineraireContent");
    if(!box) return;

    box.innerHTML = `
      <section class="iti-search-card">
        <div class="iti-field">
          <label>Départ</label>
          <div class="iti-input-wrap">
            <input id="itiFromInput" type="text" placeholder="Adresse ou arrêt de départ" autocomplete="off" value="${esc(state.from?.name || "")}">
            <button type="button" class="iti-position-btn" data-iti-position>Ma position</button>
          </div>
          <div id="itiFromResults" class="iti-results"></div>
        </div>

        <div class="iti-field">
          <label>Destination</label>
          <input id="itiToInput" type="text" placeholder="Adresse, lieu ou arrêt" autocomplete="off" value="${esc(state.to?.name || "")}">
          <div id="itiToResults" class="iti-results"></div>
        </div>

        <div class="iti-mode-tabs" role="tablist" aria-label="Type de recherche">
          <button type="button" role="tab" aria-selected="${state.mode === "depart" ? "true" : "false"}" data-iti-mode="depart" class="${state.mode === "depart" ? "active" : ""}">Partir à</button>
          <button type="button" role="tab" aria-selected="${state.mode === "arrive" ? "true" : "false"}" data-iti-mode="arrive" class="${state.mode === "arrive" ? "active" : ""}">Arriver avant</button>
        </div>

        <div class="iti-time-grid">
          <div class="iti-field iti-compact">
            <label>Date</label>
            <input id="itiDateInput" type="date" value="${todayValue()}">
          </div>
          <div class="iti-field iti-compact">
            <label>Heure</label>
            <input id="itiTimeInput" type="time" value="${nowTimeValue()}">
          </div>
        </div>

        <button type="button" class="iti-submit" data-iti-plan>Calculer l’itinéraire</button>
      </section>

      <section id="itiOutput" class="iti-output"></section>
    `;

    bind();
    if(state.result) renderResult(state.result);
  }

  function bind(){
    const back = qs("#itineraireBack");
    if(back) back.onclick = () => closePanel();
    qs("[data-iti-position]")?.addEventListener("click", usePosition);
    qs("[data-iti-plan]")?.addEventListener("click", async (e) => { e.preventDefault(); await plan(); });

	    qsa("[data-iti-mode]").forEach(btn => {
	      btn.addEventListener("click", () => {
	        state.mode = btn.dataset.itiMode || "depart";
	        qsa("[data-iti-mode]").forEach(b => b.classList.toggle("active", b === btn));
	        qsa("[data-iti-mode]").forEach(b => b.setAttribute("aria-selected", b === btn ? "true" : "false"));
	      });
	    });

    bindSearch("#itiFromInput","#itiFromResults","from");
    bindSearch("#itiToInput","#itiToResults","to");
}

  function distanceToLyon(item){
    if(!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return 999999;
    const dx = (item.lat - LYON_CENTER.lat) * 111000;
    const dy = (item.lon - LYON_CENTER.lon) * 76000;
    return Math.sqrt(dx*dx + dy*dy);
  }

  function tclTypeLabel(type){
    if(type === "stop" || type === "area") return "Arrêt TCL";
    if(type === "address") return "Adresse";
    if(type === "poi") return "Lieu";
    if(type === "boundary") return "Commune";
    return "Lieu";
  }

  async function searchTclAutocomplete(q){
    try{
      const j = await getJson("/api/tcl/autocomplete?q=" + encodeURIComponent(q));
      if(j.ok && Array.isArray(j.results)){
        return j.results.map(r => ({
          type:r.type || "place",
          tclType:r.tclType || r.rawType || (r.type === "stop" ? "area" : r.type),
          id:r.id || "",
          name:r.name || "Lieu",
          address:r.address || "",
          distance:r.distance,
          meta:r.meta || tclTypeLabel(r.type || r.tclType),
          lat:Number(r.lat),
          lon:Number(r.lon)
        })).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon));
      }
    }catch(e){
      console.error("tcl autocomplete failed", e);
    }
    return [];
  }

  async function searchAddresses(q){
    const rows = await searchTclAutocomplete(q);
    return rows.filter(r => r.tclType === "address" || r.tclType === "poi" || r.tclType === "boundary");
  }

  async function searchStops(q){
    const official = await searchTclAutocomplete(q);
    if(official.length) return official;

    try{
      let searchUrl = "/api/itineraire/search?q=" + encodeURIComponent(q) + "&limit=12";
      if(state.from && Number.isFinite(Number(state.from.lat)) && Number.isFinite(Number(state.from.lon))){
        searchUrl += "&lat=" + encodeURIComponent(state.from.lat) + "&lon=" + encodeURIComponent(state.from.lon);
      }
      const j = await getJson(searchUrl);
      return (j.results || []).map(r => ({
        type:r.type || "place",
        tclType:r.type === "stop" ? "area" : (r.type || "address"),
        id:r.id || "",
        name:r.name || "Lieu",
        address:r.address || "",
        distance:r.distance,
        meta:r.address || (r.type === "stop" ? "Arrêt TCL" : "Lieu"),
        lat:Number(r.lat),
        lon:Number(r.lon)
      })).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon));
    }catch(e){
      console.error("itineraire search failed", e);
      return [];
    }
  }

  function itiNormText(v){
    return String(v || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function itiRelevance(q, item){
    const nq = itiNormText(q);
    const name = itiNormText(item.name);
    const meta = itiNormText(item.address || item.meta || "");
    const hay = (name + " " + meta).trim();
    const tokens = nq.split(" ").filter(t => t.length > 1);

    let score = 0;
    if(item.type === "stop") score -= 2500;

    if(name === nq) score -= 9000;
    else if(name.startsWith(nq)) score -= 7000;
    else if(name.includes(nq)) score -= 5500;
    else if(hay.includes(nq)) score -= 3500;

    for(const t of tokens){
      if(name.includes(t)) score -= 900;
      else if(hay.includes(t)) score -= 300;
      else score += 1200;
    }

    if(tokens.length && !tokens.some(t => hay.includes(t))) score += 9000;
    score += Math.round((Number(item.distance) || distanceToLyon(item) || 999999) / 18);
    return score;
  }

  async function smartSearch(q){
    const rows = await searchStops(q);
    const nq = itiNormText(q);
    const seen = new Set();

    return rows
      .filter(x => {
        const hay = itiNormText((x.name || "") + " " + (x.address || x.meta || ""));
        if(!hay) return false;
        if(nq.length >= 3 && !nq.split(" ").some(t => t.length > 1 && hay.includes(t))) return false;

        const k = (x.type + "|" + x.name + "|" + (x.address || "")).toLowerCase();
        if(seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a,b) => itiRelevance(q,a) - itiRelevance(q,b))
      .slice(0,8);
  }

  function bindSearch(inputSel, resultSel, key){
    const input = qs(inputSel);
    const results = qs(resultSel);
    if(!input || !results) return;

    let searchSeq = 0;

    async function runSearch(){
      clearTimeout(state.timer);
      const q = input.value.trim();
      const seq = ++searchSeq;

      state[key] = null;

      if(q.length < 2){
        results.innerHTML = "";
        return;
      }

      results.innerHTML = `<div class="iti-empty">Recherche…</div>`;

      state.timer = setTimeout(async () => {
        const rows = await smartSearch(q);
        if(seq !== searchSeq) return;

        results.innerHTML = rows.map(r => `
          <button type="button" class="iti-choice"
            data-type="${esc(r.type)}"
            data-tcl-type="${esc(r.tclType || (r.type === "stop" ? "area" : r.type))}"
            data-id="${esc(r.id || "")}"
            data-name="${esc(r.name)}"
            data-lat="${esc(r.lat)}"
            data-lon="${esc(r.lon)}">
            <strong>${esc(r.name)}</strong>
            <small>${esc(r.meta || tclTypeLabel(r.type))} · ${esc(r.address || "")}${r.distance !== undefined && r.distance !== null ? " · " + esc(r.distance) + " m" : ""}</small>
          </button>
        `).join("") || `<div class="iti-empty">Aucun résultat trouvé.</div>`;

        qsa(".iti-choice", results).forEach(btn => {
          btn.addEventListener("click", () => {
            state[key] = {
              type:btn.dataset.type,
              tclType:btn.dataset.tclType || (btn.dataset.type === "stop" ? "area" : btn.dataset.type),
              id:btn.dataset.id || null,
              name:btn.dataset.name,
              lat:Number(btn.dataset.lat),
              lon:Number(btn.dataset.lon)
            };
            input.value = btn.dataset.name;
            results.innerHTML = "";
          });
        });
      }, 180);
    }

    input.addEventListener("input", runSearch);
    input.addEventListener("keyup", runSearch);
    input.addEventListener("focus", runSearch);
  }

  async function reverseAddress(lat, lon){
    try{
      const j = await getJson(`https://api-adresse.data.gouv.fr/reverse/?lon=${encodeURIComponent(lon)}&lat=${encodeURIComponent(lat)}`);
      return j?.features?.[0]?.properties?.label || "";
    }catch(e){ return ""; }
  }

  function usePosition(){
    const input = qs("#itiFromInput");
    const out = qs("#itiOutput");

    if(!navigator.geolocation){
      if(out) out.innerHTML = `<div class="iti-error">Localisation indisponible.</div>`;
      return;
    }

    if(input) input.value = "Localisation en cours…";

    navigator.geolocation.getCurrentPosition(async pos => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const name = await reverseAddress(lat, lon) || "Position détectée";
      state.from = {type:"address", tclType:"address", id:null, name, lat, lon};
      if(input) input.value = name;
    }, () => {
      if(input) input.value = "";
      if(out) out.innerHTML = `<div class="iti-error">Localisation refusée. Saisis une adresse ou un arrêt.</div>`;
    }, {enableHighAccuracy:true, timeout:12000, maximumAge:15000});
  }

  
function itiSuggestionLabel(it){
  const type = it.type || "";
  const icon = type === "stop" ? "🚏" : "📍";
  const name = it.name || it.label || "Lieu";
  const address = it.address ? `<small>${esc(it.address)}</small>` : "";
  const dist = it.distance !== undefined && it.distance !== null ? `<em>${esc(it.distance)} m</em>` : "";
  return `${icon} <span><b>${esc(name)}</b>${address}</span>${dist}`;
}

  function itiSelectedIso(offsetMinutes){
    const date = qs("#itiDateInput")?.value || todayValue();
    const time = qs("#itiTimeInput")?.value || nowTimeValue();
    const d = new Date(`${date}T${time}:00`);
    if(Number.isFinite(Number(offsetMinutes))) d.setMinutes(d.getMinutes() + Number(offsetMinutes));
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  function itiTclType(item){
    if(!item) return "address";
    return item.tclType || (item.type === "stop" ? "area" : item.type) || "address";
  }

  function itiTclUsableId(item){
    if(!item || !item.id) return null;
    const type = itiTclType(item);
    const id = String(item.id);
    if(type === "address") return null;
    if(id.includes(";")) return null;
    return id;
  }

  function itiTclPoint(item){
    return {lat:Number(item.lat), lng:Number(item.lon)};
  }

  async function planLocalFallback(out, time, date, mode, offsetMinutes){
    const fallbackTime = offsetMinutes ? addMinutesToTime(time, offsetMinutes) : time;
    const destParams = state.to.type === "stop" && state.to.id
      ? `to_id=${encodeURIComponent(state.to.id)}`
      : `to_lat=${encodeURIComponent(state.to.lat)}&to_lon=${encodeURIComponent(state.to.lon)}`;

    const url = `/api/itineraire/plan?from_lat=${encodeURIComponent(state.from.lat)}&from_lon=${encodeURIComponent(state.from.lon)}&${destParams}&time=${encodeURIComponent(fallbackTime)}&mode=${encodeURIComponent(mode)}&date=${encodeURIComponent(date)}`;
    const data = await getJson(url);

    if(!data.ok){
      state.result = null;
      out.innerHTML = `<div class="iti-error">${esc(data.error || "Aucun itinéraire disponible.")}</div>`;
      return;
    }

    data.source = "local-fallback";
    state.result = data;
    renderResult(data);
  }

  async function plan(offsetMinutes){
    const out = qs("#itiOutput");
    if(!out) return;

    if(!state.from || !Number.isFinite(state.from.lat) || !Number.isFinite(state.from.lon)){
      out.innerHTML = `<div class="iti-error">Choisis un départ ou utilise Ma position.</div>`;
      return;
    }

    if(!state.to || !Number.isFinite(state.to.lat) || !Number.isFinite(state.to.lon)){
      out.innerHTML = `<div class="iti-error">Choisis une destination dans les propositions.</div>`;
      return;
    }

    let time = qs("#itiTimeInput")?.value || nowTimeValue();
    const date = qs("#itiDateInput")?.value || "";
    const mode = state.mode || "depart";
    out.innerHTML = `<div class="iti-loading">Calcul du meilleur itinéraire…</div>`;

    const payload = {
      from:itiTclPoint(state.from),
      to:itiTclPoint(state.to),
      fromType:itiTclType(state.from),
      fromName:state.from.name || "Départ",
      toType:itiTclType(state.to),
      toName:state.to.name || "Destination",
      datetime:itiSelectedIso(offsetMinutes || 0),
      isArrivalTime:mode === "arrive",
      transportModes:["metro","funicular","tramway","boat","bus","tod","train","car-region"],
      walk:"normal",
      bike:{type:["bike","bss"], speed:"normal", isElectric:false},
      pmr:false,
      car:true,
      carPooling:false,
      dataFreshness:false,
      algorithm:"FASTEST"
    };

    const fromId = itiTclUsableId(state.from);
    const toId = itiTclUsableId(state.to);
    if(fromId) payload.fromId = fromId;
    if(toId) payload.toId = toId;

    try{
      const official = await postJson("/api/tcl/journeys", payload);
      const rawJourneys = official?.data?.journeys || official?.journeys || [];
      const journeys = rankOfficialJourneys(filterCurrentJourneys(rawJourneys));
      if(official.ok && journeys.length){
        const result = {
          ok:true,
          source:"official",
          mode,
          requested_arrival:mode === "arrive" ? time : "",
          journeys,
          prev:official.data?.prev || null,
          next:official.data?.next || null,
          payload
        };
        state.result = result;
        renderResult(result);
        return;
      }
      if(official.ok && Array.isArray(rawJourneys)){
        state.result = null;
        out.innerHTML = `<div class="iti-error">Aucun itinéraire actuel disponible. Les trajets déjà terminés sont masqués.</div>`;
        return;
      }
      console.warn("official itinerary failed", official);
    }catch(e){
      console.error("official itinerary unavailable", e);
    }

    await planLocalFallback(out, time, date, mode, offsetMinutes);
  }


  function openRoutePopup(data){
    let pop = qs("#itiRoutePopup");

    if(!pop){
      pop = document.createElement("div");
      pop.id = "itiRoutePopup";
      pop.className = "iti-route-popup";
      document.body.appendChild(pop);
    }

    pop.innerHTML = `
      <div class="iti-route-popup-card">
        <div class="iti-route-popup-head">
          <div>
            <span>Itinéraire conseillé</span>
            <strong>${esc(data.duration_min)} min</strong>
            <p>Partir à ${esc(data.recommended_departure || data.departure)} · Arrivée ${esc(data.arrival)}</p>
          </div>
          <button type="button" data-iti-popup-close>×</button>
        </div>

        ${data.explanation ? `<div class="iti-popup-explain">${esc(data.explanation)}</div>` : ""}

        <div class="iti-popup-steps">
          ${(data.steps || []).map(stepHtml).join("")}
        </div>
      </div>
    `;

    document.body.classList.add("iti-result-modal-open");
    pop.classList.add("open");

    qs("[data-iti-popup-close]", pop)?.addEventListener("click", closeItiPopup);
    pop.addEventListener("click", e => {
      if(e.target === pop) closeItiPopup();
    }, {once:true});
  }


  function renderResult(data){
    const out = qs("#itiOutput");
    if(!out) return;

    if(Array.isArray(data.journeys)){
      renderOfficialResult(data);
      return;
    }

    out.innerHTML = `
      <section class="iti-result-hero">
        <span>${data.mode === "arrive" ? "Arriver avant " + esc(data.requested_arrival || data.arrival) : "Partir à " + esc(data.recommended_departure || data.departure)}</span>
        <strong>${esc(data.duration_min)} min</strong>
        <p>Partir à ${esc(data.recommended_departure || data.departure)} · Premier transport ${esc(data.first_boarding || "—")} · Arrivée ${esc(data.arrival)}</p>
      </section>

      ${data.explanation ? `<section class="iti-explain">${esc(data.explanation)}</section>` : ""}

      <div class="iti-actions">
        <button type="button" data-iti-earlier>Partir plus tôt</button>
        <button type="button" data-iti-later>Partir plus tard</button>
      </div>

      <section class="iti-timeline">
        ${(data.steps || []).map(stepHtml).join("")}
      </section>
    `;

    qs("[data-iti-earlier]")?.addEventListener("click", () => plan(-30));
    qs("[data-iti-later]")?.addEventListener("click", () => plan(30));

    qsa(".iti-step-card").forEach(card => {
      card.addEventListener("click", () => card.classList.toggle("open"));
    });
  }

  function tclDate(v){
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function tclHm(v){
    const d = tclDate(v);
    if(!d) return "—";
    return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
  }

  function tclMinutes(a, b){
    const da = tclDate(a);
    const db = tclDate(b);
    if(!da || !db) return 0;
    return Math.max(0, Math.round((db - da) / 60000));
  }

  function filterCurrentJourneys(journeys){
    const now = Date.now();
    return (journeys || []).filter(journey => {
      const arrival = tclDate(journey?.arrival);
      return !arrival || arrival.getTime() > now;
    });
  }

  function tclJourneyMinutes(journey){
    return tclMinutes(journey.departure, journey.arrival);
  }

  function tclModeLabel(section){
    const type = section?.type || "";
    if(type === "walk") return "Marche";
    if(type === "bike") return "Vélo";
    if(type === "car") return "Voiture";
    if(type === "public-transport" || type === "on-demand-transport"){
      return section?.line?.code ? `Ligne ${section.line.code}` : "Transport";
    }
    return "Trajet";
  }

  function tclSectionSummary(section){
    if(section?.type === "public-transport" || section?.type === "on-demand-transport"){
      return `${section?.from?.name || "Départ"} → ${section?.to?.name || "Arrivée"}`;
    }
    const len = Number(section?.length || section?.geojson?.properties?.[0]?.length || 0);
    return `${section?.from?.name || "Départ"} → ${section?.to?.name || "Arrivée"}${len ? " · " + Math.round(len) + " m" : ""}`;
  }

  function tclSectionHtml(section){
    const isTransit = section?.type === "public-transport" || section?.type === "on-demand-transport";
    const minutes = tclMinutes(section?.departure, section?.arrival);
    const line = section?.line || {};
    const bg = "#" + String(line.color || "0ea5e9").replace(/^#/, "");
    const fg = "#" + String(line.textColor || "ffffff").replace(/^#/, "");
    const equipment = [
      ...(section?.from?.equipmentDetails || []),
      ...(section?.to?.equipmentDetails || [])
    ].filter(x => x && x.status && x.status !== "available");
    const stops = Array.isArray(section?.intermediateStops) ? section.intermediateStops.length : 0;

    if(isTransit){
      return `
        <article class="iti-timeline-step transit">
          <div class="iti-line-badge" style="--line-bg:${esc(bg)};--line-fg:${esc(fg)}">${esc(line.code || "TCL")}</div>
          <div class="iti-step-card" role="button" tabindex="0">
            <div class="iti-step-title">
              <strong>${esc(tclHm(section.departure))} → ${esc(tclHm(section.arrival))}</strong>
              <span>${esc(minutes)} min</span>
            </div>
            <p>${esc(tclSectionSummary(section))}</p>
            <small>Direction ${esc(section.headsign || section.direction?.name || "non précisée")}</small>
            <div class="iti-step-more">
              <div><strong>Ligne :</strong> ${esc(line.code || "TCL")}</div>
              <div><strong>Mode :</strong> ${esc(line.mode || "transport")}</div>
              <div><strong>Montée :</strong> ${esc(section?.from?.name || "—")} à ${esc(tclHm(section.departure))}</div>
              <div><strong>Descente :</strong> ${esc(section?.to?.name || "—")} à ${esc(tclHm(section.arrival))}</div>
              <div><strong>Arrêts intermédiaires :</strong> ${esc(stops)}</div>
              ${equipment.length ? `<div><strong>Info accessibilité :</strong> ${esc(equipment.map(x => x.name || x.cause || "Équipement indisponible").join(" · "))}</div>` : ""}
            </div>
          </div>
        </article>
      `;
    }

    return `
      <article class="iti-timeline-step walk">
        <div class="iti-dot">${section?.type === "bike" ? "◇" : "↗"}</div>
        <div class="iti-step-card" role="button" tabindex="0">
          <div class="iti-step-title">
            <strong>${esc(tclModeLabel(section))}</strong>
            <span>${esc(minutes)} min</span>
          </div>
          <p>${esc(tclSectionSummary(section))}</p>
          <small>${esc(tclHm(section?.departure))} → ${esc(tclHm(section?.arrival))}</small>
          <div class="iti-step-more">
            ${(section?.directions || []).slice(0,6).map(d => `<div>${esc(d.instruction || d.name || "")}</div>`).join("") || `<div>${esc(tclSectionSummary(section))}</div>`}
          </div>
        </div>
      </article>
    `;
  }

  function tclJourneyLines(journey){
    return (journey.sections || [])
      .filter(s => s.line?.code)
      .map(s => s.line.code)
      .filter((v, i, a) => a.indexOf(v) === i);
  }

  function tclJourneyModes(journey){
    return (journey.sections || [])
      .map(s => {
        if(s.type === "public-transport" || s.type === "on-demand-transport") return s.line?.code || "TCL";
        if(s.type === "walk") return "Marche";
        if(s.type === "bike") return "Vélo";
        if(s.type === "car") return "Voiture";
        return "Trajet";
      })
      .filter((v, i, a) => a.indexOf(v) === i);
  }

  function tclMainTitle(journey){
    const lines = tclJourneyLines(journey);
    if(lines.length) return lines.join(" + ");
    const first = (journey.sections || []).find(s => s.type && s.type !== "walk") || (journey.sections || [])[0];
    return tclModeLabel(first || {});
  }

  function tclTransferCount(journey){
    const transportSections = (journey.sections || []).filter(s => s.type === "public-transport" || s.type === "on-demand-transport");
    return Math.max(0, transportSections.length - 1);
  }


  function tclIsTransitSection(section){
    const type = section?.type || "";
    return type === "public-transport" || type === "on-demand-transport";
  }

  function tclJourneyStats(journey){
    const sections = journey?.sections || [];
    const transitSections = sections.filter(tclIsTransitSection);
    const transitCount = transitSections.length;
    const transfers = Math.max(0, transitCount - 1);
    const lines = transitSections.map(s => s.line?.code).filter(Boolean);
    let walkMinutes = 0;
    let bikeMinutes = 0;
    let hasBike = false;
    let hasCar = false;

    for(const section of sections){
      const minutes = tclMinutes(section?.departure, section?.arrival);
      const type = section?.type || "";
      if(type === "walk") walkMinutes += minutes;
      else if(type === "bike"){ hasBike = true; bikeMinutes += minutes; }
      else if(type === "car") hasCar = true;
    }

    return {
      transitCount,
      transfers,
      lines,
      walkMinutes,
      bikeMinutes,
      hasBike,
      hasCar,
      totalMinutes: tclJourneyMinutes(journey),
      isTclExploitable: transitCount > 0,
      isNonTclOnly: transitCount === 0
    };
  }

  function tclJourneyScore(journey){
    const stats = tclJourneyStats(journey);
    let score = 0;

    if(stats.isTclExploitable) score -= 100000;
    else score += 500000;

    score += stats.totalMinutes * 100;
    score += stats.transfers * 900;
    score += stats.walkMinutes * 45;
    score += stats.bikeMinutes * 250;
    if(stats.hasCar) score += 4000;
    if(stats.transitCount === 1) score -= 700;

    return score;
  }

  function tclCompareJourneyScore(a, b){
    const diff = tclJourneyScore(a) - tclJourneyScore(b);
    if(diff !== 0) return diff;
    const depA = tclDate(a?.departure)?.getTime() || 0;
    const depB = tclDate(b?.departure)?.getTime() || 0;
    return depA - depB;
  }

  function tclIsTclJourneyRelevant(bestTcl, bestNonTcl){
    if(!bestTcl) return false;
    if(!bestNonTcl) return true;
    const tclMin = tclJourneyMinutes(bestTcl);
    const altMin = Math.max(1, tclJourneyMinutes(bestNonTcl));
    const delta = tclMin - altMin;
    const ratio = tclMin / altMin;
    if(delta >= 45) return false;
    if(ratio >= 2.4 && delta >= 25) return false;
    return true;
  }

  function prepareOfficialJourneyPresentation(journeys){
    const tcl = [];
    const nonTcl = [];
    for(const journey of (journeys || [])){
      if(tclJourneyStats(journey).isTclExploitable) tcl.push(journey);
      else nonTcl.push(journey);
    }

    const rankedTcl = [...tcl].sort(tclCompareJourneyScore);
    const rankedNonTcl = [...nonTcl].sort(tclCompareJourneyScore);
    const tclRelevant = tclIsTclJourneyRelevant(rankedTcl[0], rankedNonTcl[0]);

    const recommended = tclRelevant ? (rankedTcl[0] || null) : null;
    const tclOptions = tclRelevant ? rankedTcl.slice(1, 5) : rankedTcl.slice(0, 5);
    const alternatives = rankedNonTcl.slice(0, 5);
    const centerJourney = recommended || rankedTcl[0] || rankedNonTcl[0] || null;

    return {
      tclRelevant,
      recommended,
      tclOptions,
      alternatives,
      centerJourney,
      allJourneys: [...rankedTcl, ...rankedNonTcl]
    };
  }

  function rankOfficialJourneys(journeys){
    return prepareOfficialJourneyPresentation(journeys).allJourneys;
  }

  function tclJourneyCardHtml(journey, idx, options){
    options = options || {};
    const minutes = tclJourneyMinutes(journey);
    const modes = tclJourneyModes(journey);
    const transfers = tclTransferCount(journey);
    const from = journey.sections?.[0]?.from?.name || "Départ";
    const last = journey.sections?.[journey.sections.length - 1];
    const to = last?.to?.name || "Arrivée";
    const journeyKey = options.journeyKey != null ? options.journeyKey : idx;
    const kicker = options.kicker || (idx === 0 ? "Recommandé" : "Option " + (Number(idx) + 1));
    const bestClass = options.recommended ? "best" : "";

    return `
      <button type="button" class="iti-journey-card ${bestClass}" data-iti-journey="${esc(journeyKey)}">
        <span class="iti-journey-kicker">${esc(kicker)}</span>
        <div class="iti-journey-main">
          <strong>${esc(tclMainTitle(journey))}</strong>
          <em>${esc(minutes)} min</em>
        </div>
        <p>${esc(tclHm(journey.departure))} ${esc(from)} → ${esc(tclHm(journey.arrival))} ${esc(to)}</p>
        <div class="iti-journey-meta">
          <span>${esc(transfers)} correspondance${transfers > 1 ? "s" : ""}</span>
          <span>${esc(modes.join(" · "))}</span>
        </div>
      </button>
    `;
  }

  function renderOfficialResult(data){
    const out = qs("#itiOutput");
    if(!out) return;
    const presentation = prepareOfficialJourneyPresentation(data.journeys || []);
    const { recommended, tclOptions, alternatives, centerJourney } = presentation;

    if(!centerJourney){
      out.innerHTML = `<div class="iti-error">Aucun itinéraire disponible.</div>`;
      return;
    }

    const cards = [];
    const journeyByKey = {};
    let optionNo = 2;

    if(recommended){
      const key = "rec";
      journeyByKey[key] = recommended;
      cards.push(tclJourneyCardHtml(recommended, 0, { recommended: true, kicker: "Recommandé", journeyKey: key }));
    } else if((data.journeys || []).some(j => tclJourneyStats(j).isTclExploitable)){
      cards.push(`<div class="iti-explain">Aucun trajet TCL vraiment pertinent trouvé.</div>`);
    }

    for(const journey of tclOptions){
      const key = "tcl-" + cards.length;
      journeyByKey[key] = journey;
      const kicker = recommended ? ("Option " + optionNo++) : ("Trajet TCL " + (cards.length));
      cards.push(tclJourneyCardHtml(journey, cards.length, { kicker, journeyKey: key }));
    }

    if(alternatives.length){
      cards.push(`<p class="iti-section-note">Alternatives hors TCL</p>`);
      alternatives.forEach((journey, i) => {
        const key = "alt-" + i;
        journeyByKey[key] = journey;
        cards.push(tclJourneyCardHtml(journey, cards.length, { kicker: "Alternative " + (i + 1), journeyKey: key }));
      });
    }

    const centerTime = tclHm(centerJourney.departure);
    out.innerHTML = `
      <section class="iti-result-toolbar" aria-label="Navigation des résultats">
        <button type="button" data-iti-earlier>‹ Plus tôt</button>
        <strong>Résultats à ${esc(centerTime)}</strong>
        <button type="button" data-iti-later>Plus tard ›</button>
      </section>
      <section class="iti-journey-list" aria-label="Trajets proposés">
        ${cards.join("")}
      </section>
    `;

    qs("[data-iti-earlier]")?.addEventListener("click", () => plan(-30));
    qs("[data-iti-later]")?.addEventListener("click", () => plan(30));

    qsa("[data-iti-journey]", out).forEach(card => {
      card.addEventListener("click", () => {
        const key = card.dataset.itiJourney || "";
        openOfficialJourneySheet(journeyByKey[key], data);
      });
    });
  }

  function openOfficialJourneySheet(journey, result){
    if(!journey) return;
    let pop = qs("#itiRoutePopup");
    if(!pop){
      pop = document.createElement("div");
      pop.id = "itiRoutePopup";
      pop.className = "iti-route-popup";
      document.body.appendChild(pop);
    }

    const minutes = tclJourneyMinutes(journey);
    const transfers = tclTransferCount(journey);
    const sections = journey.sections || [];
    const from = sections[0]?.from?.name || result?.payload?.fromName || "Départ";
    const to = sections[sections.length - 1]?.to?.name || result?.payload?.toName || "Arrivée";

    pop.innerHTML = `
      <div class="iti-route-popup-card" role="dialog" aria-modal="true" aria-label="Détail de l’itinéraire">
        <div class="iti-sheet-grabber" aria-hidden="true"></div>
        <div class="iti-route-popup-head">
          <div>
            <span>${esc(tclMainTitle(journey))}</span>
            <strong>${esc(minutes)} min</strong>
            <p>${esc(tclHm(journey.departure))} ${esc(from)} → ${esc(tclHm(journey.arrival))} ${esc(to)} · ${esc(transfers)} correspondance${transfers > 1 ? "s" : ""}</p>
          </div>
          <button type="button" data-iti-popup-close aria-label="Fermer">×</button>
        </div>
        <div class="iti-popup-actions">
          <button type="button" data-iti-download>Télécharger l’itinéraire</button>
        </div>
        <section class="iti-popup-steps iti-timeline">
          ${sections.map(tclSectionHtml).join("")}
        </section>
      </div>
    `;

    document.body.classList.add("iti-result-modal-open");
    pop.classList.add("open");

    qs("[data-iti-popup-close]", pop)?.addEventListener("click", closeItiPopup);
    qs("[data-iti-download]", pop)?.addEventListener("click", () => downloadOfficialJourney(journey, result));
    pop.addEventListener("click", e => { if(e.target === pop) closeItiPopup(); });
    qsa(".iti-step-card", pop).forEach(card => card.classList.add("open"));
  }

  function offlineHtmlEscape(v){
    return String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
  }

  function offlineSectionHtml(section){
    const isTransit = section?.type === "public-transport" || section?.type === "on-demand-transport";
    const title = isTransit ? `Ligne ${section?.line?.code || "TCL"}` : tclModeLabel(section || {});
    const detail = isTransit
      ? `Direction ${section?.headsign || section?.direction?.name || "non précisée"}`
      : tclSectionSummary(section || {});
    const distance = section?.length || section?.geojson?.properties?.[0]?.length;
    return `
      <section class="step">
        <h2>${offlineHtmlEscape(title)} <span>${offlineHtmlEscape(tclMinutes(section?.departure, section?.arrival))} min</span></h2>
        <p>${offlineHtmlEscape(section?.from?.name || "Départ")} → ${offlineHtmlEscape(section?.to?.name || "Arrivée")}</p>
        <p>${offlineHtmlEscape(tclHm(section?.departure))} → ${offlineHtmlEscape(tclHm(section?.arrival))}</p>
        <p>${offlineHtmlEscape(detail)}</p>
        ${distance ? `<p>${offlineHtmlEscape(Math.round(Number(distance)))} m</p>` : ""}
      </section>
    `;
  }

  function downloadOfficialJourney(journey, result){
    const sections = journey.sections || [];
    const from = sections[0]?.from?.name || result?.payload?.fromName || "Départ";
    const to = sections[sections.length - 1]?.to?.name || result?.payload?.toName || "Arrivée";
    const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Itinéraire TCL</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f4f7fb;color:#0f172a;padding:24px}
.card,.step{background:#fff;border:1px solid #dbe4ef;border-radius:22px;padding:18px;margin:0 0 14px;box-shadow:0 12px 30px rgba(15,23,42,.08)}
h1{font-size:30px;margin:0 0 8px}.meta{color:#475569;font-weight:700}.step h2{display:flex;justify-content:space-between;gap:16px;font-size:18px;margin:0 0 8px}.step p{margin:6px 0;color:#334155;font-weight:650}
</style></head><body>
<main>
<section class="card">
<h1>${offlineHtmlEscape(tclMainTitle(journey))}</h1>
<p class="meta">Départ : ${offlineHtmlEscape(from)}</p>
<p class="meta">Destination : ${offlineHtmlEscape(to)}</p>
<p class="meta">Date et heure : ${offlineHtmlEscape(tclDate(journey.departure)?.toLocaleString("fr-FR", {dateStyle:"full", timeStyle:"short"}) || tclHm(journey.departure))}</p>
<p class="meta">Durée totale : ${offlineHtmlEscape(tclJourneyMinutes(journey))} min</p>
<p class="meta">Départ ${offlineHtmlEscape(tclHm(journey.departure))} · Arrivée ${offlineHtmlEscape(tclHm(journey.arrival))}</p>
<p class="meta">Correspondances : ${offlineHtmlEscape(tclTransferCount(journey))}</p>
<p class="meta">Calculé avec le moteur TCL</p>
</section>
${sections.map(offlineSectionHtml).join("")}
</main></body></html>`;

    const blob = new Blob([html], {type:"text/html;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `itineraire-tcl-${Date.now()}.html`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  function stepHtml(s){
    if(s.type === "walk"){
      return `
        <article class="iti-timeline-step walk">
          <div class="iti-dot">↗</div>
          <div class="iti-step-card" role="button" tabindex="0">
            <div class="iti-step-title">
              <strong>${esc(s.label || "Marcher")}</strong>
              <span>${esc(s.duration_min)} min</span>
            </div>
            <p>De ${esc(s.from)} à ${esc(s.to)}</p>
            <small>${s.distance_m ? esc(s.distance_m) + " m" : "À pied"}</small>
            <div class="iti-step-more">Départ ${esc(s.dep || "")} · Arrivée ${esc(s.arr || "")}</div>
          </div>
        </article>
      `;
    }

    return `
      <article class="iti-timeline-step transit">
        <div class="iti-line-badge" style="--line-bg:${esc(s.color || "#0ea5e9")};--line-fg:${esc(s.text_color || "#fff")}">${esc(s.line)}</div>
        <div class="iti-step-card" role="button" tabindex="0">
          <div class="iti-step-title">
            <strong>${esc(s.dep)} → ${esc(s.arr)}</strong>
            <span>${esc(s.stops_count || 1)} arrêt${Number(s.stops_count || 1) > 1 ? "s" : ""}</span>
          </div>
          <p>${esc(s.from)} → ${esc(s.to)}</p>
          <small>Direction ${esc(s.headsign || "non précisée")}</small>
          <div class="iti-step-more">
            <div><strong>Ligne :</strong> ${esc(s.line)}</div>
            <div><strong>Direction :</strong> ${esc(s.headsign || "non précisée")}</div>
            <div><strong>Montée :</strong> ${esc(s.from)} à ${esc(s.dep || "")}</div>
            <div><strong>Descente :</strong> ${esc(s.to)} à ${esc(s.arr || "")}</div>
            <div><strong>Nombre d'arrêts :</strong> ${esc(s.stops_count || 0)}</div>
            <div><strong>Temps à bord :</strong> ${esc(s.duration_min || 0)} min</div>
          </div>
        </div>
      </article>
    `;
  }

  document.addEventListener("click", e => {
    const nav = e.target.closest?.('[data-section="itineraire"]');
    if(nav){
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    }
  }, true);

  window.__itiPlan = plan;
  window.v7Itineraire = {open:openPanel, close:closePanel};
})();


/* HOTFIX 20260617 — Navigation Info trafic : retour détail -> liste */
(function(){
  function q(s){ return document.querySelector(s); }

  function trafficHasList(){
    return !!q("#trafficList");
  }

  function showTrafficList(){
    const title = q("#trafficTitle");
    const content = q("#trafficContent");
    if(title) title.textContent = "Info trafic";
    if(content && !trafficHasList()){
      content.innerHTML = '<div id="trafficList"></div>';
    }
    try {
      if(typeof loadTraffic === "function") loadTraffic();
    } catch(e) {
      console.warn("Retour liste trafic impossible", e);
    }
  }

  const oldOpenTrafficPage = window.openTrafficPage;
  if(typeof oldOpenTrafficPage === "function" && !window.__v7TrafficBackFixed){
    window.openTrafficPage = function(line){
      document.body.classList.add("traffic-detail-open");
      return oldOpenTrafficPage.apply(this, arguments);
    };
  }

  document.addEventListener("click", function(e){
    const back = e.target.closest && e.target.closest("#trafficBack");
    if(back && document.body.classList.contains("traffic-open")){
      if(document.body.classList.contains("traffic-detail-open") || !trafficHasList()){
        e.preventDefault();
        e.stopImmediatePropagation();
        document.body.classList.remove("traffic-detail-open");
        showTrafficList();
      }
    }

    const traficNav = e.target.closest && e.target.closest('[data-section="trafic"],[data-section="traffic"]');
    if(traficNav){
      document.body.classList.remove("traffic-detail-open");
      setTimeout(showTrafficList, 80);
    }
  }, true);

  window.__v7TrafficBackFixed = true;
})();


/* HOTFIX 20260617 — Info trafic : catégories repliables */
(function(){
  function enhanceTrafficAccordion(){
    const list = document.querySelector("#trafficList");
    if(!list) return;

    list.querySelectorAll(".v7-traffic-group").forEach(group => {
      if(group.classList.contains("traffic-accordion-ready")) return;

      group.classList.add("traffic-accordion-ready");
      group.classList.remove("is-open");

      const title = group.querySelector(".v7-traffic-group-title");
      const grid = group.querySelector(".v7-traffic-grid");

      if(title){
        title.setAttribute("role", "button");
        title.setAttribute("tabindex", "0");
        title.setAttribute("aria-expanded", "false");
      }
      if(grid){
        grid.setAttribute("aria-hidden", "true");
      }
    });
  }

  document.addEventListener("click", function(e){
    const title = e.target.closest && e.target.closest(".v7-traffic-group-title");
    if(!title || !document.body.classList.contains("traffic-open")) return;

    const group = title.closest(".v7-traffic-group");
    if(!group) return;

    const grid = group.querySelector(".v7-traffic-grid");
    const open = !group.classList.contains("is-open");

    group.classList.toggle("is-open", open);
    title.setAttribute("aria-expanded", open ? "true" : "false");
    if(grid) grid.setAttribute("aria-hidden", open ? "false" : "true");
  }, true);

  document.addEventListener("keydown", function(e){
    if(e.key !== "Enter" && e.key !== " ") return;
    const title = e.target.closest && e.target.closest(".v7-traffic-group-title");
    if(!title) return;
    e.preventDefault();
    title.click();
  }, true);

  const obs = new MutationObserver(() => enhanceTrafficAccordion());
  obs.observe(document.documentElement, {childList:true, subtree:true});
  window.addEventListener("load", enhanceTrafficAccordion);
  setInterval(enhanceTrafficAccordion, 800);
})();
