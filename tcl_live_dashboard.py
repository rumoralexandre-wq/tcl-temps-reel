#!/opt/tcltempsreel/venv/bin/python3
from pathlib import Path

from flask import Flask, Response, jsonify, request

import tcl_live_dashboard_v7_core as core
import tcl_horaires_module as horaires
import tcl_itineraire_module as itineraire


app = Flask(__name__, static_folder="static", static_url_path="/static")

BASE_DIR = Path(__file__).resolve().parent
INDEX_HTML = BASE_DIR / "templates" / "v7_index.html"


@app.after_request
def nocache(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    response.headers["Service-Worker-Allowed"] = "none"
    return response


@app.route("/")
def home():
    return Response(INDEX_HTML.read_text(encoding="utf-8"), mimetype="text/html")


@app.route("/v7")
def v7_home():
    html = INDEX_HTML.read_text(encoding="utf-8")
    r = Response(html, mimetype="text/html")
    r.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    r.headers["Pragma"] = "no-cache"
    r.headers["Expires"] = "0"
    r.headers["Clear-Site-Data"] = '"cache", "storage"'
    return r


@app.route("/kill-cache")
def kill_cache():
    page = BASE_DIR / "templates" / "kill_cache.html"
    return Response(page.read_text(encoding="utf-8"), mimetype="text/html")


@app.route("/api/realtime")
def api_realtime():
    return Response(core.LIVE.read_text(encoding="utf-8"), mimetype="application/json")


@app.route("/api/line")
def api_line():
    line = request.args.get("line", "C10")
    return jsonify({"line": line, "cards": core.render_cards(line)})


@app.route("/api/line_html")
def api_line_html():
    line = request.args.get("line", "C10")
    return Response(core.render_cards(line), mimetype="text/html")


@app.route("/api/traffic")
def api_traffic():
    try:
        return core.api_all_alerts()
    except Exception:
        return jsonify({"alerts": []})


# V7 — API arrêt proche + passages
_NEARBY_CACHE = {}

@app.route("/api/nearby_stop")
def api_nearby_stop():
    import csv, json, math, unicodedata, time
    from datetime import datetime, timedelta
    from pathlib import Path

    try:
        lat = float(request.args.get("lat", ""))
        lon = float(request.args.get("lon", ""))
    except Exception:
        return jsonify({"ok": False, "error": "coordonnees_invalides"})

    radius = float(request.args.get("radius", "200"))
    GTFS = core.GTFS

    def norm(v):
        v = str(v or "").strip().lower()
        v = unicodedata.normalize("NFD", v)
        v = "".join(c for c in v if unicodedata.category(c) != "Mn")
        return "".join(c for c in v if c.isalnum())

    def dist(a,b,c,d):
        R = 6371000
        x1, x2 = math.radians(a), math.radians(c)
        dx = math.radians(c-a)
        dy = math.radians(d-b)
        h = math.sin(dx/2)**2 + math.cos(x1)*math.cos(x2)*math.sin(dy/2)**2
        return 2 * R * math.atan2(math.sqrt(h), math.sqrt(1-h))

    def load_stop_index():
        if "stops" in _NEARBY_CACHE:
            return _NEARBY_CACHE["stops"]

        rows = []
        parents = {}
        children = {}

        with (GTFS / "stops.txt").open(encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                rows.append(r)
                if r.get("location_type") == "1":
                    parents[r["stop_id"]] = r

        for r in rows:
            sid = r.get("stop_id")
            parent = r.get("parent_station") or ""
            station_id = parent if parent else sid
            children.setdefault(station_id, []).append(sid)

        stations = {}
        stop_to_station = {}

        for r in rows:
            sid = r.get("stop_id")
            parent = r.get("parent_station") or ""
            station_id = parent if parent else sid
            station_row = parents.get(station_id, r)

            try:
                slat = float(station_row.get("stop_lat") or r.get("stop_lat"))
                slon = float(station_row.get("stop_lon") or r.get("stop_lon"))
            except Exception:
                continue

            stations[station_id] = {
                "id": station_id,
                "name": station_row.get("stop_name") or r.get("stop_name") or station_id,
                "lat": slat,
                "lon": slon,
                "stop_ids": children.get(station_id, [station_id]),
                "key": norm(station_row.get("stop_name") or r.get("stop_name")),
            }
            stop_to_station[sid] = station_id

        _NEARBY_CACHE["stops"] = (stations, stop_to_station)
        return stations, stop_to_station

    def load_trip_route_index():
        if "trips_routes" in _NEARBY_CACHE:
            return _NEARBY_CACHE["trips_routes"]

        route_short = {}
        with (GTFS / "routes.txt").open(encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                route_short[r.get("route_id")] = r.get("route_short_name") or r.get("route_id")

        trip_info = {}
        with (GTFS / "trips.txt").open(encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                rid = r.get("route_id")
                trip_info[r.get("trip_id")] = {
                    "line": route_short.get(rid, rid),
                    "direction": r.get("trip_headsign") or "",
                }

        _NEARBY_CACHE["trips_routes"] = trip_info
        return trip_info

    def station_schedule(station_id, stop_ids):
        cache_key = "sched_" + station_id
        cached = _NEARBY_CACHE.get(cache_key)
        if cached and time.time() - cached["ts"] < 900:
            return cached["items"]

        trip_info = load_trip_route_index()
        stop_ids = set(stop_ids)
        items = []

        with (GTFS / "stop_times.txt").open(encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                if r.get("stop_id") not in stop_ids:
                    continue
                trip = r.get("trip_id")
                info = trip_info.get(trip)
                if not info:
                    continue
                t = r.get("departure_time") or r.get("arrival_time") or ""
                if not t:
                    continue
                items.append({
                    "time": t,
                    "line": info["line"],
                    "direction": info["direction"],
                    "source": "theorique",
                })

        _NEARBY_CACHE[cache_key] = {"ts": time.time(), "items": items}
        return items

    def parse_gtfs_time(t, base):
        try:
            h,m,s = [int(x) for x in str(t).split(":")]
            d = base.replace(hour=0, minute=0, second=0, microsecond=0)
            return d + timedelta(hours=h, minutes=m, seconds=s)
        except Exception:
            return None

    stations, stop_to_station = load_stop_index()

    nearest = None
    for st in stations.values():
        d = dist(lat, lon, st["lat"], st["lon"])
        if nearest is None or d < nearest["distance"]:
            nearest = {**st, "distance": d}

    if not nearest or nearest["distance"] > radius:
        return jsonify({
            "ok": True,
            "found": False,
            "radius": radius,
            "message": "Aucun arrêt proche"
        })

    now = datetime.now().astimezone()
    limit_1h = now + timedelta(hours=1)
    limit_24h = now + timedelta(hours=24)

    passages = []

    # Temps réel Bus Tracker / ALL_realtime
    try:
        live = json.loads(core.LIVE.read_text(encoding="utf-8"))
        stop_ids = set(nearest["stop_ids"])
        stop_keys = {nearest["key"]}

        for line, arr in (live or {}).items():
            for b in arr or []:
                for c in b.get("bt_calls") or []:
                    ref = str(c.get("stopRef") or "").split(":")[-1]
                    cname = c.get("stopName") or ""
                    if ref not in stop_ids and norm(cname) not in stop_keys:
                        continue
                    ts = c.get("expectedTime") or c.get("aimedTime")
                    try:
                        dt = datetime.fromisoformat(ts)
                    except Exception:
                        continue
                    if dt < now or dt > limit_24h:
                        continue
                    passages.append({
                        "line": str(line),
                        "direction": b.get("bt_destination") or b.get("destination") or "",
                        "time": dt.strftime("%H:%M"),
                        "minutes": max(0, int((dt-now).total_seconds()//60)),
                        "vehicle": b.get("vehicule") or "",
                        "source": "reel",
                    })
    except Exception:
        pass

    # Théorique GTFS pour compléter toutes les lignes
    for x in station_schedule(nearest["id"], nearest["stop_ids"]):
        dt = parse_gtfs_time(x["time"], now)
        if not dt or dt < now or dt > limit_24h:
            continue
        passages.append({
            "line": str(x["line"]),
            "direction": x["direction"],
            "time": dt.strftime("%H:%M"),
            "minutes": max(0, int((dt-now).total_seconds()//60)),
            "vehicle": "",
            "source": "theorique",
        })

    # Priorité temps réel sur théorique :
    # si une même ligne + même direction existe en réel, on supprime le théorique.
    real_keys = {
        (str(psg.get("line") or ""), norm(psg.get("direction") or ""))
        for psg in passages
        if psg.get("source") == "reel"
    }

    if real_keys:
        passages = [
            psg for psg in passages
            if psg.get("source") == "reel"
            or (str(psg.get("line") or ""), norm(psg.get("direction") or "")) not in real_keys
        ]

    # Dédoublonnage propre :
    # on garde les 2 prochains passages par ligne + direction.
    # Exemple C10 à un arrêt : 2 passages vers Bellecour + 2 passages vers Barolles si disponibles.
    # Le temps réel reste prioritaire sur le théorique quand les deux existent.
    best_by_direction = {}

    for psg in sorted(passages, key=lambda x: (x["minutes"], 0 if x["source"]=="reel" else 1)):
        key = (psg["line"], norm(psg["direction"]))
        vals = best_by_direction.setdefault(key, [])

        duplicate = False
        for old_psg in vals:
            if (
                old_psg.get("time") == psg.get("time")
                and old_psg.get("source") == psg.get("source")
                and str(old_psg.get("vehicle") or "") == str(psg.get("vehicle") or "")
            ):
                duplicate = True
                break

        if duplicate:
            continue

        if len(vals) < 2:
            vals.append(psg)

    by_line = {}
    for vals in best_by_direction.values():
        for psg in vals:
            by_line.setdefault(psg["line"], []).append(psg)

    lines = []
    for line, vals in by_line.items():
        vals = sorted(vals, key=lambda x: (norm(x.get("direction") or ""), x["minutes"]))[:8]
        lines.append({
            "line": line,
            "passages": vals,
            "has_within_hour": any(v["minutes"] <= 60 for v in vals),
        })

    lines.sort(key=lambda x: (
        0 if any(p["source"]=="reel" for p in x["passages"]) else 1,
        min([p["minutes"] for p in x["passages"]] or [9999]),
        x["line"]
    ))

    return jsonify({
        "ok": True,
        "found": True,
        "station": {
            "id": nearest["id"],
            "name": nearest["name"],
            "lat": nearest["lat"],
            "lon": nearest["lon"],
            "distance": round(nearest["distance"]),
            "stop_ids": nearest["stop_ids"],
        },
        "lines": lines[:30],
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8798, debug=False)


# ── MODULE HORAIRES V7 ─────────────────────────────────────────────────────────

@app.route("/api/horaires/lignes")
def api_horaires_lignes():
    q = request.args.get("q", "").strip()
    try:
        return jsonify(horaires.api_lignes(q=q or None))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/horaires/arrets")
def api_horaires_arrets():
    q = request.args.get("q", "").strip()
    try:
        lat = float(request.args.get("lat", ""))
        lon = float(request.args.get("lon", ""))
        radius = float(request.args.get("radius", "600"))
        return jsonify(horaires.api_arrets(lat=lat, lon=lon, radius=radius))
    except Exception:
        pass
    if q:
        try:
            return jsonify(horaires.api_arrets(q=q))
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)})
    return jsonify({"ok": True, "arrets": []})


@app.route("/api/horaires/ligne/<line_id>/arrets")
def api_horaires_ligne_arrets(line_id):
    try:
        return jsonify(horaires.api_ligne_arrets(line_id))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/horaires/arret/<stop_id>/lignes")
def api_horaires_arret_lignes(stop_id):
    try:
        return jsonify(horaires.api_arret_lignes(stop_id))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/horaires/arret/<stop_id>/prochains")
def api_horaires_arret_prochains(stop_id):
    try:
        return jsonify(horaires.api_prochains_passages(stop_id))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/horaires/arret/<stop_id>/detail")
def api_horaires_arret_detail(stop_id):
    try:
        return jsonify(horaires.api_arret_detail(stop_id))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/horaires/proche")
def api_horaires_proche():
    try:
        lat = float(request.args.get("lat", ""))
        lon = float(request.args.get("lon", ""))
        radius = float(request.args.get("radius", "600"))
        return jsonify(horaires.api_arrets_proches(lat, lon, radius=radius))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})




@app.route("/api/horaires/ligne/<line_id>/arret/<stop_id>/journee")
def api_horaires_ligne_arret_journee(line_id, stop_id):
    try:
        return jsonify(horaires.api_horaires_ligne_arret_journee(line_id, stop_id))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})




@app.route("/api/itineraire/search")
def api_itineraire_search():
    try:
        q = request.args.get("q", "")
        limit = int(request.args.get("limit", "12"))
        lat = request.args.get("lat")
        lon = request.args.get("lon")
        return jsonify(itineraire.search(q=q, limit=limit, lat=lat, lon=lon))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/itineraire/plan")
def api_itineraire_plan():
    try:
        return jsonify(itineraire.plan_with_mode(
            from_lat=request.args.get("from_lat"),
            from_lon=request.args.get("from_lon"),
            to_id=request.args.get("to_id") or None,
            to_lat=request.args.get("to_lat") or None,
            to_lon=request.args.get("to_lon") or None,
            time=request.args.get("time", "now"),
            mode=request.args.get("mode", "depart")
        ))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


# V7 — proxy tracé officiel Bus Tracker
@app.route("/api/bt_path")
def api_bt_path():
    import json, urllib.request, urllib.parse
    from flask import request, jsonify

    ref = (request.args.get("ref") or "").strip()
    if not ref:
        return jsonify({"p": []})

    url = "https://bus-tracker.fr/api/paths/" + urllib.parse.quote(ref, safe=":")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        raw = urllib.request.urlopen(req, timeout=8).read().decode("utf-8", "replace")
        return jsonify(json.loads(raw))
    except Exception as e:
        return jsonify({"p": [], "error": str(e)})

# --- TCL official JSON itinerary engine ---
import json as _tcl_json
import urllib.parse as _tcl_urlparse
import urllib.request as _tcl_urlreq
from datetime import datetime as _tcl_datetime
from zoneinfo import ZoneInfo as _tcl_ZoneInfo
from flask import request as _tcl_request, jsonify as _tcl_jsonify

_TCL_AUTOCOMPLETE_TYPES = [
    {"sub": "ter", "type": "area"},
    {"sub": "tcl", "type": "area"},
    {"sub": "tcl", "type": "poi"},
    {"sub": "tcl", "type": "address"},
    {"sub": "tcl", "type": "boundary"},
]

_TCL_TRANSPORT_MODES = [
    "metro", "funicular", "tramway", "boat", "bus", "tod", "train", "car-region"
]


def _tcl_enc(v):
    if isinstance(v, (dict, list)):
        return _tcl_json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    if isinstance(v, bool):
        return "1" if v else "0"
    return str(v)


def _tcl_request_json(path, params, timeout=20):
    clean = {k: v for k, v in params.items() if v not in (None, "")}
    qs = _tcl_urlparse.urlencode({k: _tcl_enc(v) for k, v in clean.items()})
    url = "https://carte-interactive.tcl.fr/api/interface/tcl/" + path
    if qs:
        url += "?" + qs

    req = _tcl_urlreq.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://carte-interactive.tcl.fr/all/journeys?go=1&lang=fr",
        "Origin": "https://carte-interactive.tcl.fr",
    })
    with _tcl_urlreq.urlopen(req, timeout=timeout) as r:
        return _tcl_json.loads(r.read().decode("utf-8", "ignore"))


def _tcl_parse_dt(value):
    if not value:
        return None
    try:
        text = str(value).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = _tcl_datetime.fromisoformat(text)
        paris = _tcl_ZoneInfo("Europe/Paris")
        if dt.tzinfo is None:
            return dt.replace(tzinfo=paris)
        return dt.astimezone(paris)
    except Exception:
        return None


def _tcl_filter_current_journeys(data, now=None):
    if not isinstance(data, dict):
        return data, 0

    journeys = data.get("journeys")
    if not isinstance(journeys, list):
        return data, 0

    now = now or _tcl_datetime.now(_tcl_ZoneInfo("Europe/Paris"))
    current = []
    expired = 0
    for journey in journeys:
        arrival = _tcl_parse_dt((journey or {}).get("arrival"))
        if arrival is not None and arrival <= now:
            expired += 1
            continue
        current.append(journey)

    data = dict(data)
    data["journeys"] = current
    data["filteredExpired"] = expired
    data["serverNow"] = now.isoformat()
    return data, expired


def _tcl_autocomplete_row(item):
    kind = item.get("type") or ""
    obj = item.get(kind) or {}
    geo = obj.get("geojson") or {}
    coords = geo.get("coordinates") or []
    lon = coords[0] if len(coords) >= 2 else None
    lat = coords[1] if len(coords) >= 2 else None
    boundary = obj.get("boundary") or {}
    label_type = "stop" if kind == "area" else kind
    meta_by_type = {
        "area": "Arrêt TCL",
        "address": "Adresse",
        "poi": "Lieu",
        "boundary": "Commune",
    }
    return {
        "type": label_type,
        "tclType": kind,
        "sub": item.get("sub") or "tcl",
        "id": obj.get("id") or "",
        "name": obj.get("name") or obj.get("long_name") or "Lieu",
        "address": obj.get("long_name") or boundary.get("name") or "",
        "meta": meta_by_type.get(kind, "Lieu"),
        "lat": lat,
        "lon": lon,
        "rawType": kind,
    }


@app.get("/api/tcl/autocomplete")
def api_tcl_autocomplete():
    q = (_tcl_request.args.get("q") or _tcl_request.args.get("query") or "").strip()
    if len(q) < 2:
        return _tcl_jsonify({"ok": True, "results": []})
    try:
        raw = _tcl_request_json("autocomplete", {
            "query": q,
            "types": _TCL_AUTOCOMPLETE_TYPES,
        }, timeout=12)
        rows = [_tcl_autocomplete_row(x) for x in raw if isinstance(x, dict)]
        rows = [x for x in rows if x.get("lat") is not None and x.get("lon") is not None]
        return _tcl_jsonify({"ok": True, "source": "official", "results": rows})
    except Exception as e:
        return _tcl_jsonify({"ok": False, "error": str(e), "results": []}), 502


@app.route("/api/tcl/journeys", methods=["GET", "POST"])
def api_tcl_journeys():
    payload = _tcl_request.get_json(silent=True) if _tcl_request.method == "POST" else None
    payload = payload or _tcl_request.args.to_dict()

    params = {
        "from": payload.get("from"),
        "to": payload.get("to"),
        "fromId": payload.get("fromId") or None,
        "fromType": payload.get("fromType") or None,
        "fromName": payload.get("fromName") or None,
        "toId": payload.get("toId") or None,
        "toType": payload.get("toType") or None,
        "toName": payload.get("toName") or None,
        "datetime": payload.get("datetime"),
        "isArrivalTime": bool(payload.get("isArrivalTime")),
        "transportModes": payload.get("transportModes") or _TCL_TRANSPORT_MODES,
        "walk": payload.get("walk") or "normal",
        "bike": payload.get("bike") or {"type": ["bike", "bss"], "speed": "normal", "isElectric": False},
        "pmr": bool(payload.get("pmr")),
        "language": "fr",
        "car": bool(payload.get("car", True)),
        "carPooling": bool(payload.get("carPooling")),
        "dataFreshness": bool(payload.get("dataFreshness")),
        "algorithm": payload.get("algorithm") or "FASTEST",
    }

    if not params["from"] or not params["to"]:
        return _tcl_jsonify({"ok": False, "error": "Départ ou destination manquant"}), 400

    try:
        data = _tcl_request_json("journeys", params, timeout=25)
        if data.get("ok") is False:
            return _tcl_jsonify({"ok": False, "source": "official", "error": data.get("err") or "Erreur TCL"}), 502
        official_data = data.get("data", data)
        official_data, filtered_expired = _tcl_filter_current_journeys(official_data)
        return _tcl_jsonify({
            "ok": True,
            "source": "official",
            "data": official_data,
            "filteredExpired": filtered_expired,
        })
    except Exception as e:
        return _tcl_jsonify({"ok": False, "error": str(e)}), 502
# --- /TCL official JSON itinerary engine ---
