import json, sqlite3, time, urllib.parse, urllib.request, math, unicodedata
from pathlib import Path

DB = Path("data/places_index.sqlite")
LYON_LAT = 45.7640
LYON_LON = 4.8357
RADIUS_M = 60000

def norm(s):
    s = str(s or "").lower().strip()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(s.replace("-", " ").replace("'", " ").split())

def dist_m(a,b,c,d):
    R=6371000
    p1,p2=math.radians(a),math.radians(c)
    dp=math.radians(c-a); dl=math.radians(d-b)
    x=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.atan2(math.sqrt(x),math.sqrt(1-x))

def init_db():
    DB.parent.mkdir(exist_ok=True)
    con=sqlite3.connect(DB)
    con.execute("CREATE TABLE IF NOT EXISTS places(id TEXT PRIMARY KEY,type TEXT,name TEXT,address TEXT,city TEXT,lat REAL,lon REAL,search TEXT)")
    con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(search, content='places', content_rowid='rowid')")
    con.commit()
    return con

def build_index():
    con=init_db()
    con.execute("DELETE FROM places")
    con.execute("DELETE FROM places_fts")
    con.commit()

    query=f"""
    [out:json][timeout:180];
    (
      nwr(around:{RADIUS_M},{LYON_LAT},{LYON_LON})["name"]["shop"];
      nwr(around:{RADIUS_M},{LYON_LAT},{LYON_LON})["name"]["amenity"];
      nwr(around:{RADIUS_M},{LYON_LAT},{LYON_LON})["name"]["office"];
      nwr(around:{RADIUS_M},{LYON_LAT},{LYON_LON})["name"]["healthcare"];
      nwr(around:{RADIUS_M},{LYON_LAT},{LYON_LON})["name"]["craft"];
      nwr(around:{RADIUS_M},{LYON_LAT},{LYON_LON})["name"]["tourism"];
      nwr(around:{RADIUS_M},{LYON_LAT},{LYON_LON})["addr:housenumber"]["addr:street"];
    );
    out center tags;
    """
    url="https://overpass-api.de/api/interpreter"
    data=urllib.parse.urlencode({"data":query}).encode()
    req=urllib.request.Request(url,data=data,headers={"User-Agent":"tcltempsreel-local-places/1.0"})
    raw=urllib.request.urlopen(req,timeout=240).read()
    js=json.loads(raw.decode("utf-8"))

    count=0
    for e in js.get("elements",[]):
        tags=e.get("tags") or {}
        lat=e.get("lat") or (e.get("center") or {}).get("lat")
        lon=e.get("lon") or (e.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue

        name=tags.get("name") or ""
        house=tags.get("addr:housenumber") or ""
        street=tags.get("addr:street") or ""
        city=tags.get("addr:city") or tags.get("addr:municipality") or tags.get("addr:postcode") or ""

        if not name and not (house and street):
            continue

        if not name:
            name=f"{house} {street}".strip()

        address=", ".join(x for x in [f"{house} {street}".strip(), city] if x)
        typ=tags.get("shop") or tags.get("amenity") or tags.get("office") or tags.get("healthcare") or tags.get("craft") or tags.get("tourism") or "address"
        search=norm(" ".join([name,address,city,typ]))

        oid=f"{e.get('type')}/{e.get('id')}"
        con.execute("INSERT OR REPLACE INTO places VALUES(?,?,?,?,?,?,?,?)",(oid,typ,name,address,city,float(lat),float(lon),search))
        count+=1

    con.execute("INSERT INTO places_fts(rowid,search) SELECT rowid,search FROM places")
    con.commit()
    con.close()
    print("LOCAL_PLACES_INDEX_BUILT", count)

def search_places(q, lat=None, lon=None, limit=8):
    if not DB.exists():
        return []
    qn=norm(q)
    if len(qn)<2:
        return []
    con=sqlite3.connect(DB)
    con.row_factory=sqlite3.Row
    tokens=[t for t in qn.split() if len(t)>1]
    fts=" ".join(t+"*" for t in tokens[:6])
    rows=con.execute("""
      SELECT p.* FROM places_fts f
      JOIN places p ON p.rowid=f.rowid
      WHERE places_fts MATCH ?
      LIMIT 80
    """,(fts,)).fetchall()
    out=[]
    for r in rows:
        d=None
        if lat is not None and lon is not None:
            d=dist_m(float(lat),float(lon),r["lat"],r["lon"])
            if d>RADIUS_M:
                continue
        out.append({
            "type":"place" if r["type"]!="address" else "address",
            "id":"",
            "name":r["name"],
            "address":r["address"],
            "lat":r["lat"],
            "lon":r["lon"],
            "distance":round(d) if d is not None else None,
            "source":"local_osm"
        })
    out.sort(key=lambda x:(x["distance"] if x["distance"] is not None else 999999, x["name"]))
    con.close()
    return out[:limit]

if __name__=="__main__":
    build_index()
