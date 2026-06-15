from datetime import datetime
import re
import bisect, heapq, math, unicodedata, json, time, urllib.parse, urllib.request, json, time, urllib.parse, urllib.request, json, time, urllib.parse, urllib.request

import tcl_horaires_module as h
import tcl_places_index

WALK_SPEED_MPS = 1.25
MAX_WALK_START_M = 1200
MAX_WALK_TRANSFER_M = 90
MAX_SCAN_EVENTS = 220
PLACE_SEARCH_RADIUS_M = 45000
_PLACE_CACHE = {}

_CACHE = {}

def _norm(v):
    v = str(v or "").strip().lower()
    v = unicodedata.normalize("NFD", v)
    v = "".join(c for c in v if unicodedata.category(c) != "Mn")
    return "".join(c for c in v if c.isalnum())

def _dist_m(a, b, c, d):
    R = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dp = math.radians(c-a)
    dl = math.radians(d-b)
    x = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.atan2(math.sqrt(x), math.sqrt(1-x))

def _time_to_s(v):
    if not v:
        return datetime.now().hour*3600 + datetime.now().minute*60 + datetime.now().second
    if v == "now":
        return datetime.now().hour*3600 + datetime.now().minute*60 + datetime.now().second
    hh, mm = [int(x) for x in str(v)[:5].split(":")]
    return hh*3600 + mm*60

def _fmt_s(s):
    s = int(s) % 86400
    return f"{s//3600:02d}:{(s%3600)//60:02d}"

def _stations():
    h._ensure_index()
    return h._CACHE["stations"]

def search(q="", limit=12, lat=None, lon=None):
    h._ensure_index()
    qn = _norm(q)
    limit = int(limit or 12)
    out = []

    looks_like_commerce, q_tokens, commerce_words = _is_commerce_query(q)
    brand_tokens = q_tokens & commerce_words

    for st in h._CACHE["stations"].values():
        key = st.get("key") or _norm(st.get("name"))
        if not qn or qn in key:
            if looks_like_commerce and not any(t in key for t in brand_tokens):
                continue

            rank = 0 if key == qn else (1 if key.startswith(qn) else 2)
            item = {
                "type": "stop",
                "id": st["id"],
                "name": st["name"],
                "address": "Arrêt TCL",
                "lat": st["lat"],
                "lon": st["lon"],
                "rank": rank
            }
            if lat is not None and lon is not None:
                try:
                    item["distance"] = round(_dist_m(float(lat), float(lon), st["lat"], st["lon"]))
                except Exception:
                    pass
            out.append(item)

    out.sort(key=lambda x: (x.get("rank", 9), x.get("distance", 999999), x["name"]))
    for x in out:
        x.pop("rank", None)

    places = _geocode_places(q, lat=lat, lon=lon, limit=limit) if qn else []
    merged = places + out if looks_like_commerce else out + places

    seen = set()
    results = []
    for item in merged:
        k = (item.get("type"), item.get("id"), _norm(item.get("name")), round(float(item.get("lat") or 0), 5), round(float(item.get("lon") or 0), 5))
        if k in seen:
            continue
        seen.add(k)
        results.append(item)

    return {"ok": True, "results": results[:limit]}



