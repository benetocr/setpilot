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

PORT_NAME = "SetPilot Bridge"
DOORBELL_CHANNEL = 15   # MIDI channel 16
DOORBELL_CC = 119

HOME = os.path.expanduser("~")
DATA = os.path.join(HOME, ".setpilot")
DISCOVERY = os.path.join(DATA, "bridge.json")
LOG = os.path.join(DATA, "bridge.log")


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
        self.server.start({"live": version, "python": sys.version.split()[0], "script": "1.0.0"})
        self.log("SetPilot bridge started, Live %s, Python %s" % (version, sys.version.split()[0]))

    # ------------------------------------------------------------ logging
    def log(self, msg):
        try:
            if self._log_file is None:
                if not os.path.isdir(DATA):
                    os.makedirs(DATA)
                self._log_file = open(LOG, "a")
            self._log_file.write(time.strftime("%Y-%m-%d %H:%M:%S ") + str(msg) + "\n")
            self._log_file.flush()
        except Exception:
            pass
        try:
            self._c.log_message("SetPilot: " + str(msg))
        except Exception:
            pass

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
        except Exception as e:
            self.log("tick failed: %s" % e)

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
