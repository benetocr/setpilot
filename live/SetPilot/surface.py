# The control surface Live talks to. It owns the TCP server and the bridge
# and gives them Live's main-thread moments:
#   update_display  about every 100 ms: run commands, send changes
#   receive_midi    the app's "doorbell" on the SetPilot MIDI port: run
#                   commands right away instead of waiting for the next tick
#   song position   while playing, many times a second: read the socket and
#                   send the position (no changes allowed here)

import json
import os
import random
import string
import sys
import time

from .core import Bridge
from .net import Server

try:
    import Live  # only inside Ableton Live
except ImportError:  # tests
    Live = None

SCRIPT_VERSION = "1.0.2"
PORT_NAME = "SetPilot Bridge"
DOORBELL_CHANNEL = 15   # MIDI channel 16
DOORBELL_CC = 119

HOME = os.path.expanduser("~")
DATA = os.path.join(HOME, ".setpilot")
DISCOVERY = os.path.join(DATA, "bridge.json")
LOG = os.path.join(DATA, "bridge.log")
# a copy of the log and the self-check next to the script, where the app
# (and support) can always find them
HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_LOG = os.path.join(HERE, "bridge.log")
SELFCHECK = os.path.join(HERE, "selfcheck.json")


def _doc(obj, name):
    try:
        f = getattr(obj, name)
    except Exception:
        return None
    return (getattr(f, "__doc__", None) or "present").strip().split("\n")[0][:300]


def self_check(song, app):
    """What this Live offers the bridge, without changing anything."""
    out = {"python": sys.version.split()[0], "live": _live_version(app) if app else ""}
    try:
        out["warp_marker_class"] = bool(Live and hasattr(Live.Clip, "WarpMarker"))
        api = {}
        tr = song.tracks[0] if len(song.tracks) else None
        if Live is not None:
            for cls, names in ((Live.Clip.Clip, ("add_warp_marker", "move_warp_marker", "remove_warp_marker", "warp_markers")),
                               (Live.Track.Track, ("create_audio_clip", "delete_clip", "arrangement_clips")),
                               (Live.Song.Song, ("create_audio_track", "set_or_delete_cue"))):
                for n in names:
                    api[cls.__name__ + "." + n] = _doc(cls, n)
        out["api"] = api
        out["tracks"] = len(song.tracks)
        out["cues"] = len(song.cue_points)
        clips = 0
        for t in song.tracks:
            try:
                clips += len(t.arrangement_clips)
            except Exception:
                pass
        out["arrangement_clips"] = clips
    except Exception as e:
        out["error"] = str(e)
    return out


def _token():
    rnd = random.SystemRandom()
    return "".join(rnd.choice(string.ascii_letters + string.digits) for _ in range(32))


def _live_version(app):
    try:
        return "%d.%d.%d" % (app.get_major_version(), app.get_minor_version(), app.get_bugfix_version())
    except Exception:
        return ""