def _geocode_places(q, lat=None, lon=None, limit=8):
    q = str(q or "").strip()
    if len(q) < 2:
        return []

    try:
        flat = float(lat) if lat is not None else 45.7640
        flon = float(lon) if lon is not None else 4.8357
    except Exception:
        flat, flon = 45.7640, 4.8357

    try:
        limit = max(1, min(int(limit), 12))
    except Exception:
        limit = 8

    def clean(v):
        return " ".join(str(v or "").replace("-", " ").split())

    queries = []
    base = clean(q)
    queries.append(base)

    # Variantes utiles pour enseignes / commerces mal nommés.
    variants = [
        base.replace("baguettes", "baguette"),
        base.replace("gourmandises", "gourmandise"),
        base.replace("st genis", "saint genis"),
        base.replace("saint-genis", "saint genis"),
        base + " lyon",
        base + " oullins",
        base + " la mulatiere",
        base + " saint genis laval",
    ]
    for v in variants:
        v = clean(v)
        if v and v.lower() not in [x.lower() for x in queries]:
            queries.append(v)

    key = ("|".join(queries).lower(), round(flat, 3), round(flon, 3), limit)
    now = time.time()
    cached = _PLACE_CACHE.get(key)
    if cached and now - cached[0] < 900:
        return cached[1]

    out = []
    seen = set()

    def add_result(name, address, plat, plon, source="geocode"):
        try:
            plat = float(plat); plon = float(plon)
        except Exception:
            return
        d = _dist_m(flat, flon, plat, plon)
        if d > PLACE_SEARCH_RADIUS_M:
            return
        sig = (round(plat, 5), round(plon, 5), str(name).lower())
        if sig in seen:
            return
        seen.add(sig)
        out.append({
            "type": "place",
            "id": "",
            "name": name or address or q,
            "address": address or "",
            "lat": plat,
            "lon": plon,
            "distance": round(d),
            "source": source
        })

    # 1) Nominatim, avec biais local.
    for qq in queries[:6]:
        params = {
            "q": qq,
            "format": "jsonv2",
            "addressdetails": "1",
            "limit": str(limit),
            "countrycodes": "fr",
            "accept-language": "fr",
            "viewbox": f"{flon-0.65},{flat+0.55},{flon+0.65},{flat-0.55}",
            "bounded": "0",
        }
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tcltempsreel-v7-search/1.0"})
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception:
            data = []

        for row in data:
            addr = row.get("address") or {}
            city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("municipality") or ""
            road = addr.get("road") or addr.get("pedestrian") or addr.get("suburb") or ""
            house = addr.get("house_number") or ""
            display = row.get("display_name") or qq
            name = row.get("name") or display.split(",")[0]
            address = ", ".join(x for x in [f"{house} {road}".strip(), city] if x) or display
            add_result(name, address, row.get("lat"), row.get("lon"), "nominatim")

        if len(out) >= limit:
            break

    # 2) Photon/Komoot fallback, souvent meilleur sur POI.
    if len(out) < limit:
        for qq in queries[:5]:
            params = {
                "q": qq,
                "limit": str(limit),
                "lat": str(flat),
                "lon": str(flon),
                "lang": "fr",
            }
            url = "https://photon.komoot.io/api/?" + urllib.parse.urlencode(params)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "tcltempsreel-v7-search/1.0"})
                with urllib.request.urlopen(req, timeout=5) as r:
                    data = json.loads(r.read().decode("utf-8"))
            except Exception:
                data = {}

            for feat in data.get("features", []):
                props = feat.get("properties") or {}
                coords = (feat.get("geometry") or {}).get("coordinates") or []
                if len(coords) < 2:
                    continue
                name = props.get("name") or qq
                city = props.get("city") or props.get("district") or props.get("county") or ""
                street = props.get("street") or ""
                housenumber = props.get("housenumber") or ""
                address = ", ".join(x for x in [f"{housenumber} {street}".strip(), city] if x)
                add_result(name, address, coords[1], coords[0], "photon")

            if len(out) >= limit:
                break

    def relevance(item):
        name = clean(item.get("name", "")).lower()
        address = clean(item.get("address", "")).lower()
        hay = (name + " " + address).strip()
        query = clean(q).lower()
        tokens = [t for t in query.split() if len(t) > 1]

        score = 0

        if query and query in name:
            score -= 5000
        elif query and query in hay:
            score -= 3000

        for t in tokens:
            if t in name:
                score -= 700
            elif t in hay:
                score -= 250
            else:
                score += 450

        # Bonus fort si le nom contient plusieurs mots demandés.
        name_hits = sum(1 for t in tokens if t in name)
        if tokens:
            ratio = name_hits / max(1, len(tokens))
            score -= int(ratio * 1800)

        # La distance reste importante, mais après la pertinence texte.
        score += int(item.get("distance") or 999999) // 8

        return score

    out.sort(key=lambda x: (relevance(x), x.get("distance", 999999), x.get("name", "")))
    out = out[:limit]
    _PLACE_CACHE[key] = (now, out)
    return out



def _label_city(label):
    label = str(label or "")
    m = re.search(r"\(([^)]+)\)\s*$", label)
    return m.group(1) if m else ""

def _split_tcl_coord(v):
    try:
        lon, lat = [float(x) for x in str(v).split(";")[:2]]
        return lat, lon
    except Exception:
        return None, None

def _http_json(url, timeout=5):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 tcltempsreel-v7/1.0",
        "Accept": "application/json",
        "Referer": "https://www.tcl.fr/"
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))

def _is_commerce_query(q):
    commerce_words = {
        "feu", "vert", "monoprix", "carrefour", "auchan", "boulangerie",
        "baguette", "baguettes", "gourmandise", "gourmandises", "cpam",
        "pharmacie", "restaurant", "garage", "norauto", "midas", "leclerc",
        "intermarche", "lidl", "aldi", "boulanger", "darty"
    }
    tokens = set(re.findall(r"[a-z0-9]+", _norm(q))) | set(re.findall(r"[a-z0-9]+", str(q).lower()))
    return bool(tokens & commerce_words), tokens, commerce_words

