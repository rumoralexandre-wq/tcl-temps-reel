# Auto-généré : core V6 light autonome
import csv
import json
import re
import math
from datetime import datetime, timedelta
from pathlib import Path
from html import escape
from flask import Flask, jsonify, request, Response

app = Flask(__name__, static_folder="static", static_url_path="/static")

app = Flask(__name__)



BASE = Path.home() / "selfservice_data"



LIVE = BASE / "processed" / "ALL_realtime.json"



GTFS = BASE / "gtfs"



TRAFFIC = BASE / "processed" / "TCL_traffic_alerts.json"



APPROACH_MEMORY = {}



APPROACH_MEMORY_TTL = 25



ACTIVE_TRIPS = {}


TERMINUS_MEMORY = {}
TERMINUS_MEMORY_TTL = 900



def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default



def load_live_for_line(line):
    """
    V3 premium :
    - base = ALL_realtime.json
    - si un fichier enrichi récent existe, on fusionne par véhicule
    - ENRICHED prioritaire pour les véhicules présents
    - ALL conservé pour les véhicules absents de l'enrichi
    """
    line_key = str(line or "").strip()

    live = load_json(LIVE, {})
    base_buses = live.get(line_key, []) if isinstance(live, dict) else []

    enriched = BASE / "processed" / f"{line_key}_realtime_enriched.json"
    if not line_key or not enriched.exists():
        return base_buses

    try:
        age = time.time() - enriched.stat().st_mtime
        if age > 20:
            return base_buses

        enriched_buses = load_json(enriched, [])
        if not isinstance(enriched_buses, list):
            return base_buses

        merged = {}
        order = []

        def key_for_bus(b):
            return str(
                b.get("vehicule")
                or b.get("vehicle_id")
                or b.get("bt_vehicle_id")
                or ""
            ).strip()

        for b in base_buses:
            k = key_for_bus(b)
            if k:
                merged[k] = b
                order.append(k)

        for b in enriched_buses:
            k = key_for_bus(b)
            if k:
                merged[k] = b
                if k not in order:
                    order.append(k)

        return [merged[k] for k in order if k in merged]

    except Exception:
        return base_buses



def delay_text(delay):
    d = str(delay or "")
    if d in ("", "PT0S"):
        return "À l’heure"
    if d.startswith("-"):
        return "En avance"
    return d.replace("PT", "+").replace("M", " min ").replace("S", " s")



def delay_class(delay):
    d = delay_seconds(delay)

    if d < -30:
        return "avance"
    if d <= 20:
        return "heure"
    if d < 180:
        return "retard-green"
    return "retard-orange"


def delay_seconds(delay):
    """
    Convertit PT2M33S / PT12M / -PT47S en secondes.
    Retard positif, avance négative.
    """
    d = str(delay or "").strip()
    if not d or d == "PT0S":
        return 0

    sign = -1 if d.startswith("-") else 1
    d = d.lstrip("-")

    m = re.match(r"PT(?:(\d+)M)?(?:(\d+)S)?", d)
    if not m:
        return 0

    minutes = int(m.group(1) or 0)
    seconds = int(m.group(2) or 0)
    return sign * ((minutes * 60) + seconds)



def _smart_event_recalage_boost(call, bus, delay_s, expected_s):
    import time
    from datetime import datetime

    call = call or {}
    bus = bus or {}

    vehicle = str(
        bus.get("vehicule")
        or bus.get("vehicle_id")
        or bus.get("bt_vehicle_id")
        or bus.get("vehicleRef")
        or bus.get("vehicleId")
        or ""
    ).strip()

    line = str(bus.get("line") or bus.get("ligne") or bus.get("route") or "").strip()
    dest = str(bus.get("bt_destination") or bus.get("destination") or "").strip()
    stop = str(call.get("stopName") or "").strip()
    order = str(call.get("stopOrder") or "").strip()
    aimed = str(call.get("aimedTime") or "").strip()

    key = "|".join([line, vehicle, dest, stop, order, aimed])
    if not vehicle or not stop:
        return False

    mem = getattr(_smart_event_recalage_boost, "_mem", {})
    old = mem.get(key)

    def parse_dt(v):
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone()
        except Exception:
            return None

    boost = False

    if old:
        if str(delay_s or "") != str(old.get("delay_s") or ""):
            boost = True

        old_dt = parse_dt(old.get("expected_s"))
        new_dt = parse_dt(expected_s)

        if old_dt and new_dt:
            if abs((new_dt - old_dt).total_seconds()) >= 10:
                boost = True
        elif str(expected_s or "") != str(old.get("expected_s") or ""):
            boost = True

    mem[key] = {
        "delay_s": str(delay_s or ""),
        "expected_s": str(expected_s or ""),
        "ts": time.time(),
    }

    if len(mem) > 2000:
        now = time.time()
        mem = {k:v for k,v in mem.items() if now - v.get("ts", 0) < 900}

    _smart_event_recalage_boost._mem = mem
    return boost



def smart_call_time(call, bus=None):
    """
    Heure intelligente V3 :
    - expectedTime est utilisé s'il est cohérent.
    - si expectedTime paraît aberrant par rapport au retard/avance annoncé,
      on recalcule depuis aimedTime + retard/avance.
    - le GPS ne sert pas ici : moteur basé sur horaire + retard/avance + heure actuelle.
    """
    from datetime import datetime, timedelta

    call = call or {}
    bus = bus or {}

    aimed_s = str(call.get("aimedTime") or "").strip()
    expected_s = str(call.get("expectedTime") or "").strip()
    delay_s = str(bus.get("retard") or call.get("retard") or "").strip()

    aimed = None
    expected = None

    try:
        if aimed_s:
            aimed = datetime.fromisoformat(aimed_s.replace("Z", "+00:00")).astimezone()
    except Exception:
        aimed = None

    try:
        if expected_s:
            expected = datetime.fromisoformat(expected_s.replace("Z", "+00:00")).astimezone()
    except Exception:
        expected = None

    delay_sec = delay_seconds(delay_s)
    event_boost = _smart_event_recalage_boost(call, bus, delay_s, expected_s)

    # Sans retard/avance fiable, on ne corrige pas brutalement :
    # Bus Tracker peut annoncer un vrai départ futur au terminus.
    if not delay_s:
        return expected or aimed

    corrected = aimed + timedelta(seconds=delay_sec) if aimed is not None else None

    if expected is not None and corrected is not None:
        diff = abs((expected - corrected).total_seconds())

        # Tolérance volontaire : si Bus Tracker est proche du calcul retard/avance,
        # on garde expectedTime. Sinon on corrige pour éviter les sauts absurdes.
        # Recalage événementiel V6 :
        # si avance/retard ou expectedTime vient de changer,
        # on accepte plus vite le recalage calculé.
        tolerance = 45 if event_boost else 180

        if diff <= tolerance:
            return expected
        return corrected

    return expected or corrected or aimed