class SetPilotSurface(object):
    def __init__(self, c_instance):
        self._c = c_instance
        self._log_file = None
        app = None
        if Live is not None:
            try:
                app = Live.Application.get_application()
            except Exception:
                app = None
        self._app = app
        version = _live_version(app) if app else ""
        factory = None
        if Live is not None and hasattr(Live, "Clip") and hasattr(Live.Clip, "WarpMarker"):
            factory = lambda b, s: Live.Clip.WarpMarker(beat_time=b, sample_time=s)
        self.server = Server(_token(), log=self.log, discovery_path=DISCOVERY)
        self.bridge = Bridge(c_instance.song(), app=app, send=self.server.broadcast, log=self.log,
                             live_version=version, warp_marker_factory=factory)
        self.server.on_connect = self._on_connect
        self.server.on_message = self._on_message
        self.server.start({"live": version, "python": sys.version.split()[0], "script": SCRIPT_VERSION})
        self.log("SetPilot bridge " + SCRIPT_VERSION + " started, Live %s, Python %s, port %s" % (version, sys.version.split()[0], self.server.port))
        self._checked_at = 0
        try:
            sc = self_check(c_instance.song(), app)
            sc["port"] = self.server.port
            sc["objects"] = len(self.bridge.objs)
            with open(SELFCHECK, "w") as f:
                json.dump(sc, f, indent=1)
        except Exception as e:
            self.log("self check failed: %s" % e)

    # ------------------------------------------------------------ logging
    def log(self, msg):
        line = time.strftime("%Y-%m-%d %H:%M:%S ") + str(msg) + "\n"
        try:
            with open(LOCAL_LOG, "a") as f:
                f.write(line)
        except Exception:
            pass
        try:
            if self._log_file is None:
                if not os.path.isdir(DATA):
                    os.makedirs(DATA)
                self._log_file = open(LOG, "a")
            self._log_file.write(line)
            self._log_file.flush()
        except Exception:
            pass
        try:
            self._c.log_message("SetPilot: " + str(msg))
        except Exception:
            pass

    def _log_once(self, msg):
        # the same error every 100 ms helps nobody: once, then every 30 s
        now = time.time()
        seen = getattr(self, "_seen", {})
        self._seen = seen
        if now - seen.get(msg, 0) > 30:
            seen[msg] = now
            self.log(msg)

    # ------------------------------------------------------------ server events
    def _on_connect(self, client):
        self.server.send(client, self.bridge.hello())
        self.server.send(client, self.bridge.snapshot())
        self.log("app connected")

    def _on_message(self, client, msg):
        if msg.get("t") == "ping" and msg.get("fast"):
            # answered at once: measures the network side alone
            self.server.send(client, {"t": "res", "q": msg.get("q"), "ok": True, "v": {"ts": time.time() * 1000.0}})
            return
        self.bridge.receive(client, msg)

    def _reply(self, client, msg):
        self.server.send(client, msg)

    def _pump(self, allowed):
        self.server.poll(handle=True)
        if allowed:
            self.bridge.run_inbox(self._reply)
            self.server.poll(handle=False)

    # ------------------------------------------------------------ Live calls these
    def update_display(self):
        try:
            self.server.poll(handle=True)
            self.bridge.tick(self._reply)
            self.server.poll(handle=False)
            now = time.time()
            if now - self._checked_at > 30:
                self._checked_at = now
                p = self.bridge.probe()
                t = p.get("tick_ms") or {}
                self.log("timing: tick avg %.0f ms, p95 %.0f, max %.0f; position msgs %d; clients %d" % (
                    t.get("avg", 0), t.get("p95", 0), t.get("max", 0), p["time_msgs"], len(self.server.authed_clients())))
        except Exception as e:
            self._log_once("tick failed: %s" % e)

    def receive_midi(self, midi_bytes):
        if len(midi_bytes) == 3 and midi_bytes[0] == (0xB0 | DOORBELL_CHANNEL) and midi_bytes[1] == DOORBELL_CC:
            self.bridge.stats["doorbells"] += 1
            try:
                self._pump(True)
                self.bridge.flush()
                self.server.poll(handle=False)
            except Exception as e:
                self.log("doorbell failed: %s" % e)

    def build_midi_map(self, midi_map_handle):
        if Live is None:
            return
        try:
            Live.MidiMap.forward_midi_cc(self._c.handle(), midi_map_handle, DOORBELL_CHANNEL, DOORBELL_CC)
        except Exception as e:
            self.log("midi map: %s" % e)

    def disconnect(self):
        self.log("SetPilot bridge stopping")
        try:
            self.server.stop()
        except Exception:
            pass
        for i in list(self.bridge.objs.keys()):
            self.bridge.forget(i)
        if self._log_file:
            try:
                self._log_file.close()
            except Exception:
                pass

    # Live finds the surface by itself when the SetPilot app's MIDI port shows up
    def suggest_input_port(self):
        return PORT_NAME

    def suggest_output_port(self):
        return PORT_NAME

    def suggest_map_mode(self, cc_no, channel):
        return -1

    def can_lock_to_devices(self):
        return False

    def connect_script_instances(self, instanciated_scripts):
        pass

    def refresh_state(self):
        self.bridge.struct_dirty = True

    def request_rebuild_midi_map(self):
        pass

    def port_settings_changed(self):
        pass

    def instance_identifier(self):
        return self._c.instance_identifier()