def _search_tcl_places(q, lat=None, lon=None, limit=10):
    q = str(q or "").strip()
    if len(q) < 2:
        return []

    try:
        flat = float(lat) if lat is not None else 45.7640
        flon = float(lon) if lon is not None else 4.8357
    except Exception:
        flat, flon = 45.7640, 4.8357

    url = "https://www.tcl.fr/api/navitia/search-places?" + urllib.parse.urlencode({"q": q})
    try:
        data = _http_json(url, timeout=5)
    except Exception:
        data = []

    stations = _stations()
    out = []

    for row in data if isinstance(data, list) else []:
        rid = str(row.get("id") or "")
        label = str(row.get("label") or "")
        typ = str(row.get("type") or "")
        item = None

        if typ == "stop_area" and "SYTNEX:" in rid:
            sid = rid.split("SYTNEX:", 1)[1]
            st = stations.get(sid)
            if st:
                item = {
                    "type": "stop",
                    "id": sid,
                    "name": st["name"],
                    "address": "Arrêt TCL" + (f" · {_label_city(label)}" if _label_city(label) else ""),
                    "lat": st["lat"],
                    "lon": st["lon"],
                    "source": "tcl"
                }

        elif typ in ("address", "poi", "administrative_region"):
            plat, plon = _split_tcl_coord(rid)
            if plat is not None and plon is not None:
                item = {
                    "type": "place",
                    "id": "",
                    "name": label.split(" (")[0] or q,
                    "address": label,
                    "lat": plat,
                    "lon": plon,
                    "source": "tcl"
                }

        if item:
            try:
                d = _dist_m(flat, flon, float(item["lat"]), float(item["lon"]))
                if d <= PLACE_SEARCH_RADIUS_M:
                    item["distance"] = round(d)
                    out.append(item)
            except Exception:
                pass

    return out[:limit]

