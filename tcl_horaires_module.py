"""
TCL Horaires Module — V7 Premium
Index GTFS en mémoire avec cache intelligent.
"""
import csv
import json
import math
import re
import time
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path

GTFS = Path("/root/selfservice_data/gtfs")
LIVE = Path("/root/selfservice_data/processed/ALL_realtime.json")

_CACHE = {}
_INDEX_BUILT = False
_INDEX_TS = 0
INDEX_TTL = 3600  # 1h

# ── normalisation ─────────────────────────────────────────────────────────────

def _norm(v):
    v = str(v or "").strip().lower()
    v = unicodedata.normalize("NFD", v)
    v = "".join(c for c in v if unicodedata.category(c) != "Mn")
    return " ".join(v.replace("-", " ").replace(".", " ").replace("_", " ").split())

def _norm_key(v):
    return re.sub(r"[^a-z0-9]", "", _norm(v))

def _haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    r1, r2 = math.radians(lat1), math.radians(lat2)
    dr = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dr/2)**2 + math.cos(r1)*math.cos(r2)*math.sin(dl/2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

# ── couleurs ligne ─────────────────────────────────────────────────────────────

def _line_color(route_color, route_id):
    if route_color and route_color.strip():
        c = route_color.strip().lstrip("#")
        if len(c) == 6:
            return "#" + c
    r = str(route_id or "").upper()
    if r in ("A", "B", "C", "D"):
        return "#1d4ed8"
    if r.startswith("T"):
        return "#7c3aed"
    if r.startswith("C"):
        return "#ea580c"
    if r.startswith("F"):
        return "#0891b2"
    return "#0ea5e9"

def _line_type_label(route_type):
    t = str(route_type or "")
    if t in ("1",):
        return "Métro"
    if t in ("0", "900"):
        return "Tramway"
    if t in ("11",):
        return "Trolleybus"
    if t in ("3", "700", "702", "703", "704"):
        return "Bus"
    if t in ("2", "100"):
        return "Train / Rhônexpress"
    return "Transport"

# ── construction de l'index ───────────────────────────────────────────────────

def _build_index():
    global _INDEX_BUILT, _INDEX_TS

    # Arrêts
    stops = {}
    parents = {}
    with (GTFS / "stops.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            sid = r.get("stop_id", "")
            if not sid:
                continue
            stops[sid] = {
                "id": sid,
                "code": r.get("stop_code", ""),
                "name": r.get("stop_name", ""),
                "lat": r.get("stop_lat", ""),
                "lon": r.get("stop_lon", ""),
                "parent": r.get("parent_station", ""),
                "type": r.get("location_type", "0"),
                "key": _norm_key(r.get("stop_name", "")),
            }
            if r.get("location_type") == "1":
                parents[sid] = r

    # Stations regroupées (parent ou stop seul)
    stations = {}
    stop_to_station = {}
    for sid, s in stops.items():
        parent = s.get("parent") or ""
        station_id = parent if parent and parent in stops else sid
        stop_to_station[sid] = station_id
        if station_id not in stations:
            st_row = stops.get(station_id, s)
            try:
                slat = float(st_row.get("lat") or s.get("lat") or 0)
                slon = float(st_row.get("lon") or s.get("lon") or 0)
            except Exception:
                slat, slon = 0.0, 0.0
            stations[station_id] = {
                "id": station_id,
                "name": st_row.get("name") or s.get("name") or station_id,
                "lat": slat,
                "lon": slon,
                "key": _norm_key(st_row.get("name") or s.get("name") or ""),
                "stop_ids": [],
            }
        stations[station_id]["stop_ids"].append(sid)

    # Lignes (routes)
    routes = {}
    with (GTFS / "routes.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rid = r.get("route_id", "")
            if not rid:
                continue
            short = r.get("route_short_name") or rid
            routes[rid] = {
                "id": rid,
                "short": short,
                "long": r.get("route_long_name", ""),
                "color": _line_color(r.get("route_color", ""), short),
                "text_color": ("#" + r.get("route_text_color", "").lstrip("#")) if r.get("route_text_color") else "#ffffff",
                "type": r.get("route_type", "3"),
                "type_label": _line_type_label(r.get("route_type", "3")),
                "key": _norm_key(short),
            }

    # Trips
    trips = {}
    with (GTFS / "trips.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            tid = r.get("trip_id", "")
            if not tid:
                continue
            trips[tid] = {
                "route_id": r.get("route_id", ""),
                "service_id": r.get("service_id", ""),
                "headsign": r.get("trip_headsign", ""),
                "direction": r.get("direction_id", "0"),
            }

    # Calendrier actif aujourd'hui
    today = datetime.now().strftime("%Y%m%d")
    today_dow = datetime.now().weekday()  # 0=lundi
    dow_cols = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]

    active_services = set()
    with (GTFS / "calendar.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            sid = r.get("service_id", "")
            start = r.get("start_date", "")
            end = r.get("end_date", "")
            if start <= today <= end:
                col = dow_cols[today_dow]
                if r.get(col) == "1":
                    active_services.add(sid)

    with (GTFS / "calendar_dates.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            sid = r.get("service_id", "")
            d = r.get("date", "")
            exc = r.get("exception_type", "")
            if d == today:
                if exc == "1":
                    active_services.add(sid)
                elif exc == "2":
                    active_services.discard(sid)

    # Services actifs → set
    active_trip_ids = {
        tid for tid, t in trips.items()
        if t["service_id"] in active_services
    }

    # Index stop_times — on lit stop_times.txt une seule fois
    # On construit deux index:
    # 1. stop_departures[stop_id] = list of {trip_id, arrival, departure, seq}
    # 2. trip_stops[trip_id]      = sorted list of {stop_id, seq, departure}
    # On ne garde que les trips actifs aujourd'hui pour économiser la mémoire.
    stop_departures = {}  # stop_id -> [(trip_id, dep_time, stop_seq)]
    trip_stops = {}       # trip_id -> [(stop_seq, stop_id, dep_time)]

    with (GTFS / "stop_times.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            tid = r.get("trip_id", "")
            if tid not in active_trip_ids:
                continue
            sid = r.get("stop_id", "")
            dep = r.get("departure_time") or r.get("arrival_time") or ""
            seq = r.get("stop_sequence", "0")
            try:
                seq = int(seq)
            except Exception:
                seq = 0

            stop_departures.setdefault(sid, []).append((tid, dep, seq))
            trip_stops.setdefault(tid, []).append((seq, sid, dep))

    # Tri des trip_stops
    for tid in trip_stops:
        trip_stops[tid].sort(key=lambda x: x[0])

    # Map route_id -> set of stop_ids servis
    route_stops = {}
    route_directions = {}  # route_id -> {headsign: [stop_ids]}

    for tid, t in trips.items():
        if tid not in active_trip_ids:
            continue
        rid = t["route_id"]
        headsign = t["headsign"]
        stop_list = [s[1] for s in trip_stops.get(tid, [])]

        route_stops.setdefault(rid, set()).update(stop_list)

        # On garde un trip représentatif par headsign (le plus long)
        existing = route_directions.get(rid, {}).get(headsign)
        if existing is None or len(stop_list) > len(existing):
            route_directions.setdefault(rid, {})[headsign] = stop_list

    # Map stop_id -> set of route_ids
    stop_routes = {}
    for rid, sids in route_stops.items():
        for sid in sids:
            stop_routes.setdefault(sid, set()).add(rid)

    # Stockage
    _CACHE["stops"] = stops
    _CACHE["stations"] = stations
    _CACHE["stop_to_station"] = stop_to_station
    _CACHE["routes"] = routes
    _CACHE["trips"] = trips
    _CACHE["active_trips"] = active_trip_ids
    _CACHE["stop_departures"] = stop_departures
    _CACHE["trip_stops"] = trip_stops
    _CACHE["route_stops"] = route_stops
    _CACHE["route_directions"] = route_directions
    _CACHE["stop_routes"] = stop_routes
    _CACHE["active_services"] = active_services

    _INDEX_BUILT = True
    _INDEX_TS = time.time()


def _ensure_index():
    global _INDEX_BUILT, _INDEX_TS
    if not _INDEX_BUILT or (time.time() - _INDEX_TS) > INDEX_TTL:
        _build_index()


# ── API : liste des lignes ─────────────────────────────────────────────────────

def api_lignes(q=None):
    _ensure_index()
    routes = _CACHE["routes"]
    stop_routes = _CACHE["stop_routes"]

    # Compter arrêts actifs par ligne
    route_stop_counts = {}
    for sid, rids in stop_routes.items():
        for rid in rids:
            route_stop_counts[rid] = route_stop_counts.get(rid, 0) + 1

    needle = _norm_key(q) if q else ""

    results = []
    for rid, r in routes.items():
        if needle and needle not in r["key"] and needle not in _norm_key(r["long"]):
            continue
        results.append({
            "id": rid,
            "short": r["short"],
            "long": r["long"],
            "color": r["color"],
            "text_color": r["text_color"],
            "type_label": r["type_label"],
            "stop_count": route_stop_counts.get(rid, 0),
        })

    results.sort(key=lambda x: (
        x["short"].upper().replace("C","").replace("T","").zfill(4)
        if not x["short"].upper() in ("A","B","C","D")
        else x["short"]
    ))

    return {"ok": True, "lignes": results}




# ── Helper : exclure les arrivées terminus des horaires affichés ───────────────
def _trip_last_sequences():
    """
    Retourne le dernier stop_sequence connu par trip_id.
    Sert à ne pas afficher une arrivée terminus comme un départ voyageur.
    """
    key = "trip_last_sequences"
    if key in _CACHE:
        return _CACHE[key]

    last = {}
    for rows in (_CACHE.get("stop_departures") or {}).values():
        for tid, dep, seq in rows:
            try:
                n = int(seq)
            except Exception:
                continue
            if tid not in last or n > last[tid]:
                last[tid] = n

    _CACHE[key] = last
    return last


def _is_terminal_arrival_call(tid, seq):
    try:
        seq_i = int(seq)
    except Exception:
        return False

    last = _trip_last_sequences().get(tid)
    if last is None:
        return False

    # Si l'arrêt est le dernier point du trip, c'est une arrivée terminus,
    # pas un départ utile à afficher dans Horaires.
    return seq_i >= int(last)


# ── API : recherche arrêts ─────────────────────────────────────────────────────

def api_arrets(q=None, lat=None, lon=None, radius=500, limit=20):
    _ensure_index()
    stations = _CACHE["stations"]
    stop_routes = _CACHE["stop_routes"]
    routes = _CACHE["routes"]

    def _station_lines(st):
        rids = set()
        for sid in st.get("stop_ids", []):
            rids.update(stop_routes.get(sid, set()))
        return sorted([
            {"short": routes[r]["short"], "color": routes[r]["color"]}
            for r in rids if r in routes
        ], key=lambda x: x["short"])

    if lat is not None and lon is not None:
        candidates = []
        for st in stations.values():
            if not st["lat"] or not st["lon"]:
                continue
            d = _haversine(lat, lon, st["lat"], st["lon"])
            if d <= radius:
                candidates.append({**st, "distance": round(d)})
        candidates.sort(key=lambda x: x["distance"])
        results = candidates[:limit]
        for r in results:
            r["lines"] = _station_lines(r)
        return {"ok": True, "arrets": results}

    if q:
        needle = _norm_key(q)
        if not needle:
            return {"ok": True, "arrets": []}

        candidates = []
        for st in stations.values():
            key = st["key"]
            if needle in key:
                rank = 0 if key == needle else (1 if key.startswith(needle) else 2)
                candidates.append({**st, "rank": rank})

        candidates.sort(key=lambda x: (x["rank"], x["name"]))
        results = candidates[:limit]
        for r in results:
            r["lines"] = _station_lines(r)
            r.pop("rank", None)
        return {"ok": True, "arrets": results}

    return {"ok": True, "arrets": []}


# ── API : arrêts d'une ligne ───────────────────────────────────────────────────

def api_ligne_arrets(line_id):
    _ensure_index()
    routes = _CACHE["routes"]
    stops = _CACHE["stops"]
    route_directions = _CACHE["route_directions"]
    stop_to_station = _CACHE["stop_to_station"]
    stations = _CACHE["stations"]

    # Chercher la route par short name ou id
    route = None
    for rid, r in routes.items():
        if r["short"].upper() == str(line_id).upper() or rid.upper() == str(line_id).upper():
            route = r
            break

    if not route:
        return {"ok": False, "error": "Ligne introuvable"}

    directions = route_directions.get(route["id"], {})

    result_directions = []
    for headsign, stop_ids in directions.items():
        stop_list = []
        seen_stations = set()
        for sid in stop_ids:
            station_id = stop_to_station.get(sid, sid)
            if station_id in seen_stations:
                continue
            seen_stations.add(station_id)
            st = stations.get(station_id) or stops.get(sid)
            if not st:
                continue
            stop_list.append({
                "id": station_id,
                "name": st["name"] if "name" in st else st.get("name", ""),
                "lat": st["lat"] if isinstance(st.get("lat"), float) else float(st.get("lat") or 0),
                "lon": st["lon"] if isinstance(st.get("lon"), float) else float(st.get("lon") or 0),
            })
        result_directions.append({
            "headsign": headsign,
            "stops": stop_list,
        })

    result_directions.sort(key=lambda x: x["headsign"])

    return {
        "ok": True,
        "ligne": {
            "id": route["id"],
            "short": route["short"],
            "long": route["long"],
            "color": route["color"],
            "text_color": route["text_color"],
            "type_label": route["type_label"],
        },
        "directions": result_directions,
    }


# ── API : lignes d'un arrêt ────────────────────────────────────────────────────

def api_arret_lignes(stop_id):
    _ensure_index()
    stations = _CACHE["stations"]
    stops = _CACHE["stops"]
    stop_routes = _CACHE["stop_routes"]
    routes = _CACHE["routes"]
    stop_to_station = _CACHE["stop_to_station"]

    station_id = stop_to_station.get(stop_id, stop_id)
    st = stations.get(station_id) or stops.get(stop_id)
    if not st:
        return {"ok": False, "error": "Arrêt introuvable"}

    stop_ids = st.get("stop_ids") or [stop_id]
    rids = set()
    for sid in stop_ids:
        rids.update(stop_routes.get(sid, set()))

    lignes = []
    for rid in rids:
        r = routes.get(rid)
        if not r:
            continue
        lignes.append({
            "id": rid,
            "short": r["short"],
            "long": r["long"],
            "color": r["color"],
            "text_color": r["text_color"],
            "type_label": r["type_label"],
        })

    lignes.sort(key=lambda x: x["short"])

    return {
        "ok": True,
        "arret": {
            "id": station_id,
            "name": st.get("name") or st.get("stop_name") or station_id,
            "lat": st.get("lat") or st.get("stop_lat") or 0,
            "lon": st.get("lon") or st.get("stop_lon") or 0,
        },
        "lignes": lignes,
    }


# ── API : horaires théoriques d'une ligne à un arrêt ──────────────────────────

def api_horaires_ligne_arret(line_id, stop_id, limit=24):
    _ensure_index()
    routes = _CACHE["routes"]
    stops = _CACHE["stops"]
    stations = _CACHE["stations"]
    stop_to_station = _CACHE["stop_to_station"]
    stop_departures = _CACHE["stop_departures"]
    trips = _CACHE["trips"]
    active_trips = _CACHE["active_trips"]

    route = None
    for rid, r in routes.items():
        if r["short"].upper() == str(line_id).upper() or rid.upper() == str(line_id).upper():
            route = r
            break

    if not route:
        return {"ok": False, "error": "Ligne introuvable"}

    station_id = stop_to_station.get(stop_id, stop_id)
    st = stations.get(station_id) or stops.get(stop_id)
    if not st:
        return {"ok": False, "error": "Arrêt introuvable"}

    stop_ids = set(st.get("stop_ids") or [stop_id])

    now = datetime.now()
    now_s = now.hour * 3600 + now.minute * 60 + now.second

    entries = []
    for sid in stop_ids:
        for (tid, dep, seq) in stop_departures.get(sid, []):
            if tid not in active_trips:
                continue
            t = trips.get(tid)
            if not t or t["route_id"] != route["id"]:
                continue
            if _is_terminal_arrival_call(tid, seq):
                continue
            try:
                h, m, s = [int(x) for x in dep.split(":")]
                dep_s = h * 3600 + m * 60 + s
            except Exception:
                continue
            entries.append({
                "time": f"{h%24:02d}:{m:02d}",
                "dep_s": dep_s,
                "headsign": t["headsign"],
                "direction": t["direction"],
            })

    entries.sort(key=lambda x: x["dep_s"])

    # Prochain passage : ceux qui viennent après maintenant (y compris nuit > 24h)
    upcoming = [e for e in entries if e["dep_s"] >= now_s]
    if not upcoming:
        upcoming = entries

    # On regroupe par direction
    by_direction = {}
    for e in upcoming[:limit * 2]:
        d = e["headsign"]
        by_direction.setdefault(d, []).append(e["time"])

    directions_out = [
        {"headsign": h, "times": times[:limit]}
        for h, times in by_direction.items()
    ]
    directions_out.sort(key=lambda x: x["headsign"])

    return {
        "ok": True,
        "ligne": {"short": route["short"], "color": route["color"]},
        "arret": {"id": station_id, "name": st.get("name") or st.get("stop_name") or station_id},
        "directions": directions_out,
        "count": sum(len(d["times"]) for d in directions_out),
    }


# ── API : prochains passages à un arrêt ───────────────────────────────────────

def api_prochains_passages(stop_id, limit=30):
    _ensure_index()
    stops = _CACHE["stops"]
    stations = _CACHE["stations"]
    stop_to_station = _CACHE["stop_to_station"]
    stop_departures = _CACHE["stop_departures"]
    trips = _CACHE["trips"]
    routes = _CACHE["routes"]
    active_trips = _CACHE["active_trips"]

    station_id = stop_to_station.get(stop_id, stop_id)
    st = stations.get(station_id) or stops.get(stop_id)
    if not st:
        return {"ok": False, "error": "Arrêt introuvable"}

    stop_ids = set(st.get("stop_ids") or [stop_id])
    stop_name = st.get("name") or st.get("stop_name") or station_id

    now = datetime.now()
    now_s = now.hour * 3600 + now.minute * 60 + now.second

    entries = []
    for sid in stop_ids:
        for (tid, dep, seq) in stop_departures.get(sid, []):
            if tid not in active_trips:
                continue
            t = trips.get(tid)
            if not t:
                continue
            r = routes.get(t["route_id"])
            if not r:
                continue
            if _is_terminal_arrival_call(tid, seq):
                continue
            try:
                h, m, s = [int(x) for x in dep.split(":")]
                dep_s = h * 3600 + m * 60 + s
            except Exception:
                continue

            if dep_s < now_s - 60:
                continue

            minutes = max(0, (dep_s - now_s) // 60)
            entries.append({
                "time": f"{h%24:02d}:{m:02d}",
                "dep_s": dep_s,
                "minutes": int(minutes),
                "line": r["short"],
                "line_color": r["color"],
                "line_text_color": r["text_color"],
                "headsign": t["headsign"],
                "source": "theorique",
            })

    # Enrichissement temps réel
    try:
        live = json.loads(LIVE.read_text(encoding="utf-8"))
        stop_keys = {_norm_key(stop_name)}
        stop_ids_norm = set(str(s).split(":")[-1] for s in stop_ids)

        for line_key, arr in (live or {}).items():
            for b in arr or []:
                for c in b.get("bt_calls") or []:
                    ref = str(c.get("stopRef") or "").split(":")[-1]
                    cname = _norm_key(c.get("stopName") or "")
                    if ref not in stop_ids_norm and cname not in stop_keys:
                        continue
                    ts = c.get("expectedTime") or c.get("aimedTime")
                    if not ts:
                        continue
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
                        dt_naive = dt.replace(tzinfo=None)
                        diff_s = (dt_naive - now).total_seconds()
                        if diff_s < -60 or diff_s > 86400:
                            continue
                        minutes_rt = max(0, int(diff_s // 60))
                        entries.append({
                            "time": dt_naive.strftime("%H:%M"),
                            "dep_s": dt_naive.hour * 3600 + dt_naive.minute * 60,
                            "minutes": minutes_rt,
                            "line": str(line_key),
                            "line_color": "#0ea5e9",
                            "line_text_color": "#ffffff",
                            "headsign": b.get("bt_destination") or b.get("destination") or "",
                            "source": "reel",
                        })
                    except Exception:
                        pass
    except Exception:
        pass

    # Dédoublonnage : le temps réel prime sur le théorique pour même ligne + direction + heure proche
    real_by_key = {}
    for e in entries:
        if e["source"] == "reel":
            k = (_norm_key(e["line"]), _norm_key(e["headsign"]), e["time"])
            real_by_key[k] = True

    deduped = []
    for e in entries:
        if e["source"] == "theorique":
            k = (_norm_key(e["line"]), _norm_key(e["headsign"]), e["time"])
            if k in real_by_key:
                continue
        deduped.append(e)

    deduped.sort(key=lambda x: (x["dep_s"], 0 if x["source"] == "reel" else 1))

    # Regrouper par ligne
    by_line = {}
    for e in deduped:
        key = (e["line"], e["headsign"])
        by_line.setdefault(key, []).append(e)

    passages_out = []
    for (line, headsign), items in sorted(by_line.items()):
        items = items[:6]
        passages_out.append({
            "line": line,
            "line_color": items[0]["line_color"],
            "line_text_color": items[0]["line_text_color"],
            "headsign": headsign,
            "passages": [
                {
                    "time": i["time"],
                    "minutes": i["minutes"],
                    "source": i["source"],
                }
                for i in items
            ],
        })

    passages_out.sort(key=lambda x: (
        min(p["minutes"] for p in x["passages"]),
        x["line"],
        x["headsign"],
    ))

    return {
        "ok": True,
        "arret": {
            "id": station_id,
            "name": stop_name,
            "lat": st.get("lat") if isinstance(st.get("lat"), float) else float(st.get("lat") or 0),
            "lon": st.get("lon") if isinstance(st.get("lon"), float) else float(st.get("lon") or 0),
        },
        "passages": passages_out[:limit],
        "ts": datetime.now().strftime("%H:%M:%S"),
    }


# ── API : arrêts proches ───────────────────────────────────────────────────────

def api_arrets_proches(lat, lon, radius=600, limit=10):
    _ensure_index()
    return api_arrets(lat=lat, lon=lon, radius=radius, limit=limit)


# ── API : détail d'un arrêt ────────────────────────────────────────────────────

def api_arret_detail(stop_id):
    _ensure_index()
    stops = _CACHE["stops"]
    stations = _CACHE["stations"]
    stop_to_station = _CACHE["stop_to_station"]
    stop_routes = _CACHE["stop_routes"]
    routes = _CACHE["routes"]

    station_id = stop_to_station.get(stop_id, stop_id)
    st = stations.get(station_id) or stops.get(stop_id)
    if not st:
        return {"ok": False, "error": "Arrêt introuvable"}

    stop_ids = set(st.get("stop_ids") or [stop_id])
    rids = set()
    for sid in stop_ids:
        rids.update(stop_routes.get(sid, set()))

    lignes = [
        {
            "id": rid,
            "short": routes[rid]["short"],
            "color": routes[rid]["color"],
            "text_color": routes[rid]["text_color"],
            "long": routes[rid]["long"],
        }
        for rid in rids if rid in routes
    ]
    lignes.sort(key=lambda x: x["short"])

    return {
        "ok": True,
        "arret": {
            "id": station_id,
            "name": st.get("name") or st.get("stop_name") or station_id,
            "lat": st.get("lat") if isinstance(st.get("lat"), float) else float(st.get("lat") or 0),
            "lon": st.get("lon") if isinstance(st.get("lon"), float) else float(st.get("lon") or 0),
            "stop_ids": list(stop_ids),
        },
        "lignes": lignes,
    }


# ── API : horaires journée complète d'une ligne à un arrêt ─────────────────────
def api_horaires_ligne_arret_journee(line_id, stop_id, limit=240):
    _ensure_index()
    routes = _CACHE["routes"]
    stops = _CACHE["stops"]
    stations = _CACHE["stations"]
    stop_to_station = _CACHE["stop_to_station"]
    stop_departures = _CACHE["stop_departures"]
    trips = _CACHE["trips"]
    active_trips = _CACHE["active_trips"]

    route = None
    for rid, r in routes.items():
        if r["short"].upper() == str(line_id).upper() or rid.upper() == str(line_id).upper():
            route = r
            break

    if not route:
        return {"ok": False, "error": "Ligne introuvable"}

    station_id = stop_to_station.get(stop_id, stop_id)
    st = stations.get(station_id) or stops.get(stop_id)
    if not st:
        return {"ok": False, "error": "Arrêt introuvable"}

    stop_ids = set(st.get("stop_ids") or [stop_id])
    entries = []

    for sid in stop_ids:
        for (tid, dep, seq) in stop_departures.get(sid, []):
            if tid not in active_trips:
                continue
            t = trips.get(tid)
            if not t or t["route_id"] != route["id"]:
                continue
            if _is_terminal_arrival_call(tid, seq):
                continue
            try:
                h, m, sec = [int(x) for x in dep.split(":")]
                dep_s = h * 3600 + m * 60 + sec
            except Exception:
                continue

            entries.append({
                "time": f"{h%24:02d}:{m:02d}",
                "dep_s": dep_s,
                "headsign": t.get("headsign") or "Direction non précisée",
                "direction": t.get("direction"),
            })

    entries.sort(key=lambda x: x["dep_s"])

    by_direction = {}
    for e in entries:
        by_direction.setdefault(e["headsign"], []).append(e["time"])

    directions_out = [
        {"headsign": h, "times": times[:limit]}
        for h, times in by_direction.items()
    ]
    directions_out.sort(key=lambda x: x["headsign"])

    return {
        "ok": True,
        "ligne": {
            "id": route["id"],
            "short": route["short"],
            "long": route["long"],
            "color": route["color"],
            "text_color": route["text_color"],
        },
        "arret": {
            "id": station_id,
            "name": st.get("name") or st.get("stop_name") or station_id,
        },
        "directions": directions_out,
        "count": sum(len(d["times"]) for d in directions_out),
    }