def proximity_window(prev_call=None, target_call=None, next_call=None, bus=None):
    """
    Fenêtre V3 adaptative pour "À proximité".
    Base principale : temps théorique/live entre arrêts via smart_call_time.
    Objectif terrain :
    - segments courts / arrêts rapprochés : fenêtre courte
    - segments longs : fenêtre plus confortable
    - sortie après arrêt plus courte pour éviter de rester collé à l'arrêt dépassé
    """
    try:
        bus = bus or {}

        prev_t = smart_call_time(prev_call, bus) if prev_call else None
        target_t = smart_call_time(target_call, bus) if target_call else None
        next_t = smart_call_time(next_call, bus) if next_call else None

        before_seg = None
        after_seg = None

        if prev_t and target_t:
            before_seg = max(1, (target_t - prev_t).total_seconds())
        if target_t and next_t:
            after_seg = max(1, (next_t - target_t).total_seconds())

        seg = after_seg or before_seg or 90

        # Fenêtres volontairement prudentes V1 :
        # on raccourcit surtout la sortie après passage.
        if seg <= 45:
            before_s, after_s = 5, 3
        elif seg <= 75:
            before_s, after_s = 7, 4
        elif seg <= 120:
            before_s, after_s = 9, 6
        elif seg <= 210:
            before_s, after_s = 11, 8
        else:
            before_s, after_s = 13, 10

        # Si le véhicule est en avance, on rend la sortie un peu plus agressive.
        d = delay_seconds(bus.get("retard"))
        if d < -30:
            after_s = max(3, after_s - 2)
        elif d > 180:
            before_s = min(15, before_s + 1)

        return before_s, after_s
    except Exception:
        return 10, 10



def transport_icon(line):
    n = str(line).upper()
    if n.startswith("PL"):
        return "🌙"
    if n == "RX" or "RHONEXPRESS" in n or "RHÔNEXPRESS" in n:
        return "🚄"
    if n.startswith("JD"):
        return "🚌"
    if n.startswith("T") and not n.startswith("TB"):
        return "🚊"
    if n.startswith("TB"):
        return "🚎"
    if n.startswith("C"):
        return "🚍"
    return "🚌"