def _geocode_places(q, lat=None, lon=None, limit=10):
    q = str(q or "").strip()
    if len(q) < 2:
        return []

    try:
        flat = float(lat) if lat is not None else 45.7640
        flon = float(lon) if lon is not None else 4.8357
    except Exception:
        flat, flon = 45.7640, 4.8357

    limit = max(1, min(int(limit or 10), 12))
    # La clé utilise des coordonnées arrondies à 1 décimale (≈11km) pour maximiser les hits
    # de cache indépendamment de la position exacte de l'utilisateur dans l'aire lyonnaise.
    key = ("global", q.lower(), round(flat, 1), round(flon, 1), limit)
    now = time.time()
    cached = _PLACE_CACHE.get(key)
    if cached and now - cached[0] < 900:
        return cached[1]

    looks_like_commerce, q_tokens, commerce_words = _is_commerce_query(q)
    brand_tokens = q_tokens & commerce_words

    out = []
    seen = set()

    def add(item):
        if not item:
            return
        try:
            d = _dist_m(flat, flon, float(item["lat"]), float(item["lon"]))
        except Exception:
            return
        if d > PLACE_SEARCH_RADIUS_M:
            return
        item["distance"] = round(d)
        sig = (round(float(item["lat"]), 5), round(float(item["lon"]), 5), _norm(item.get("name")))
        if sig in seen:
            return
        seen.add(sig)
        out.append(item)

    tcl_items = _search_tcl_places(q, lat=flat, lon=flon, limit=limit)
    if looks_like_commerce:
        tcl_items = [
            x for x in tcl_items
            if x.get("type") != "stop" or any(t in _norm(x.get("name")) for t in brand_tokens)
        ][:3]

    for item in tcl_items:
        add(item)

    variants = []
    for v in [
        q,
        q.replace("baguettes", "baguette"),
        q.replace("gourmandises", "gourmandise"),
        q.replace("st genis", "saint genis"),
        q.replace("saint-genis", "saint genis"),
        q + " Lyon",
        q + " Oullins",
        q + " La Mulatière",
        q + " Saint-Genis-Laval",
    ]:
        v = " ".join(v.split())
        if v and v.lower() not in [x.lower() for x in variants]:
            variants.append(v)

    # Nominatim
    for qq in variants:
        params = {
            "q": qq,
            "format": "jsonv2",
            "addressdetails": "1",
            "limit": str(limit),
            "countrycodes": "fr",
            "accept-language": "fr",
            "viewbox": f"{flon-0.70},{flat+0.55},{flon+0.70},{flat-0.55}",
            "bounded": "0",
        }
        try:
            data = _http_json("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params), timeout=5)
        except Exception:
            data = []
        for row in data if isinstance(data, list) else []:
            addr = row.get("address") or {}
            city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("municipality") or ""
            road = addr.get("road") or addr.get("pedestrian") or addr.get("suburb") or ""
            house = addr.get("house_number") or ""
            display = row.get("display_name") or qq
            name = row.get("name") or display.split(",")[0]
            address = ", ".join(x for x in [f"{house} {road}".strip(), city] if x) or display
            add({"type":"place","id":"","name":name,"address":address,"lat":float(row.get("lat")),"lon":float(row.get("lon")),"source":"nominatim"})

    # Photon, meilleur sur commerces/POI
    for qq in variants:
        params = {"q": qq, "limit": str(limit), "lat": str(flat), "lon": str(flon), "lang": "fr"}
        try:
            data = _http_json("https://photon.komoot.io/api/?" + urllib.parse.urlencode(params), timeout=5)
        except Exception:
            data = {}
        for feat in data.get("features", []) if isinstance(data, dict) else []:
            props = feat.get("properties") or {}
            coords = (feat.get("geometry") or {}).get("coordinates") or []
            if len(coords) < 2:
                continue
            name = props.get("name") or qq
            city = props.get("city") or props.get("district") or props.get("county") or ""
            street = props.get("street") or ""
            housenumber = props.get("housenumber") or ""
            address = ", ".join(x for x in [f"{housenumber} {street}".strip(), city] if x)
            add({"type":"place","id":"","name":name,"address":address,"lat":float(coords[1]),"lon":float(coords[0]),"source":"photon"})

    def clean(v):
        return " ".join(str(v or "").lower().replace("-", " ").split())

    def relevance(item):
        query = clean(q)
        name = clean(item.get("name"))
        address = clean(item.get("address"))
        hay = name + " " + address
        tokens = [t for t in query.split() if len(t) > 1]
        score = 0

        if item.get("type") == "stop":
            if any(t in name for t in tokens):
                score -= 2500
            else:
                score += 6000

        if query and name == query:
            score -= 9000
        elif query and name.startswith(query):
            score -= 7000
        elif query and query in name:
            score -= 5500
        elif query and query in hay:
            score -= 3500

        for t in tokens:
            if t in name:
                score -= 900
            elif t in hay:
                score -= 300
            else:
                score += 1200

        if tokens and not any(t in hay for t in tokens):
            score += 9000

        score += int(item.get("distance") or 999999) // 18
        return score

    out.sort(key=lambda x: (relevance(x), x.get("distance", 999999), x.get("name", "")))
    out = out[:limit]
    _PLACE_CACHE[key] = (now, out)
    return out

def _build_graph():
    if "events_by_station" in _CACHE:
        return

    h._ensure_index()
    c = h._CACHE
    stations = c["stations"]
    stops = c["stops"]
    stop_to_station = c["stop_to_station"]
    trips = c["trips"]
    routes = c["routes"]
    trip_stops = c["trip_stops"]
    active = c["active_trips"]

    events_by_station = {}
    event_times = {}

    for tid in active:
        t = trips.get(tid)
        if not t:
            continue
        r = routes.get(t["route_id"])
        if not r:
            continue

        seq = trip_stops.get(tid) or []
        if len(seq) < 2:
            continue

        for i in range(len(seq)-1):
            seq_i, sid_a, dep_a = seq[i]
            seq_j, sid_b, dep_b = seq[i+1]

            try:
                if h._is_terminal_arrival_call(tid, seq_i):
                    continue
                ha, ma, sa = [int(x) for x in dep_a.split(":")]
                hb, mb, sb = [int(x) for x in dep_b.split(":")]
            except Exception:
                continue

            dep_s = ha*3600 + ma*60 + sa
            arr_s = hb*3600 + mb*60 + sb
            if arr_s < dep_s:
                arr_s += 86400

            sta = stop_to_station.get(sid_a, sid_a)
            stb = stop_to_station.get(sid_b, sid_b)
            if sta == stb or sta not in stations or stb not in stations:
                continue

            ev = {
                "type": "transit",
                "from": sta,
                "to": stb,
                "dep": dep_s,
                "arr": arr_s,
                "trip": tid,
                "line": r["short"],
                "route_id": r["id"],
                "headsign": t.get("headsign") or "",
                "color": r.get("color") or "#0ea5e9",
                "text_color": r.get("text_color") or "#ffffff",
            }
            events_by_station.setdefault(sta, []).append(ev)

    for sid, events in events_by_station.items():
        events.sort(key=lambda e: e["dep"])
        event_times[sid] = [e["dep"] for e in events]

    _CACHE["events_by_station"] = events_by_station
    _CACHE["event_times"] = event_times

def _nearest_stations(lat, lon, radius=MAX_WALK_START_M, limit=8):
    rows = []
    for st in _stations().values():
        if not st.get("lat") or not st.get("lon"):
            continue
        d = _dist_m(lat, lon, st["lat"], st["lon"])
        if d <= radius:
            rows.append((d, st))
    rows.sort(key=lambda x: x[0])
    return rows[:limit]

def _walk_neighbors(stid):
    stations = _stations()
    st = stations.get(stid)
    if not st:
        return []
    out = []
    for other in stations.values():
        oid = other["id"]
        if oid == stid:
            continue
        d = _dist_m(st["lat"], st["lon"], other["lat"], other["lon"])
        if d <= MAX_WALK_TRANSFER_M:
            out.append((oid, int(d / WALK_SPEED_MPS), d))
    return out[:8]


def _compact_steps(steps):
    out = []
    for st in steps:
        if (
            out
            and st.get("type") == "transit"
            and out[-1].get("type") == "transit"
            and st.get("line") == out[-1].get("line")
            and st.get("headsign") == out[-1].get("headsign")
        ):
            out[-1]["to"] = st.get("to")
            out[-1]["arr"] = st.get("arr")
            out[-1]["duration_min"] = max(1, out[-1].get("duration_min", 0) + st.get("duration_min", 0))
            out[-1]["stops_count"] = out[-1].get("stops_count", 1) + 1
        else:
            if st.get("type") == "transit":
                st["stops_count"] = 1
            out.append(st)
    return out




def _minutes_between(a, b):
    return max(0, int(round((b - a) / 60)))

def _same_place_name(a, b):
    return _norm(a) == _norm(b)

def _clean_steps_for_user(steps):
    """
    Nettoyage UX :
    - supprime les micro-marches absurdes même arrêt -> même arrêt
    - transforme les marches de correspondance très courtes en 'Rejoindre'
    - garde les marches utiles
    """
    cleaned = []
    for st in steps:
        if st.get("type") == "walk":
            frm = st.get("from") or ""
            to = st.get("to") or ""
            dist = int(st.get("distance_m") or 0)

            if _same_place_name(frm, to) or dist < 60:
                if cleaned and cleaned[-1].get("type") == "transit":
                    cleaned[-1]["note_after"] = "Rejoindre la correspondance"
                continue

            if cleaned and cleaned[-1].get("type") == "transit":
                st["label"] = "Rejoindre la correspondance"
            else:
                st["label"] = "Marcher"

        cleaned.append(st)

    return cleaned


def _first_boarding_time(steps, fallback_departure):
    for st in steps:
        if st.get("type") == "transit":
            return st.get("dep") or fallback_departure
    return fallback_departure


def _first_walk_departure(steps, fallback_departure):
    for st in steps:
        if st.get("type") == "walk":
            return st.get("dep") or fallback_departure
    return fallback_departure



def _recommended_departure_from_steps(steps, requested_departure):
    try:
        req_s = _time_to_s(requested_departure)
    except Exception:
        req_s = _time_to_s("now")

    first_board = None
    first_walk = None

    for st in steps or []:
        if st.get("type") == "walk" and first_walk is None:
            first_walk = st
        if st.get("type") == "transit":
            first_board = st.get("dep")
            break

    if not first_board or not first_walk:
        return _fmt_s(req_s)

    try:
        board_s = _time_to_s(first_board)
        walk_min = int(first_walk.get("duration_min") or 0)
    except Exception:
        return _fmt_s(req_s)

    # marge confortable avant le bus/métro
    margin_min = 4
    recommended_s = board_s - ((walk_min + margin_min) * 60)

    # On ne recommande jamais avant l'heure demandée.
    if recommended_s < req_s:
        recommended_s = req_s

    return _fmt_s(recommended_s)



def _append_final_walk_to_exact_destination(steps, stations, target_lat, target_lon, arrival_s):
    if target_lat is None or target_lon is None or not steps:
        return steps, arrival_s

    out = [dict(x) for x in steps]
    last = out[-1]
    last_stop_name = last.get("to")

    if not last_stop_name:
        return out, arrival_s

    dest_lat = float(target_lat)
    dest_lon = float(target_lon)

    # Retrouve la station d'arrivée par son nom
    end_station = None
    for st in stations.values():
        if st.get("name") == last_stop_name:
            end_station = st
            break

    if not end_station:
        return out, arrival_s

    d = _dist_m(end_station["lat"], end_station["lon"], dest_lat, dest_lon)

    # Si l'adresse est quasiment sur l'arrêt, inutile d'ajouter une étape.
    if d < 80:
        return out, arrival_s

    walk_s = int(d / WALK_SPEED_MPS)
    walk_min = max(1, round(walk_s / 60))
    dep_s = arrival_s
    arr_s = arrival_s + walk_s

    out.append({
        "type": "walk",
        "label": "Rejoindre la destination",
        "from": last_stop_name,
        "to": "Destination",
        "dep": _fmt_s(dep_s),
        "arr": _fmt_s(arr_s),
        "duration_min": walk_min,
        "distance_m": round(d)
    })

    return out, arr_s

def _retime_initial_walk_to_recommended_departure(steps, recommended_departure):
    if not steps:
        return steps

    out = [dict(x) for x in steps]
    first_walk_idx = None
    first_transit_idx = None

    for i, st in enumerate(out):
        if st.get("type") == "walk" and first_walk_idx is None:
            first_walk_idx = i
        if st.get("type") == "transit":
            first_transit_idx = i
            break

    if first_walk_idx is None or first_transit_idx is None:
        return out

    walk = out[first_walk_idx]
    transit = out[first_transit_idx]

    try:
        rec_s = _time_to_s(recommended_departure)
        board_s = _time_to_s(transit.get("dep"))
        walk_min = int(walk.get("duration_min") or 0)
    except Exception:
        return out

    walk["dep"] = _fmt_s(rec_s)
    walk["arr"] = _fmt_s(min(board_s - 240, rec_s + walk_min * 60))
    out[first_walk_idx] = walk
    return out


def _journey_explanation(steps):
    if not steps:
        return ""

    parts = []

    for st in steps:
        typ = st.get("type")

        if typ == "walk":
            label = (st.get("label") or "").lower()

            if "destination" in label:
                parts.append(
                    f"marchez encore {st.get('duration_min',1)} min jusqu'à votre destination"
                )

            elif st.get("from") == "Départ":
                parts.append(
                    f"marchez {st.get('duration_min',1)} min jusqu'à l'arrêt {st.get('to')}"
                )

            else:
                parts.append(
                    f"rejoignez votre correspondance à pied ({st.get('duration_min',1)} min)"
                )

        elif typ == "transit":
            line = st.get("line","?")
            headsign = st.get("headsign","")
            frm = st.get("from","")
            to = st.get("to","")

            parts.append(
                f"prenez la ligne {line} direction {headsign} depuis {frm} jusqu'à {to}"
            )

    if not parts:
        return ""

    txt = " Puis ".join(parts)

    return (
        "Trajet recommandé : "
        + txt[:1].upper()
        + txt[1:]
        + "."
    )


def _score_nearest_start_station(from_lat, from_lon, target_lat=None, target_lon=None):
    """
    Sélection réaliste des arrêts de départ :
    - rayon piéton urbain limité ;
    - priorité aux arrêts réellement proches ;
    - évite qu'un arrêt plus loin gagne uniquement parce qu'il progresse vers la destination.
    """
    stations = _stations()
    candidates = []

    for st in stations.values():
        if not st.get("lat") or not st.get("lon"):
            continue

        d = _dist_m(float(from_lat), float(from_lon), st["lat"], st["lon"])
        if d <= MAX_WALK_START_M:
            candidates.append((d, st))

    if not candidates:
        return []

    candidates.sort(key=lambda x: x[0])
    nearest_d = candidates[0][0]

    # On garde le bassin de départ naturel : proche absolu ou proche du meilleur arrêt.
    natural_limit = min(MAX_WALK_START_M, max(650, nearest_d + 350))

    rows = []
    for d, st in candidates:
        if d > natural_limit:
            continue

        progress_bonus = 0
        if target_lat is not None and target_lon is not None:
            direct = _dist_m(float(from_lat), float(from_lon), float(target_lat), float(target_lon))
            after = _dist_m(st["lat"], st["lon"], float(target_lat), float(target_lon))
            progress_bonus = max(-250, min(350, direct - after))

        # Score faible = meilleur. La marche initiale reste dominante.
        score = d * 1.35 - progress_bonus * 0.20
        rows.append((score, d, st))

    rows.sort(key=lambda x: (x[0], x[1]))
    return [(d, st) for score, d, st in rows[:8]]


def plan_with_mode(from_lat, from_lon, to_id=None, to_lat=None, to_lon=None, time="now", mode="depart"):
    mode = str(mode or "depart").lower()
    if mode not in ("depart", "arrive"):
        mode = "depart"

    if mode == "depart":
        out = plan(from_lat, from_lon, to_id=to_id, to_lat=to_lat, to_lon=to_lon, time=time, mode="depart")
        if out.get("ok"):
            out["mode"] = "depart"
        return out

    target = _time_to_s(time)
    best = None

    # Étape 1 : sonde rapide pour estimer la durée de trajet (départ 1h avant la cible)
    probe_dep = max(0, target - 3600)
    probe = plan(from_lat, from_lon, to_id=to_id, to_lat=to_lat, to_lon=to_lon,
                 time=_fmt_s(probe_dep), mode="depart")

    if not probe.get("ok"):
        return {"ok": False, "error": "Aucun trajet trouvé permettant d'arriver avant l'heure demandée"}

    # Utiliser la sonde comme premier candidat si elle arrive à temps
    probe_arr = _time_to_s(probe.get("arrival"))
    if probe_arr <= target:
        best = probe

    # Étape 2 : affiner autour de la durée estimée ± 30 min (max 20 itérations)
    est_s = int(probe.get("duration_min", 60)) * 60
    low_delta  = max(0, est_s - 1800)   # est - 30 min
    high_delta = est_s + 1800            # est + 30 min
    consecutive_fails = 0
    for delta in range(int(low_delta), int(high_delta), 5 * 60):
        dep_s = max(0, target - delta)
        candidate = plan(from_lat, from_lon, to_id=to_id, to_lat=to_lat, to_lon=to_lon,
                         time=_fmt_s(dep_s), mode="depart")
        if not candidate.get("ok"):
            consecutive_fails += 1
            if consecutive_fails >= 6:
                break
            continue
        consecutive_fails = 0
        arr_s = _time_to_s(candidate.get("arrival"))
        if arr_s <= target:
            best = candidate

    if not best:
        return {"ok": False, "error": "Aucun trajet trouvé permettant d'arriver avant l'heure demandée"}

    best["mode"] = "arrive"
    best["requested_arrival"] = _fmt_s(target)
    return best


def plan(from_lat, from_lon, to_id=None, to_lat=None, to_lon=None, time="now", mode="depart"):
    _build_graph()
    stations = _stations()
    events_by_station = _CACHE["events_by_station"]
    event_times = _CACHE["event_times"]

    start_s = _time_to_s(time)

    target_lat_hint = float(to_lat) if to_lat is not None else None
    target_lon_hint = float(to_lon) if to_lon is not None else None

    starts = _score_nearest_start_station(float(from_lat), float(from_lon), target_lat_hint, target_lon_hint)
    if not starts:
        return {"ok": False, "error": "Aucun arrêt proche du départ"}

    targets = set()
    target_walk = {}
    if to_id and to_id in stations:
        st = stations[to_id]
        # Si l'arrêt cible n'a aucun événement (ex. arrêt parent sans service direct),
        # élargir la recherche aux arrêts voisins dans un rayon de 500m.
        if to_id not in events_by_station:
            for d, nb in _nearest_stations(st["lat"], st["lon"], radius=500, limit=8):
                targets.add(nb["id"])
                target_walk[nb["id"]] = int(d / WALK_SPEED_MPS)
        if not targets:
            targets.add(to_id)
            target_walk[to_id] = 0
    elif to_lat is not None and to_lon is not None:
        for d, st in _nearest_stations(float(to_lat), float(to_lon), radius=1200, limit=8):
            targets.add(st["id"])
            target_walk[st["id"]] = int(d / WALK_SPEED_MPS)
    else:
        return {"ok": False, "error": "Destination manquante"}

    pq = []
    best = {}
    best_score = {}
    prev = {}

    TRANSFER_PENALTY_S = 360
    EXTRA_TRANSFER_PENALTY_S = 480
    ONE_STOP_TRANSFER_PENALTY_S = 180

    for d, st in starts:
        sid = st["id"]
        t = start_s + int(d / WALK_SPEED_MPS)
        best[sid] = t
        best_score[sid] = t
        prev[sid] = {
            "type": "walk",
            "from_name": "Départ",
            "to": sid,
            "to_name": st["name"],
            "dep": start_s,
            "arr": t,
            "distance": round(d)
        }
        heapq.heappush(pq, (t, t, "", 0, sid))

    found = None
    best_arrival = None

    while pq:
        cur_t, cur_score, cur_line, transfers, sid = heapq.heappop(pq)
        if cur_score != best_score.get(sid):
            continue

        if sid in targets:
            found = sid
            best_arrival = cur_t + target_walk.get(sid, 0)
            break

        # Correspondance à pied uniquement si très courte.
        # On évite les chaînes absurdes : arrêt A -> arrêt B -> arrêt C à pied.
        previous = prev.get(sid) or {}
        previous_was_walk = str(previous.get("type") or "").startswith("walk")
        if not previous_was_walk:
            for oid, walk_s, d in _walk_neighbors(sid):
                if d > MAX_WALK_TRANSFER_M:
                    continue
                nt = cur_t + walk_s
                if nt < best.get(oid, 10**12):
                    walk_score = cur_score + walk_s + 120
                    best[oid] = nt
                    best_score[oid] = walk_score
                    prev[oid] = {
                        "type": "walk_transfer",
                        "from": sid,
                        "from_name": stations[sid]["name"],
                        "to": oid,
                        "to_name": stations[oid]["name"],
                        "dep": cur_t,
                        "arr": nt,
                        "distance": round(d)
                    }
                    heapq.heappush(pq, (nt, walk_score, cur_line, transfers, oid))

        events = events_by_station.get(sid, [])
        times = event_times.get(sid, [])
        idx = bisect.bisect_left(times, cur_t)
        for ev in events[idx:idx+MAX_SCAN_EVENTS]:
            nt = ev["arr"]
            to = ev["to"]
            line = str(ev.get("line") or "")
            is_transfer = bool(cur_line and line and line != cur_line)
            new_transfers = transfers + (1 if is_transfer else 0)

            penalty = 0
            if is_transfer:
                penalty += TRANSFER_PENALTY_S
                if new_transfers >= 2:
                    penalty += EXTRA_TRANSFER_PENALTY_S

            if is_transfer and (nt - ev["dep"]) <= 180:
                penalty += ONE_STOP_TRANSFER_PENALTY_S

            transit_score = cur_score + max(0, nt - cur_t) + penalty

            if transit_score < best_score.get(to, 10**12):
                best[to] = nt
                best_score[to] = transit_score
                prev[to] = ev
                heapq.heappush(pq, (nt, transit_score, line, new_transfers, to))

    if not found:
        return {"ok": False, "error": "Aucun itinéraire trouvé"}

    raw = []
    cur = found
    while cur in prev:
        step = prev[cur]
        raw.append(step)
        cur = step.get("from")
        if not cur:
            break
    raw.reverse()

    steps = []
    for st in raw:
        if st["type"].startswith("walk"):
            steps.append({
                "type": "walk",
                "label": "Marcher",
                "from": st.get("from_name", "Départ"),
                "to": st.get("to_name"),
                "dep": _fmt_s(st["dep"]),
                "arr": _fmt_s(st["arr"]),
                "duration_min": max(1, round((st["arr"] - st["dep"]) / 60)),
                "distance_m": st.get("distance")
            })
        else:
            steps.append({
                "type": "transit",
                "line": st["line"],
                "headsign": st["headsign"],
                "from": stations[st["from"]]["name"],
                "to": stations[st["to"]]["name"],
                "dep": _fmt_s(st["dep"]),
                "arr": _fmt_s(st["arr"]),
                "duration_min": max(1, round((st["arr"] - st["dep"]) / 60)),
                "color": st["color"],
                "text_color": st["text_color"]
            })

    compact = _compact_steps(steps)
    compact = _clean_steps_for_user(compact)

    first_board = _first_boarding_time(compact, _fmt_s(start_s))
    recommended_departure = _recommended_departure_from_steps(compact, _fmt_s(start_s))
    compact = _retime_initial_walk_to_recommended_departure(compact, recommended_departure)

    exact_target_lat = to_lat if to_lat is not None else None
    exact_target_lon = to_lon if to_lon is not None else None
    compact, best_arrival = _append_final_walk_to_exact_destination(
        compact, stations, exact_target_lat, exact_target_lon, best_arrival
    )

    try:
        duration_from_recommended = max(1, round((_time_to_s(_fmt_s(best_arrival)) - _time_to_s(recommended_departure)) / 60))
    except Exception:
        duration_from_recommended = max(1, round((best_arrival - start_s) / 60))

    return {
        "ok": True,
        "departure": _fmt_s(start_s),
        "recommended_departure": recommended_departure,
        "first_boarding": first_board,
        "arrival": _fmt_s(best_arrival),
        "duration_min": duration_from_recommended,
        "explanation": _journey_explanation(compact),
        "steps": compact
    }
