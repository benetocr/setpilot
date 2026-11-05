# The bridge itself: keeps a registry of Live objects, sends the app a
# snapshot and then only what changed, and carries out the app's writes and
# calls. It knows nothing about Live's modules, so it runs the same against
# the real Live and against the mock in tests.
#
# Threading rule from Live: the set may only be changed from update_display,
# receive_midi or a scheduled task, never from inside a listener callback.
# Listeners here only mark things as changed (or send the song position);
# writes wait in self.inbox until an allowed moment.

import json
import os
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "spec.json")) as _f:
    SPEC = json.load(_f)

KINDS = SPEC["kinds"]
LISTS = set(SPEC["lists"])
ROUTING = set(SPEC["routing"])
STRUCT = set(["tracks", "cue_points", "arrangement_clips", "mixer_device", "volume", "panning", "master_track", "devices", "parameters"])
# devices whose parameters we follow (all others: name only; a synth can have
# thousands of parameters)
OWN_DEVICE_PREFIX = "SetPilot"
CLASS_KIND = {
    "Song": "song", "Track": "track", "Clip": "clip", "CuePoint": "cue",
    "MixerDevice": "mixer", "DeviceParameter": "param", "View": "view",
    "Device": "device", "PluginDevice": "device", "AuPluginDevice": "device", "MaxDevice": "device",
    "RackDevice": "device", "SimplerDevice": "device", "Eq8Device": "device", "CompressorDevice": "device",
}


def has(obj, name):
    # Live raises RuntimeError (not AttributeError) for properties an object
    # of that class lacks, e.g. "Main track has no 'mute' property"
    try:
        getattr(obj, name)
        return True
    except Exception:
        return False


def now_ms():
    return time.time() * 1000.0


def ptr_of(obj):
    p = getattr(obj, "_live_ptr", None)
    return p if p is not None else id(obj)


def route_id(rt):
    name = "%s|%s" % (getattr(rt, "display_name", ""), getattr(rt, "category", ""))
    return zlib.crc32(name.encode("utf-8")) & 0x3fffffff


def route_wire(rt):
    if rt is None:
        return None
    return {"display_name": getattr(rt, "display_name", ""), "identifier": route_id(rt)}


