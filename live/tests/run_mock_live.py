# Runs the real SetPilot Remote Script against the mock Live, with Live's
# timing: update_display every ~100 ms, the song position moving in small
# steps while playing (which fires the position listener), and the MIDI
# doorbell arriving as a UDP packet.
#
#   HOME=/tmp/x python3 live/tests/run_mock_live.py [--tick 100] [--doorbell 8799]

import argparse
import json
import os
import select
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import mock_live  # noqa: E402
from SetPilot.surface import SetPilotSurface  # noqa: E402

CUES = [("# Grande y Fiel | 72 | G", 0), ("Intro", 0), ("Verso 1", 16), ("Coro", 48), ("Verso 2", 80),
        ("Coro", 112), ("Puente", 144), ("Coro", 176), ("Final", 208), ("STOP", 232),
        ("# Cielo Abierto | 128 | D", 256), ("Intro", 256), ("Verso", 272), ("Pre Coro", 304), ("Coro", 320),
        ("Instrumental", 352), ("Puente", 368), ("Coro", 400), ("Tag", 432), ("Final", 448), ("STOP", 464)]


def build_song():
    s = mock_live.Song()
    for name in ("Click", "Guide", "Drums", "SP Cues", "Keys", "Bass"):
        s.add_track(name)
    for t, f in ((2, "drums"), (4, "keys"), (5, "bass")):
        s.tracks[t].arrangement_clips = (mock_live.Clip(0, 232, "/stems/%s-1.wav" % f), mock_live.Clip(256, 208, "/stems/%s-2.wav" % f))
    for name, at in CUES:
        s.add_cue(name, at)
    s.last_event_time = 464.0
    s.song_length = 480.0
    return s


class CInstance(object):
    def __init__(self, song):
        self._song = song

    def song(self):
        return self._song

    def log_message(self, m):
        pass

    def handle(self):
        return 1

    def instance_identifier(self):
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tick", type=float, default=100.0)
    ap.add_argument("--doorbell", type=int, default=0)
    ap.add_argument("--seconds", type=float, default=600)
    ap.add_argument("--plugins", action="store_true", help="SetPilot Audio on SP Cues (Cues), Guide (Guide) and Click (Click)")
    a = ap.parse_args()

    song = build_song()
    if a.plugins:
        by = {t.name: t for t in song.tracks}
        by["SP Cues"].devices = (mock_live.setpilot_audio("Cues"),)
        by["Guide"].devices = (mock_live.setpilot_audio("Guide"),)
        by["Click"].devices = (mock_live.setpilot_audio("Click"),)
    surface = SetPilotSurface(CInstance(song))
    # Live's application object (browser with SetPilot Audio in it)
    surface.bridge.app = mock_live.Application(song)
    bell = None
    if a.doorbell:
        bell = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        bell.bind(("127.0.0.1", a.doorbell))
        bell.setblocking(False)

    # report mute changes with the song position, for timing checks
    for tr in song.tracks:
        def report(tr=tr):
            print(json.dumps({"mute": tr.name, "v": 1 if tr.mute else 0, "t": song.current_song_time,
                              "playing": 1 if song.is_playing else 0}), flush=True)
        tr.add_mute_listener(report)

    start = time.time()
    last = time.time()
    next_tick = time.time() + a.tick / 1000.0
    print(json.dumps({"ready": True, "port": surface.server.port}), flush=True)
    while time.time() - start < a.seconds:
        timeout = max(0.0, min(0.004, next_tick - time.time()))
        if bell:
            r, _, _ = select.select([bell], [], [], timeout)
            if r:
                try:
                    while True:
                        data = bell.recv(16)
                        surface.receive_midi(tuple(bytearray(data)))
                except (BlockingIOError, socket.error):
                    pass
        else:
            time.sleep(timeout)
        now = time.time()
        song.advance((now - last) * 1000.0)
        last = now
        mock_live.flush_later()
        if now >= next_tick:
            surface.update_display()
            next_tick += a.tick / 1000.0
            if next_tick < now:
                next_tick = now + a.tick / 1000.0
    surface.disconnect()


if __name__ == "__main__":
    main()