def load_sequences():
    stops = {}
    with (GTFS / "stops.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            stops[r["stop_id"]] = r["stop_name"]

    route_ids = {}
    with (GTFS / "routes.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            short = r.get("route_short_name", "")
            route_id = r.get("route_id", "")
            if short and route_id:
                route_ids.setdefault(short, set()).add(route_id)

    trips = {}
    with (GTFS / "trips.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            for line, ids in route_ids.items():
                if r.get("route_id") in ids:
                    headsign = r.get("trip_headsign", "")
                    trips.setdefault(line, {})
                    if headsign not in trips[line]:
                        trips[line][headsign] = r["trip_id"]

    rows_by_trip = {}
    with (GTFS / "stop_times.txt").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows_by_trip.setdefault(r["trip_id"], []).append(r)

    sequences = {}

    for line, heads in trips.items():
        sequences[line] = {}
        for headsign, trip_id in heads.items():
            seq = []
            for r in rows_by_trip.get(trip_id, []):
                name = stops.get(r["stop_id"], "")
                if name:
                    seq.append((int(r["stop_sequence"]), name))
            seq.sort()
            sequences[line][headsign] = [name for _, name in seq]

    return sequences



SEQUENCES = load_sequences()



def _stop_key(v):
    import unicodedata
    v = str(v or "").strip().lower()
    v = unicodedata.normalize("NFD", v)
    v = "".join(c for c in v if unicodedata.category(c) != "Mn")
    return " ".join(v.replace("-", " ").replace(".", " ").split())



def _find_stop_index(seq, current_stop):
    cur = _stop_key(current_stop)
    if not cur:
        return 0

    for i, stop in enumerate(seq):
        if _stop_key(stop) == cur:
            return i

    for i, stop in enumerate(seq):
        st = _stop_key(stop)
        if cur in st or st in cur:
            return i

    return 0



def mission_memory_key(line, bus, calls=None):
    """
    Clé mémoire V3 strictement liée à une mission.
    Évite de mélanger deux sens/courses du même véhicule.
    """
    calls = list(calls or bus.get("bt_calls") or [])
    vehicle = str(bus.get("vehicule") or bus.get("vehicle_id") or bus.get("bt_vehicle_id") or "").strip()
    dest = str(bus.get("bt_destination") or bus.get("destination") or "").strip()
    direction = str(bus.get("bt_direction") or bus.get("direction") or "").strip()
    path = str(bus.get("bt_path_ref") or bus.get("trip_id") or "").strip()

    first_stop = ""
    last_stop = ""
    if calls:
        first_stop = str(calls[0].get("stopName") or "").strip()
        last_stop = str(calls[-1].get("stopName") or "").strip()

    return "|".join([
        str(line or "").strip(),
        vehicle,
        dest,
        direction,
        path,
        first_stop,
        last_stop,
    ])



def logical_bt_calls_for_time(bt_calls, bus):
    """
    V3 moteur horaire :
    Bus Tracker fournit la mission, mais ne pilote plus l'avancement.
    On avance dans bt_calls selon heure actuelle + expectedTime/aimedTime + retard.
    """
    from datetime import datetime

    calls = list(bt_calls or [])
    if not calls:
        return calls

    now = datetime.now().astimezone()

    # Si le premier arrêt est un départ terminus encore futur ou tout juste passé,
    # on le garde pour afficher Départ dans / imminent / prévu.
    try:
        first = calls[0]
        first_order = int(first.get("stopOrder") or 0)
        first_time = smart_call_time(first, bus)
        if first_order <= 1 and first_time:
            sec_first = (first_time - now).total_seconds()
            if sec_first >= -30:
                return calls
    except Exception:
        pass

    # Sinon on saute les arrêts déjà dépassés selon le temps logique,
    # sans attendre que Bus Tracker mette à jour son prochain arrêt.
    keep_from = 0
    for i, call in enumerate(calls):
        try:
            t = smart_call_time(call, bus)
            if not t:
                continue

            prev_c = calls[i - 1] if i > 0 else None
            next_c = calls[i + 1] if i + 1 < len(calls) else None
            before_s, after_s = proximity_window(prev_c, call, next_c, bus)

            sec = (t - now).total_seconds()

            # On garde le premier arrêt qui n'est pas clairement dépassé.
            if sec > -after_s:
                keep_from = i
                break
        except Exception:
            continue
    else:
        keep_from = max(0, len(calls) - 1)

    return calls[keep_from:]



def bus_state_text(line, bus):
    from datetime import datetime
    import time
    raw_bt_calls = bus.get("bt_calls") or []
    bt_calls = logical_bt_calls_for_time(raw_bt_calls, bus)
    next_stop = str(bus.get("bt_next_stop") or "").strip()
    expected = str(bus.get("bt_next_expected_time") or "").strip()
    vehicle = str(bus.get("vehicule") or bus.get("vehicle_id") or "").strip()
    memory_key = mission_memory_key(line, bus, bt_calls) if vehicle else ""
    memory = APPROACH_MEMORY.get(memory_key) if memory_key else None

    # PATCH V6 — bascule immédiate nouvelle mission / nouveau trip_id
    try:
        current_trip = str(
            bus.get("trip_id")
            or bus.get("bt_path_ref")
            or ""
        ).strip()

        trip_vehicle = str(
            bus.get("vehicule")
            or bus.get("vehicle_id")
            or bus.get("bt_vehicle_id")
            or bus.get("vehicleRef")
            or bus.get("vehicleId")
            or ""
        ).strip()

        trip_key = str(line or "").strip() + "|" + trip_vehicle

        if trip_key and current_trip:
            prev_trip = ACTIVE_TRIPS.get(trip_key)

            if prev_trip and prev_trip != current_trip:
                for k in list(APPROACH_MEMORY.keys()):
                    if trip_vehicle and trip_vehicle in k:
                        APPROACH_MEMORY.pop(k, None)

                try:
                    mem = getattr(mini_line_for_bus, "_timeline_v3_memory", {})
                    if isinstance(mem, dict):
                        for k in list(mem.keys()):
                            if trip_vehicle and trip_vehicle in k:
                                mem.pop(k, None)
                        mini_line_for_bus._timeline_v3_memory = mem
                except Exception:
                    pass

                print(f"🔄 Nouvelle mission détectée {trip_key}: {prev_trip} -> {current_trip}")

            ACTIVE_TRIPS[trip_key] = current_trip

    except Exception as e:
        print("❌ trip switch:", e)

    if memory and time.time() - memory.get("ts", 0) <= APPROACH_MEMORY_TTL:
        mem_stop = str(memory.get("stop") or "").strip()
        if mem_stop:
            return "À proximité · " + mem_stop

    if bt_calls:
        try:
            first = bt_calls[0]
            order = int(first.get("stopOrder") or 0)
            stop = str(first.get("stopName") or next_stop or "").strip()
            exp = str(first.get("expectedTime") or first.get("aimedTime") or expected or "")

            dt = smart_call_time(first, bus)
            if dt:
                now = datetime.now().astimezone()
                sec = int((dt - now).total_seconds())
                hhmm = dt.strftime("%Hh%M")

                if order <= 1:
                    current_stop = str(bus.get("arret_courant") or "").strip()
                    first_stop = str(stop or "").strip()

                    # Départ terminus seulement si l'arrêt courant correspond vraiment
                    # au premier arrêt de la mission. Sinon on continue le moteur normal.
                    is_real_departure_stop = (
                        current_stop and
                        first_stop and
                        _stop_key(current_stop) == _stop_key(first_stop)
                    )

                    if is_real_departure_stop:
                        # Départ terminus fiable uniquement si l'heure n'est pas trop ancienne.
                        # Si Bus Tracker garde une vieille course au terminus sans retard fiable,
                        # on évite le faux "Départ retardé" anxiogène.
                        if sec > 120:
                            minutes = (sec + 59) // 60
                            return f"Départ dans {minutes} min · {hhmm}"
                        if sec >= 0:
                            return f"Départ imminent · {hhmm}"
                        if sec >= -10:
                            return f"Départ prévu · {hhmm}"

                        if not str(bus.get("retard") or "").strip():
                            return f"En attente du prochain départ"

                        return f"Départ retardé · {hhmm}"

                # Scan global V3 :
                # tous les prochains arrêts peuvent déclencher "À proximité",
                # pas seulement bt_calls[0].
                approach_hit = None

                for j, call in enumerate(bt_calls[:12]):
                    cstop = str(call.get("stopName") or "").strip()
                    cdt = smart_call_time(call, bus)
                    if not cstop or not cdt:
                        continue

                    csec = int((cdt - now).total_seconds())
                    prev_c = bt_calls[j - 1] if j > 0 else None
                    next_c = bt_calls[j + 1] if j + 1 < len(bt_calls) else None
                    before_s, after_s = proximity_window(prev_c, call, next_c, bus)

                    if -before_s <= csec <= after_s:
                        score = abs(csec)
                        if approach_hit is None or score < approach_hit[0]:
                            approach_hit = (score, cstop)

                if approach_hit:
                    hit_stop = approach_hit[1]
                    if memory_key:
                        APPROACH_MEMORY[memory_key] = {"stop": hit_stop, "ts": time.time()}
                    return "À proximité · " + hit_stop

            # Si l'arrêt courant est dépassé, choisir le prochain arrêt logique futur.
            if exp and len(bt_calls) > 1:
                for j, call in enumerate(bt_calls[:12]):
                    cdt = smart_call_time(call, bus)
                    cstop = str(call.get("stopName") or "").strip()
                    if not cdt or not cstop:
                        continue
                    csec = int((cdt - datetime.now().astimezone()).total_seconds())
                    prev_c = bt_calls[j - 1] if j > 0 else None
                    next_c = bt_calls[j + 1] if j + 1 < len(bt_calls) else None
                    before_s, after_s = proximity_window(prev_c, call, next_c, bus)
                    if csec > after_s:
                        return "Prochain arrêt " + cstop

            if stop:
                return "Prochain arrêt " + stop
        except Exception:
            pass

    if bus.get("bt_source") == "bus_tracker" and not bt_calls:
        return "Terminus"

    if next_stop:
        return "Prochain arrêt " + next_stop

    return ""





def is_terminal_call_locked(bus, bt_calls):
    """
    Verrou terminus strict :
    - verrouille si le véhicule est réellement posé sur sa destination ;
    - ne verrouille plus uniquement parce que l'heure théorique du dernier arrêt est passée ;
    - évite donc le faux terminus un ou deux arrêts avant.
    """
    try:
        dest = str(bus.get("bt_destination") or bus.get("destination") or "").strip()
        current_stop = str(bus.get("arret_courant") or "").strip()

        if dest and current_stop and _stop_key(current_stop) == _stop_key(dest):
            return True

        calls = list(bt_calls or bus.get("bt_calls") or [])
        if not calls:
            return False

        last_stop = str(calls[-1].get("stopName") or "").strip()
        if not dest or not last_stop:
            return False

        if _stop_key(dest) != _stop_key(last_stop):
            return False

        # Sécurité : si arret_courant existe et n'est pas le terminus,
        # on ne verrouille pas. Le moteur normal continue.
        if current_stop and _stop_key(current_stop) != _stop_key(dest):
            return False

        next_stop = str(bus.get("bt_next_stop") or "").strip()
        if next_stop and _stop_key(next_stop) == _stop_key(dest):
            t = smart_call_time(calls[-1], bus)
            if t:
                from datetime import datetime
                sec = (t - datetime.now().astimezone()).total_seconds()
                return sec <= -30

        return False
    except Exception:
        return False

def terminus_timeline_html(line, bus, stop_name=""):
    dest = str(
        stop_name
        or bus.get("bt_destination")
        or bus.get("destination")
        or bus.get("arret_courant")
        or ""
    ).strip()

    return (
        '<div class="tcl-timeline-v3 terminus">'
        '<div class="tcl-timeline-v3-rail"></div>'
        '<div class="tcl-timeline-v3-bus terminus approach proximity" style="left:10%">' + transport_icon(line) + '</div>'
        '<div class="tcl-timeline-v3-stop active approach proximity" style="left:10%">'
        '<div class="tcl-timeline-v3-dot"></div>'
        '<div class="tcl-timeline-v3-name">' + escape(dest) + '</div>'
        '</div></div>'
    )

def mini_line_for_bus(line, bus):
    # La timeline garde le contexte complet de la mission pour afficher
    # les arrêts passés à gauche. L'arrêt actif reste choisi par bus_state_text(),
    # qui utilise le moteur horaire logique.
    bt_calls = bus.get("bt_calls") or []

    if bt_calls:
        if is_terminal_call_locked(bus, logical_bt_calls_for_time(bt_calls, bus)):
            dest = str(bus.get("bt_destination") or bus.get("destination") or bt_calls[-1].get("stopName") or "")
            return terminus_timeline_html(line, bus, dest)
        state = bus_state_text(line, bus)

        if state in ("Arrivé au terminus", "Terminus"):
            dest = str(bus.get("bt_destination") or bus.get("destination") or bt_calls[-1].get("stopName") or "")
            return (
                '<div class="tcl-timeline-v3 terminus">'
                '<div class="tcl-timeline-v3-rail"></div>'
                '<div class="tcl-timeline-v3-bus terminus approach proximity" style="left:10%">' + transport_icon(line) + '</div>'
                '<div class="tcl-timeline-v3-stop active approach proximity" style="left:10%">'
                '<div class="tcl-timeline-v3-dot"></div>'
                '<div class="tcl-timeline-v3-name">' + escape(dest) + '</div>'
                '</div></div>'
            )

        active_stop = ""
        is_approach = False

        if state.startswith("À proximité · "):
            active_stop = state.replace("À proximité · ", "", 1).strip()
            is_approach = True
        elif state.startswith("Prochain arrêt "):
            active_stop = state.replace("Prochain arrêt ", "", 1).strip()

        calls = list(bt_calls)

        idx = -1
        if active_stop:
            for j, c in enumerate(calls):
                name = str(c.get("stopName") or "").strip()
                if name.lower() == active_stop.lower():
                    idx = j
                    break

        slots = [10, 30, 50, 70, 90]

        # Mémoire Timeline V3 :
        # Bus Tracker ne renvoie pas toujours les anciens arrêts.
        # On garde donc une petite mémoire par ligne / véhicule / destination
        # pour pouvoir afficher idéalement 2 arrêts passés à gauche.
        try:
            mem = getattr(mini_line_for_bus, "_timeline_v3_memory", {})
            if not isinstance(mem, dict):
                mem = {}

            vehicle_key = (
                bus.get("vehicleRef")
                or bus.get("vehicleId")
                or bus.get("vehicle")
                or bus.get("id")
                or bus.get("car")
                or bus.get("numero")
                or bus.get("bt_vehicle")
                or bus.get("bt_vehicle_id")
                or ""
            )
            mem_key = mission_memory_key(line, bus, calls)

            live_names = []
            for c in calls:
                n = str(c.get("stopName") or "").strip()
                if n and (not live_names or live_names[-1].lower() != n.lower()):
                    live_names.append(n)

            old_names = mem.get(mem_key, [])
            if not isinstance(old_names, list):
                old_names = []

            merged_names = list(old_names)

            if live_names:
                # Si l'arrêt actif existe déjà en mémoire, on garde ce qui précède
                # puis on recolle la séquence live actuelle.
                if active_stop:
                    active_l = active_stop.lower()
                    old_pos = next((k for k, n in enumerate(merged_names) if str(n).lower() == active_l), None)
                    live_pos = next((k for k, n in enumerate(live_names) if str(n).lower() == active_l), None)

                    if old_pos is not None and live_pos is not None:
                        merged_names = merged_names[:old_pos] + live_names[live_pos:]
                    else:
                        for n in live_names:
                            if not merged_names or merged_names[-1].lower() != n.lower():
                                if n.lower() not in [x.lower() for x in merged_names[-8:]]:
                                    merged_names.append(n)
                else:
                    for n in live_names:
                        if not merged_names or merged_names[-1].lower() != n.lower():
                            if n.lower() not in [x.lower() for x in merged_names[-8:]]:
                                merged_names.append(n)

            merged_names = merged_names[-40:]
            mem[mem_key] = merged_names
            mini_line_for_bus._timeline_v3_memory = mem

            display_calls = list(calls)
            display_idx = idx

            # Si Bus Tracker ne donne pas assez d'arrêts avant l'actif,
            # on préfixe avec les anciens arrêts mémorisés.
            if idx >= 0 and active_stop:
                active_l = active_stop.lower()
                hist_pos = next((k for k, n in enumerate(merged_names) if str(n).lower() == active_l), None)

                if hist_pos is not None:
                    history_before = merged_names[max(0, hist_pos - 2):hist_pos]
                    live_before = [
                        str(c.get("stopName") or "").strip().lower()
                        for c in calls[:idx]
                    ]

                    missing = []
                    for n in history_before:
                        if n and n.lower() not in live_before:
                            missing.append({"stopName": n, "_timeline_memory": True})

                    if missing:
                        display_calls = missing + display_calls
                        display_idx = idx + len(missing)

        except Exception:
            display_calls = list(calls)
            display_idx = idx

        # Timeline GTFS + notre moteur :
        # - SEQUENCES donne la liste complète et stable des arrêts
        # - bus_state_text() donne l'arrêt actif calculé par notre logique
        # - Bus Tracker ne décide plus de la fenêtre visuelle
        try:
            display_calls = list(calls)
            display_idx = idx

            seqs = SEQUENCES.get(str(line), {})
            dest = str(bus.get("bt_destination") or bus.get("destination") or "").strip()
            best_seq = None

            if seqs:
                if dest:
                    dest_key = _stop_key(dest)
                    for headsign, seq in seqs.items():
                        hkey = _stop_key(headsign)
                        if hkey == dest_key or dest_key in hkey or hkey in dest_key:
                            best_seq = seq
                            break

                if best_seq is None and len(seqs) == 1:
                    best_seq = list(seqs.values())[0]

            if best_seq and active_stop:
                gtfs_idx = _find_stop_index(best_seq, active_stop)
                display_calls = [{"stopName": n, "_gtfs_sequence": True} for n in best_seq]
                display_idx = gtfs_idx

        except Exception:
            display_calls = list(calls)
            display_idx = idx

        total_calls = len(display_calls)

        # Timeline par segments glissants :
        # le bus traverse toute la fenêtre 10 → 30 → 50 → 70 → 90.
        # On ne décale la fenêtre qu'après avoir atteint le bout visible.
        if total_calls <= 5:
            start = 0
            active_slot = max(0, display_idx) if display_idx >= 0 else 0
        elif display_idx < 0:
            start = 0
            active_slot = 0
        else:
            start = (display_idx // 5) * 5

            if start > total_calls - 5:
                start = max(0, total_calls - 5)

            active_slot = display_idx - start

            if active_slot < 0:
                active_slot = 0
            elif active_slot > 4:
                active_slot = 4

        selected = []
        for slot_i in range(5):
            gi = start + slot_i
            if 0 <= gi < len(display_calls):
                selected.append((slot_i, gi, display_calls[gi]))
            else:
                selected.append((slot_i, None, None))

        # UX V3 : dès que possible, on garde le bus visuellement centré.
        # Début/fin de ligne conservent leur position logique.
        bus_left = slots[active_slot]
        if 0 < active_slot < len(slots) - 1:
            bus_left = 50

        # Départ terminus : tant que le bus est en état départ,
        # il reste visuellement calé au terminus. Il ne part pas avant mission engagée.
        is_departure_state = (
            state.startswith("Départ dans")
            or state.startswith("Départ imminent")
            or state.startswith("Départ prévu")
            or state.startswith("Départ retardé")
        )

        # Pourcentage réel entre arrêt précédent et arrêt cible.
        # V3.1 : même si bt_calls commence au prochain arrêt (idx=0),
        # on tente d'utiliser l'arrêt courant SIRI comme point précédent logique.
        if (not is_approach) and (not is_departure_state):
            try:
                from datetime import datetime, timedelta

                target_call = calls[idx] if idx >= 0 and idx < len(calls) else (calls[0] if calls else None)
                prev_call = calls[idx - 1] if idx > 0 else None

                t2 = smart_call_time(target_call, bus) if target_call else None
                t1 = smart_call_time(prev_call, bus) if prev_call else None

                # Si Bus Tracker ne fournit pas l'arrêt précédent, on estime un point de départ
                # à partir du temps entre target et next. Cela évite pct=0% permanent.
                if t1 is None and t2 is not None:
                    next_call = calls[idx + 1] if idx >= 0 and idx + 1 < len(calls) else None
                    t3 = smart_call_time(next_call, bus) if next_call else None
                    if t3 and t3 > t2:
                        next_seg = (t3 - t2).total_seconds()

                        # Segment dynamique V3 :
                        # si prochain arrêt très loin, on évite pct=0 figé.
                        sec_to_target = (t2 - datetime.now().astimezone()).total_seconds()

                        if sec_to_target > 180:
                            segment = max(120, min(240, sec_to_target * 0.55))
                        elif sec_to_target > 90:
                            segment = max(90, min(180, sec_to_target * 0.75))
                        else:
                            segment = max(45, min(120, next_seg))
                    else:
                        sec_to_target = (t2 - datetime.now().astimezone()).total_seconds()

                        if sec_to_target > 180:
                            segment = 180
                        elif sec_to_target > 90:
                            segment = 120
                        else:
                            segment = 90
                    t1 = t2 - timedelta(seconds=segment)

                if t1 and t2:
                    now = datetime.now().astimezone()

                    total = (t2 - t1).total_seconds()
                    elapsed = (now - t1).total_seconds()

                    if total > 0:
                        pct = max(0, min(1, elapsed / total))

                        # Règle métier V3 :
                        # "Prochain arrêt" = le bus approche, mais ne doit pas être pile sur le rond.
                        # "À proximité" = seul état où le bus est exactement sur le rond et devient vert.
                        if state.startswith("Prochain arrêt "):
                            pct = min(pct, 0.98)

                        prev_slot = max(0, active_slot - 1)
                        left_a = slots[prev_slot]
                        left_b = slots[active_slot]

                        bus_left = left_a + ((left_b - left_a) * pct)
            except Exception:
                pass

        # À proximité = zone dynamique autour de l'arrêt :
        # - avant l'heure estimée : le bus arrive vert sur les 20% finaux du segment
        # - à l'heure estimée : il est pile sur le rond
        # - après l'heure estimée : il quitte doucement l'arrêt sur 10% du segment suivant
        if is_approach and idx >= 0:
            try:
                from datetime import datetime

                target_call = calls[idx]
                t2 = smart_call_time(target_call, bus)

                if t2:
                    now = datetime.now().astimezone()
                    sec_from_stop = (now - t2).total_seconds()

                    prev_slot = max(0, active_slot - 1)
                    next_slot = min(len(slots) - 1, active_slot + 1)

                    stop_left = slots[active_slot]
                    prev_left = slots[prev_slot]
                    next_left = slots[next_slot]

                    before_start = stop_left - ((stop_left - prev_left) * 0.20)
                    after_end = stop_left + ((next_left - stop_left) * 0.10)

                    prev_call = calls[idx - 1] if idx > 0 else None
                    next_call = calls[idx + 1] if idx + 1 < len(calls) else None
                    before_s, after_s = proximity_window(prev_call, target_call, next_call, bus)

                    if sec_from_stop < 0:
                        # fenêtre adaptative : -before_s → before_start ; 0s → stop_left
                        k = max(0, min(1, (sec_from_stop + before_s) / before_s))
                        bus_left = before_start + ((stop_left - before_start) * k)
                    elif sec_from_stop > 0:
                        # fenêtre adaptative : 0s → stop_left ; +after_s → after_end
                        k = max(0, min(1, sec_from_stop / after_s))
                        bus_left = stop_left + ((after_end - stop_left) * k)
                    else:
                        bus_left = stop_left

            except Exception:
                bus_left = slots[active_slot]

        bus_classes = "tcl-timeline-v3-bus"
        if is_approach:
            bus_classes += " approach proximity"

        html = (
            '<div class="tcl-timeline-v3">'
            '<div class="tcl-timeline-v3-rail"></div>'
            '<div class="' + bus_classes + '" style="left:' + str(round(bus_left, 2)) + '%">' + transport_icon(line) + '</div>'
        )

        for slot_i, original_i, call in selected:
            if call is None:
                html += '<div class="tcl-timeline-v3-stop ghost" style="left:' + str(slots[slot_i]) + '%"><div class="tcl-timeline-v3-dot"></div><div class="tcl-timeline-v3-name"></div></div>'
                continue

            stop = str(call.get("stopName") or "").strip()
            classes = ["tcl-timeline-v3-stop"]

            if display_idx >= 0 and original_i is not None:
                if original_i < display_idx:
                    classes.append("past")
                elif original_i == display_idx:
                    classes.append("active")
                else:
                    classes.append("future")

            if is_approach and original_i == display_idx:
                classes.append("approach")

            html += (
                '<div class="' + " ".join(classes) + '" style="left:' + str(slots[slot_i]) + '%">'
                '<div class="tcl-timeline-v3-dot"></div>'
                '<div class="tcl-timeline-v3-name">' + escape(stop) + '</div>'
                '</div>'
            )

        html += '</div>'
        return html

    dest = str(bus.get("bt_destination") or bus.get("destination") or "")
    if dest:
        return (
            '<div class="tcl-timeline-v3 terminus">'
            '<div class="tcl-timeline-v3-rail"></div>'
            '<div class="tcl-timeline-v3-bus terminus approach proximity" style="left:10%">' + transport_icon(line) + '</div>'
            '<div class="tcl-timeline-v3-stop active approach proximity" style="left:10%">'
            '<div class="tcl-timeline-v3-dot"></div>'
            '<div class="tcl-timeline-v3-name">' + escape(dest) + '</div>'
            '</div></div>'
        )

    return '<div class="tcl-timeline-v3"><div class="tcl-timeline-v3-rail"></div></div>'



def sort_buses(buses):
    return sorted(
        buses,
        key=lambda b: (
            0 if b.get("direction") == "inbound" else 1,
            int(b.get("ordre") or 0),
            str(b.get("vehicule") or "")
        )
    )



def dedupe_buses_by_vehicle(line, buses):
    """
    Un véhicule ne doit jamais apparaître deux fois sur la même ligne.
    Les flux TCL peuvent garder une ancienne mission au terminus pendant qu'une nouvelle existe déjà.
    """
    grouped = {}
    for b in buses:
        vehicle = str(b.get("vehicule") or b.get("vehicle_id") or "").strip()
        if not vehicle:
            vehicle = f"no_vehicle_{len(grouped)}"
        grouped.setdefault(vehicle, []).append(b)

    cleaned = []

    for vehicle, items in grouped.items():
        if len(items) == 1:
            cleaned.append(items[0])
            continue

        def score(b):
            dest = str(b.get("destination") or "").strip().lower()
            stop = str(b.get("arret_courant") or "").strip().lower()

            # IMPORTANT :
            # Sur TCL/Bus Tracker, un véhicule au terminus peut encore afficher
            # destination == arrêt courant pendant quelques secondes/minutes
            # avant de recevoir sa nouvelle mission.
            #
            # Exemple réel C10 :
            # arrivée Bellecour puis futur départ Barolles/Brignais.
            #
            # Il ne faut donc PAS supprimer agressivement ces véhicules,
            # sinon des bus réels disparaissent totalement de l'interface.

            at_own_terminus = (
                dest and stop and (
                    dest == stop or
                    dest in stop or
                    stop in dest
                )
            )

            s = 0

            # Petite pénalité légère seulement.
            # On évite juste les vieux doublons totalement figés,
            # sans supprimer les vrais véhicules au terminus.
            if at_own_terminus:
                s -= 5
            if b.get("latitude") or b.get("lat"):
                s += 10
            if b.get("longitude") or b.get("lon"):
                s += 10
            if b.get("retard"):
                s += 1
            return s

        best = sorted(items, key=score, reverse=True)[0]
        cleaned.append(best)

    return cleaned




def terminus_vehicle_key(line, bus):
    vehicle = str(bus.get("vehicule") or bus.get("vehicle_id") or bus.get("bt_vehicle_id") or "").strip()
    return str(line or "").strip() + "|" + vehicle if vehicle else ""


def terminus_departure_really_started(bus, bt_calls):
    """
    Déverrouillage terminus strict :
    on ne sort du terminus que si une vraie nouvelle mission est engagée,
    avec un premier arrêt différent du terminus.
    """
    if not bt_calls:
        return False

    try:
        calls = list(bt_calls or [])
        dest = str(bus.get("bt_destination") or bus.get("destination") or "").strip()
        next_stop = str(bus.get("bt_next_stop") or "").strip()

        first = calls[0]
        first_stop = str(first.get("stopName") or "").strip()
        first_order = int(first.get("stopOrder") or 0)
        first_time = smart_call_time(first, bus)

        if dest and next_stop and _stop_key(next_stop) == _stop_key(dest):
            return False

        if dest and first_stop and _stop_key(first_stop) == _stop_key(dest):
            return False

        if first_order > 2:
            return True

        if first_time:
            from datetime import datetime
            sec = (first_time - datetime.now().astimezone()).total_seconds()
            return sec < -20

    except Exception:
        pass

    return False

def terminus_arrival_reached(bus, bt_calls):
    """
    Arrivée terminus stricte :
    l'heure seule ne suffit plus si arret_courant indique encore un autre arrêt.
    """
    if not bt_calls:
        return False

    try:
        dest = str(bus.get("bt_destination") or bus.get("destination") or "").strip()
        current_stop = str(bus.get("arret_courant") or "").strip()

        if dest and current_stop and _stop_key(current_stop) == _stop_key(dest):
            return True

        if current_stop and dest and _stop_key(current_stop) != _stop_key(dest):
            return False

        last = bt_calls[-1]
        last_stop = str(last.get("stopName") or "").strip()
        last_time = smart_call_time(last, bus)

        if not dest or not last_stop or not last_time:
            return False

        if _stop_key(dest) != _stop_key(last_stop):
            return False

        next_stop = str(bus.get("bt_next_stop") or "").strip()
        if next_stop and _stop_key(next_stop) == _stop_key(dest):
            from datetime import datetime
            sec = (last_time - datetime.now().astimezone()).total_seconds()
            return sec <= -30

        return False
    except Exception:
        return False

def render_cards(line):
    buses = sort_buses(dedupe_buses_by_vehicle(line, load_live_for_line(line)))

    if not buses:
        return '<div class="empty">Aucun véhicule localisé actuellement sur cette ligne.</div>'

    html = ""

    for b in buses:

        current_stop = str(b.get("arret_courant") or "").strip()
        current_dest = str(b.get("bt_destination") or b.get("destination") or "").strip()

        raw_bt_calls_now = b.get("bt_calls") or []
        bt_calls_full = list(raw_bt_calls_now or [])
        bt_calls_now = logical_bt_calls_for_time(raw_bt_calls_now, b)

        term_vehicle_key = terminus_vehicle_key(line, b)

        # TERMINUS CLEAN :
        # On verrouille uniquement si :
        # 1) l'heure officielle corrigée du dernier arrêt est atteinte,
        # 2) ou le véhicule est explicitement posé sur son terminus courant,
        # 3) ou il était déjà verrouillé ET la nouvelle course n'a pas réellement démarré.
        #
        # Important : absence de bt_calls seule != terminus.
        # Cela évite de verrouiller un bus à l'avant-dernier arrêt quand Bus Tracker
        # ne renvoie plus les prochains appels.
        is_real_terminal_stop = (
            current_stop
            and current_dest
            and _stop_key(current_stop) == _stop_key(current_dest)
        )

        is_silent_terminal = (
            current_dest
            and not bt_calls_now
            and not str(b.get("bt_next_stop") or "").strip()
            and not str(b.get("arret_courant") or "").strip()
            and int(b.get("ordre_total") or 0) == 0
        )

        is_terminus = (
            is_terminal_call_locked(b, bt_calls_full)
            or terminus_arrival_reached(b, bt_calls_full)
            or is_real_terminal_stop
            or is_silent_terminal
            or (
                term_vehicle_key
                and term_vehicle_key in TERMINUS_MEMORY
                and not terminus_departure_really_started(b, bt_calls_now)
            )
        )

        if term_vehicle_key and terminus_departure_really_started(b, bt_calls_now):
            TERMINUS_MEMORY.pop(term_vehicle_key, None)
            is_terminus = False

        if is_terminus and term_vehicle_key:
            import time
            TERMINUS_MEMORY[term_vehicle_key] = {
                "ts": time.time(),
                "stop": current_dest or current_stop,
            }

        dest_text = (
            "Arrivé au terminus"
            if is_terminus
            else (
                "Direction " + current_dest
                if (b.get("bt_calls") or b.get("bt_destination"))
                else "Terminus"
            )
        )

        card_class = "live-card terminus-card" if is_terminus else "live-card"

        # Sas terminus propre :
        # si le verrou terminus est actif, on ne rappelle pas bus_state_text()
        # pour éviter qu'APPROACH_MEMORY ou Bus Tracker réinjecte "À proximité"
        # ou "Prochain arrêt".
        if is_terminus:
            state_text = "Terminus"
        else:
            state_text = bus_state_text(line, b)

        if state_text == "Terminus":
            is_terminus = True
            card_class = "live-card terminus-card"
            dest_text = "Arrivé au terminus"
            state_text = "Arrivé au terminus"

        # V7 terminus verrouillé :
        # une fois arrivé au terminus, on ne revient jamais à "Prochain arrêt <terminus>"
        # tant qu'il n'y a pas une vraie nouvelle mission.
        try:
            import time
            term_key = term_vehicle_key or mission_memory_key(line, b, raw_bt_calls_now)
            now_ts = time.time()

            for k, v in list(TERMINUS_MEMORY.items()):
                if now_ts - float(v.get("ts", 0)) > TERMINUS_MEMORY_TTL:
                    TERMINUS_MEMORY.pop(k, None)

            active_terminal_stop = ""
            if state_text.startswith("À proximité · "):
                active_terminal_stop = state_text.replace("À proximité · ", "", 1).strip()
            elif state_text.startswith("Prochain arrêt "):
                active_terminal_stop = state_text.replace("Prochain arrêt ", "", 1).strip()

            # Ne pas verrouiller juste parce que "Prochain arrêt" ou "À proximité"
            # correspond au terminus. Le verrouillage est décidé plus haut par
            # terminus_arrival_reached(), is_real_terminal_stop, ou mémoire terminus.
            if term_key in TERMINUS_MEMORY and not state_text.startswith("Départ"):
                is_terminus = True
                card_class = "live-card terminus-card"
                dest_text = "Arrivé au terminus"
                state_text = "Arrivé au terminus"

        except Exception:
            pass

        # PATCH V7 TERMINUS DISPLAY GUARD :
        # Ne touche pas au moteur Bus Tracker / pct / avance-retard / proximite.
        # Si le vehicule est deja verrouille terminus par la logique existante,
        # alors l'affichage final ne doit plus reprendre "A proximite",
        # "Prochain arret" ni afficher la pilule avance-retard.
        if is_terminus:
            dest_text = "Arrivé au terminus"
            state_text = "Terminus"
            card_class = "live-card terminus-card"

        if is_terminus and not state_text:
            state_text = "Terminus"

        is_departure_wait = (
            state_text.startswith("Départ dans")
            or state_text.startswith("Départ imminent")
            or state_text.startswith("Départ prévu")
        )

        if is_terminus:
            delay_html = ""
        elif is_departure_wait:
            delay_html = f'<div class="delay {delay_class(b.get("retard"))}">{escape(delay_text(b.get("retard")))}</div>'
        else:
            delay_html = f'<div class="delay {delay_class(b.get("retard"))}">{escape(delay_text(b.get("retard")))}</div>'
        state_class = "bus-state"
        if state_text.startswith("En approche") or state_text.startswith("À proximité"):
            state_class += " state-approach"
        elif state_text.startswith("Départ imminent"):
            state_class += " state-imminent"
        elif state_text.startswith("Départ retardé"):
            state_class += " state-delayed"
        elif state_text.startswith("En attente"):
            state_class += " state-waiting"
        if state_text.startswith("Prochain arrêt "):
            state_html = f'<div class="{state_class}">{escape(state_text)} <span class="approach-badge">En approche</span></div>'
        else:
            state_html = f'<div class="{state_class}">{escape(state_text)}</div>'

        html += f"""
        <div class="{card_class}" data-vehicle="{escape(str(b.get('vehicule','?')))}">
            <div class="live-top">
                <div class="bus-pill">
    {transport_icon(line)} {escape(str(line))} · Bus {escape(str(b.get("vehicule","?")))}
    <button class="vehicle-fav-btn" type="button" data-vehicle="{escape(str(b.get("vehicule","?")))}">☆</button>
</div>
                {delay_html}
            </div>

            <div class="dest">{escape(dest_text)}</div>
            {state_html}

            {terminus_timeline_html(line, b) if is_terminus else mini_line_for_bus(line, b)}
        </div>
        """

    return html



def api_all_alerts():
    alerts = load_json(TRAFFIC, {})
    all_alerts = []
    for line, items in alerts.items():
        for item in items:
            all_alerts.append({
                "line": line,
                "level": item.get("level","warning"),
                "title": item.get("title","Perturbation"),
                "text": item.get("text","")
            })
    all_alerts.sort(key=lambda x: x["line"])
    return jsonify({"count": len(all_alerts), "alerts": all_alerts})



def sequences():
    from flask import Response
    p = Path.home() / "selfservice_data" / "processed" / "sequences.json"
    return Response(p.read_text(encoding="utf-8"), mimetype="application/json")



# === Gardes V6 core light ===
ACTIVE_TRIPS = globals().get("ACTIVE_TRIPS", {})
APPROACH_MEMORY = globals().get("APPROACH_MEMORY", {})
APPROACH_MEMORY_TTL = globals().get("APPROACH_MEMORY_TTL", 90)
SEQUENCES = globals().get("SEQUENCES", {})
TRAFFIC = globals().get("TRAFFIC", BASE / "processed" / "traffic_alerts.json")

TERMINUS_MEMORY = globals().get("TERMINUS_MEMORY", {})
TERMINUS_MEMORY_TTL = globals().get("TERMINUS_MEMORY_TTL", 900)