class Bridge(object):
    def __init__(self, song, app=None, send=None, log=None, live_version="", warp_marker_factory=None):
        self.song = song
        self.app = app
        self.send = send or (lambda msg: None)     # broadcast to every client
        self.log = log or (lambda m: None)
        self.live_version = live_version
        self.make_marker = warp_marker_factory
        self.ids = {}          # ptr -> id
        self.objs = {}         # id -> (obj, kind)
        self.watch = {}        # id -> [(obj, prop, fn)]
        self.extra = {}        # id -> set(props asked for lazily)
        self.next_id = 1
        self.dirty = set()     # (id, prop)
        self.struct_dirty = True
        self.inbox = []        # (client, msg) waiting for an allowed moment
        self.aw = 0            # last write number carried out
        self.last_time_sent = 0
        self.last_meter_flush = 0
        self.meter_dirty = set()
        self.roots = {}
        self.stats = {"ticks": 0, "tick_ms": [], "doorbells": 0, "time_msgs": 0, "cmds": 0, "cmd_lag_ms": []}
        self.marker_style = None
        self._last_tick = None
        self.sweep()

    # ------------------------------------------------------------ registry
    def ref(self, obj, kind=None):
        if obj is None:
            return 0
        p = ptr_of(obj)
        i = self.ids.get(p)
        if i is None:
            i = self.next_id
            self.next_id += 1
            self.ids[p] = i
            k = kind or CLASS_KIND.get(type(obj).__name__, "obj")
            self.objs[i] = (obj, k)
            self._listen(i, obj, k)
        return i

    def _listen(self, i, obj, kind):
        hooks = []
        for prop in KINDS.get(kind, []):
            if not has(obj, prop):
                continue
            try:
                add = getattr(obj, "add_%s_listener" % prop)
            except Exception:
                continue
            fn = self._make_listener(i, prop)
            try:
                add(fn)
                hooks.append((obj, prop, fn))
            except Exception:
                pass
        self.watch[i] = hooks

    def _make_listener(self, i, prop):
        if prop == "current_song_time":
            return self._on_time
        if prop == "output_meter_level":
            def meter():
                self.meter_dirty.add(i)
            return meter
        if prop in STRUCT:
            def structural():
                self.dirty.add((i, prop))
                self.struct_dirty = True
            return structural

        if prop == "value":
            def value_changed():
                self.dirty.add((i, "value"))
                self.dirty.add((i, "display"))
            return value_changed

        def changed():
            self.dirty.add((i, prop))
        return changed

    def forget(self, i):
        for obj, prop, fn in self.watch.pop(i, []):
            try:
                getattr(obj, "remove_%s_listener" % prop)(fn)
            except Exception:
                pass
        o = self.objs.pop(i, None)
        if o:
            self.ids.pop(ptr_of(o[0]), None)
        self.extra.pop(i, None)

    def obj(self, i):
        o = self.objs.get(int(i))
        if not o:
            raise KeyError("no object %s" % i)
        return o[0]

    # Everything reachable from the song. Returns the ids that went away.
    def sweep(self):
        seen = set()
        s = self.song
        sid = self.ref(s, "song")
        seen.add(sid)
        self.roots["song"] = sid
        if self.app is not None:
            view = getattr(self.app, "view", None)
            if view is not None:
                self.roots["app_view"] = self.ref(view, "view")
                seen.add(self.roots["app_view"])
        for cp in self._safe(lambda: list(s.cue_points), []):
            seen.add(self.ref(cp, "cue"))
        tracks = self._safe(lambda: list(s.tracks), [])
        master = self._safe(lambda: s.master_track, None)
        for tr in tracks + ([master] if master is not None else []):
            seen.add(self.ref(tr, "track"))
            md = self._safe(lambda: tr.mixer_device, None)
            if md is not None:
                seen.add(self.ref(md, "mixer"))
                for p in ("volume", "panning"):
                    prm = self._safe(lambda: getattr(md, p), None)
                    if prm is not None:
                        seen.add(self.ref(prm, "param"))
            if tr is not master:
                for c in self._safe(lambda: list(tr.arrangement_clips), []):
                    seen.add(self.ref(c, "clip"))
            for dev in self._safe(lambda: list(tr.devices), []):
                seen.add(self.ref(dev, "device"))
                if self._own_device(dev):
                    for prm in self._safe(lambda: list(dev.parameters), []):
                        seen.add(self.ref(prm, "param"))
        gone = [i for i in list(self.objs.keys()) if i not in seen]
        for i in gone:
            self.forget(i)
        self.struct_dirty = False
        return gone

    @staticmethod
    def _own_device(dev):
        try:
            return str(dev.name).startswith(OWN_DEVICE_PREFIX)
        except Exception:
            return False

    @staticmethod
    def _safe(fn, default):
        try:
            return fn()
        except Exception:
            return default

    # ------------------------------------------------------------ values
    def wire(self, v):
        if v is None or isinstance(v, (str, float)):
            return v
        if isinstance(v, bool):
            return 1 if v else 0
        if isinstance(v, int):
            return v
        if isinstance(v, (list, tuple)):
            return [self.wire(x) for x in v]
        # Live's lists (song.tracks, cue_points, arrangement_clips...) are its
        # own vector classes, not Python lists
        if type(v).__name__.endswith("Vector") or (hasattr(v, "__iter__") and hasattr(v, "__len__") and not hasattr(v, "_live_ptr")):
            try:
                return [self.wire(x) for x in list(v)]
            except Exception:
                pass
        if hasattr(v, "beat_time") and hasattr(v, "sample_time"):
            return {"beat_time": float(v.beat_time), "sample_time": float(v.sample_time)}
        k = CLASS_KIND.get(type(v).__name__)
        if k or hasattr(v, "_live_ptr"):
            return {"$": self.ref(v, k)}
        try:
            return int(v)      # Live enums
        except Exception:
            return str(v)

    def read(self, i, prop):
        obj, kind = self.objs[i]
        if prop == "display":
            try:
                return str(obj.str_for_value(obj.value))
            except Exception:
                return None
        if kind == "device" and prop == "parameters" and not self._own_device(obj):
            return []
        try:
            v = getattr(obj, prop)
        except Exception:
            return None
        if prop in ROUTING:
            if prop.startswith("available_"):
                return [route_wire(x) for x in v]
            return route_wire(v)
        if prop == "warp_markers":
            return [self.wire(m) for m in v]
        return self.wire(v)

    def state(self, i):
        obj, kind = self.objs[i]
        props = {}
        for prop in KINDS.get(kind, []) + sorted(self.extra.get(i, ())):
            if prop != "display" and not has(obj, prop):
                continue
            props[prop] = self.read(i, prop)
        return {"k": kind, "p": props}

    # ------------------------------------------------------------ outgoing
    def hello(self):
        return {"t": "hello", "v": SPEC["protocol"], "live": self.live_version, "script": "1.0.1"}

    def snapshot(self):
        self.sweep()
        o = {}
        for i in list(self.objs.keys()):
            o[str(i)] = self.state(i)
        self.dirty.clear()
        self.meter_dirty.clear()
        self.mark_all_sent()
        return {"t": "snap", "roots": self.roots, "o": o, "aw": self.aw}

    def _on_time(self):
        # inside a Live notification: read only, never change the set
        t = now_ms()
        if t - self.last_time_sent >= 8:
            self.last_time_sent = t
            self.send_time()
        if self.meter_dirty and t - self.last_meter_flush >= 33:
            self.flush_meters()

    def send_time(self):
        s = self.song
        self.stats["time_msgs"] += 1
        self.send({"t": "time", "s": float(s.current_song_time), "p": 1 if s.is_playing else 0,
                   "tempo": float(s.tempo), "aw": self.aw, "ts": now_ms()})

    def flush_meters(self):
        self.last_meter_flush = now_ms()
        o = {}
        for i in self.meter_dirty:
            if i in self.objs:
                o[str(i)] = {"p": {"output_meter_level": self.read(i, "output_meter_level")}}
        self.meter_dirty.clear()
        if o:
            self.send({"t": "d", "aw": self.aw, "o": o})

    def flush(self):
        gone = self.sweep() if self.struct_dirty else []
        o = {}
        new_ids = []
        for (i, prop) in list(self.dirty):
            if i not in self.objs or prop == "current_song_time":
                continue
            o.setdefault(str(i), {"p": {}})["p"][prop] = self.read(i, prop)
        self.dirty.clear()
        # objects the sweep just found go out whole
        for i in self.objs:
            if not self._sent_once(i):
                new_ids.append(i)
        for i in new_ids:
            o[str(i)] = self.state(i)
            self._mark_sent(i)
        if o or gone:
            msg = {"t": "d", "aw": self.aw, "o": o}
            if gone:
                msg["gone"] = gone
            self.send(msg)
        if self.meter_dirty:
            self.flush_meters()

    def _sent_once(self, i):
        return i in getattr(self, "_sent", set())

    def _mark_sent(self, i):
        if not hasattr(self, "_sent"):
            self._sent = set()
        self._sent.add(i)

    def mark_all_sent(self):
        self._sent = set(self.objs.keys())

    # ------------------------------------------------------------ incoming
    def receive(self, client, msg):
        msg["_at"] = now_ms()
        self.inbox.append((client, msg))

    def run_inbox(self, reply):
        """Carry out waiting commands. Only call where Live allows changes."""
        while self.inbox:
            client, msg = self.inbox.pop(0)
            self.stats["cmds"] += 1
            lag = now_ms() - msg.pop("_at", now_ms())
            lags = self.stats["cmd_lag_ms"]
            lags.append(lag)
            if len(lags) > 200:
                del lags[:100]
            q = msg.get("q")
            try:
                v = self.execute(msg)
                ok, err = True, None
            except Exception as e:
                v, ok, err = None, False, "%s: %s" % (type(e).__name__, e)
                if q is None:
                    self.log("%s %s failed: %s" % (msg.get("t"), msg.get("f") or msg.get("p"), err))
            if msg.get("w"):
                self.aw = max(self.aw, int(msg["w"]))
            if q is not None:
                # what the call changed goes out before the answer, so the app
                # already sees it when the answer arrives
                if msg.get("t") != "ping":
                    self.struct_dirty = True
                    self.flush()
                res = {"t": "res", "q": q, "ok": ok, "aw": self.aw}
                if ok:
                    res["v"] = v
                else:
                    res["err"] = err
                reply(client, res)

    def execute(self, msg):
        t = msg.get("t")
        if t == "ping":
            return {"ts": now_ms(), "stats": self.probe()}
        if t == "set":
            return self._set(int(msg["id"]), msg["p"], msg.get("v"))
        if t == "get":
            i = int(msg["id"])
            if msg.get("watch"):
                self.extra.setdefault(i, set()).add(msg["p"])
            return self.read(i, msg["p"])
        if t == "call":
            return self._call(int(msg["id"]), msg["f"], msg.get("a") or [])
        raise ValueError("unknown message %r" % t)

    def _unwire(self, v):
        if isinstance(v, dict) and "$" in v:
            return self.obj(v["$"])
        if isinstance(v, list):
            return [self._unwire(x) for x in v]
        return v

    def _set(self, i, prop, v):
        obj = self.obj(i)
        if prop in ROUTING:
            want = v.get("identifier") if isinstance(v, dict) else v
            avail = getattr(obj, "available_" + prop + "s")
            for rt in avail:
                if route_id(rt) == want:
                    setattr(obj, prop, rt)
                    self.dirty.add((i, prop))
                    self.dirty.add((i, "available_output_routing_channels"))
                    return route_wire(rt)
            raise ValueError("no route %r" % (want,))
        cur = getattr(obj, prop)
        if isinstance(cur, bool):
            v = bool(int(v)) if not isinstance(v, bool) else v
        elif isinstance(cur, int) and not isinstance(v, bool):
            v = int(round(float(v)))
        elif isinstance(cur, float):
            v = float(v)
        elif isinstance(cur, str):
            v = str(v)
        setattr(obj, prop, v)
        self.dirty.add((i, prop))
        return None

    def _call(self, i, f, args):
        obj = self.obj(i)
        args = [self._unwire(a) for a in args]
        if f == "str_table":
            n = int(args[0]) if args else 201
            lo, hi = float(obj.min), float(obj.max)
            return [obj.str_for_value(lo + (hi - lo) * k / (n - 1.0)) for k in range(n)]
        if f == "add_warp_marker":
            return self._add_marker(obj, args)
        if f == "zoom_view":
            return self._zoom(obj, args)
        if f == "probe":
            return self.probe()
        fn = getattr(obj, f)
        r = fn(*args)
        if f in ("create_audio_track", "set_or_delete_cue", "create_audio_clip", "delete_clip",
                 "move_warp_marker", "remove_warp_marker"):
            self.struct_dirty = True
            self.dirty.add((i, "warp_markers")) if f.endswith("warp_marker") else None
        return self.wire(r) if r is not None else None

    def _add_marker(self, clip, args):
        if args and isinstance(args[0], dict):
            beat, sec = float(args[0]["beat_time"]), float(args[0]["sample_time"])
        else:
            beat, sec = float(args[0]), float(args[1])
        tries = []
        if self.make_marker:
            tries.append(("object", lambda: clip.add_warp_marker(self.make_marker(beat, sec))))
        tries.append(("dict", lambda: clip.add_warp_marker({"beat_time": beat, "sample_time": sec})))
        tries.append(("args", lambda: clip.add_warp_marker(beat, sec)))
        if self.marker_style:
            tries.sort(key=lambda x: 0 if x[0] == self.marker_style else 1)
        errors = []
        for name, fn in tries:
            try:
                fn()
                self.marker_style = name
                self.dirty.add((self.ids.get(ptr_of(clip)), "warp_markers"))
                return name
            except Exception as e:
                errors.append("%s: %s" % (name, e))
        raise RuntimeError("add_warp_marker: " + "; ".join(errors))

    def _zoom(self, view, args):
        d = int(args[0]) if args else 0
        name = str(args[1]) if len(args) > 1 else "Arranger"
        mod = bool(args[2]) if len(args) > 2 else False
        try:
            return view.zoom_view(d, name, mod)
        except Exception:
            nav = getattr(type(view), "NavDirection", None)
            if nav is not None:
                return view.zoom_view(nav.values[d], name, mod)
            raise

    # ------------------------------------------------------------ timing
    def tick(self, reply):
        """Live's update_display (about every 100 ms)."""
        t = now_ms()
        if self._last_tick is not None:
            ms = self.stats["tick_ms"]
            ms.append(t - self._last_tick)
            if len(ms) > 200:
                del ms[:100]
        self._last_tick = t
        self.stats["ticks"] += 1
        self.run_inbox(reply)
        self.flush()
        if not self.song.is_playing and t - self.last_time_sent > 250:
            self.last_time_sent = t
            self.send_time()

    def probe(self):
        def summary(xs):
            if not xs:
                return None
            s = sorted(xs)
            return {"n": len(s), "avg": sum(s) / len(s), "p50": s[len(s) // 2], "p95": s[int(len(s) * 0.95) - 1 if len(s) > 1 else 0], "max": s[-1]}
        return {"tick_ms": summary(self.stats["tick_ms"]), "cmd_lag_ms": summary(self.stats["cmd_lag_ms"]),
                "ticks": self.stats["ticks"], "doorbells": self.stats["doorbells"], "time_msgs": self.stats["time_msgs"],
                "marker_style": self.marker_style, "objects": len(self.objs)}
