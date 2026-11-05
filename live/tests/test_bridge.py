# python3 -m unittest discover -s live/tests
import json
import os
import socket
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import mock_live  # noqa: E402
from SetPilot.core import Bridge, route_id  # noqa: E402
from SetPilot.net import Server  # noqa: E402


class Harness(object):
    def __init__(self, song=None):
        self.song = song or mock_live.demo_song()
        self.app = mock_live.Application(self.song)
        self.out = []
        self.replies = []
        self.b = Bridge(self.song, app=self.app, send=self.out.append,
                        warp_marker_factory=lambda b, s: mock_live.WarpMarker(b, s))
        self.snap = self.b.snapshot()

    def id_of(self, obj):
        return self.b.ids[obj._live_ptr]

    def cmd(self, **msg):
        self.b.receive("c", msg)

    def tick(self):
        self.b.tick(lambda c, m: self.replies.append(m))
        mock_live.flush_later()

    def deltas(self):
        d = [m for m in self.out if m["t"] == "d"]
        self.out[:] = [m for m in self.out if m["t"] != "d"]
        return d


class SnapshotTest(unittest.TestCase):
    def test_snapshot_covers_the_set(self):
        h = Harness()
        o, roots = h.snap["o"], h.snap["roots"]
        song = o[str(roots["song"])]
        self.assertEqual(song["k"], "song")
        self.assertEqual(len(song["p"]["tracks"]), 4)
        self.assertEqual(len(song["p"]["cue_points"]), 4)
        self.assertEqual(song["p"]["is_playing"], 0)
        drums = o[str(song["p"]["tracks"][2]["$"])]
        self.assertEqual(drums["p"]["name"], "Drums")
        clip = o[str(drums["p"]["arrangement_clips"][0]["$"])]
        self.assertEqual(clip["k"], "clip")
        self.assertEqual(clip["p"]["file_path"], "/stems/drums.wav")
        self.assertEqual(clip["p"]["warp_markers"][1], {"beat_time": 0.03125, "sample_time": 0.025})
        mixer = o[str(drums["p"]["mixer_device"]["$"])]
        vol = o[str(mixer["p"]["volume"]["$"])]
        self.assertEqual(vol["k"], "param")
        self.assertAlmostEqual(vol["p"]["value"], 0.85)
        self.assertIn("app_view", roots)
        # master track is there with its mixer
        self.assertIn("$", song["p"]["master_track"])

    def test_main_track_without_mute(self):
        h = Harness()
        mid = h.snap["o"][str(h.snap["roots"]["song"])]["p"]["master_track"]["$"]
        self.assertNotIn("mute", h.snap["o"][str(mid)]["p"])
        h.song.master_track.output_meter_level = 0.5
        h.tick()     # must not fail

    def test_snapshot_is_json(self):
        json.dumps(Harness().snap)


class DeviceTest(unittest.TestCase):
    def test_setpilot_plugins_are_found_with_their_role(self):
        song = mock_live.demo_song()
        song.tracks[1].devices = (mock_live.Device("EQ Eight", [mock_live.DeviceParameter("Gain")], "Eq8Device"),
                                  mock_live.setpilot_audio("Guide"))
        h = Harness(song)
        o = h.snap["o"]
        guide = o[str(h.id_of(song.tracks[1]))]["p"]["devices"]
        eq, sp = o[str(guide[0]["$"])], o[str(guide[1]["$"])]
        self.assertEqual(eq["p"]["parameters"], [], "other devices: no parameters")
        self.assertEqual(sp["p"]["name"], "SetPilot Audio")
        role = o[str(sp["p"]["parameters"][0]["$"])]
        self.assertEqual(role["p"]["name"], "SetPilot Role")
        self.assertEqual(role["p"]["display"], "Guide")

    def test_role_change_and_new_plugin_are_reported(self):
        h = Harness()
        dev = mock_live.setpilot_audio("Cues")
        h.song.tracks[0].devices = (dev,)
        h.tick()
        o = {}
        for d in h.deltas():
            o.update(d["o"])
        self.assertIn(str(h.id_of(dev)), o)
        prm = dev.parameters[0]
        prm.value = 0.0
        h.tick()
        d = {}
        for x in h.deltas():
            d.update(x["o"])
        self.assertEqual(d[str(h.id_of(prm))]["p"]["display"], "Click")


class InsertPluginTest(unittest.TestCase):
    def test_puts_the_vst3_on_the_track_and_returns_it(self):
        h = Harness()
        tr = h.song.tracks[0]
        h.cmd(t="call", q=1, id=h.id_of(tr), f="insert_plugin", a=["SetPilot Audio", "VST3"])
        h.tick()
        r = h.replies[-1]
        self.assertTrue(r["ok"], r)
        self.assertEqual(h.app.browser.loaded, ["VST3"])
        self.assertEqual(r["v"], {"pending": True}, "Live adds the device a moment later")
        h.tick()
        dev = tr.devices[-1]
        o = {}
        for d in h.deltas():
            o.update(d["o"])
        self.assertIn({"$": h.id_of(dev)}, o[str(h.id_of(tr))]["p"]["devices"])
        self.assertIn(h.id_of(dev.parameters[0]), h.b.objs, "its role parameter is followed")

    def test_missing_plugin_is_a_clear_error(self):
        h = Harness()
        h.cmd(t="call", q=1, id=h.id_of(h.song.tracks[0]), f="insert_plugin", a=["Nope"])
        h.tick()
        self.assertFalse(h.replies[-1]["ok"])
        self.assertIn("rescan", h.replies[-1]["err"])


class CueOpsTest(unittest.TestCase):
    def run_until_reply(self, h, q, ticks=20):
        for _ in range(ticks):
            h.tick()
            for r in h.replies:
                if r.get("q") == q:
                    return r
        self.fail("no answer")

    def test_add_cue_waits_for_the_playhead_and_names_it(self):
        h = Harness()
        n = len(h.song.cue_points)
        h.cmd(t="call", q=1, w=1, id=h.snap["roots"]["song"], f="add_cue", a=[200.0, "# New | 80"])
        r = self.run_until_reply(h, 1)
        self.assertTrue(r["ok"], r)
        cues = list(h.song.cue_points)
        self.assertEqual(len(cues), n + 1)
        new = [c for c in cues if abs(c.time - 200) < 1e-6][0]
        self.assertEqual(new.name, "# New | 80")
        self.assertEqual(r["v"], {"$": h.id_of(new)})

    def test_many_cues_in_a_row_never_delete_each_other(self):
        h = Harness()
        n = len(h.song.cue_points)
        for k, t in enumerate([100.0, 116.0, 132.0, 148.0]):
            h.cmd(t="call", q=10 + k, id=h.snap["roots"]["song"], f="add_cue", a=[t, "S%d" % k])
        self.run_until_reply(h, 13, ticks=60)
        names = sorted(c.name for c in h.song.cue_points if c.time >= 100)
        self.assertEqual(names, ["S0", "S1", "S2", "S3"])
        self.assertEqual(len(h.song.cue_points), n + 4)

    def test_existing_cue_is_renamed_not_toggled(self):
        h = Harness()
        h.cmd(t="call", q=1, id=h.snap["roots"]["song"], f="add_cue", a=[16.0, "Verso"])
        self.run_until_reply(h, 1)
        self.assertEqual([c.name for c in h.song.cue_points if c.time == 16][0], "Verso")

    def test_delete_cue(self):
        h = Harness()
        h.cmd(t="call", q=1, id=h.snap["roots"]["song"], f="delete_cue", a=[16.0])
        r = self.run_until_reply(h, 1)
        self.assertTrue(r["ok"], r)
        self.assertFalse(any(abs(c.time - 16) < 1e-6 for c in h.song.cue_points))


class CueGridTest(unittest.TestCase):
    """Live snaps a new locator to the arrangement grid (16 beats here)."""

    def run_all(self, h, last_q, ticks=200):
        for _ in range(ticks):
            h.tick()
            if any(r.get("q") == last_q for r in h.replies):
                h.tick()
                return
        self.fail("no answer")

    def test_off_grid_locators_land_exactly_and_nothing_else_changes(self):
        h = Harness()
        h.song.add_cue("# Next | 86 | F", 400.0)
        keep = sorted((c.name, c.time) for c in h.song.cue_points)
        wanted = [(408.0, "Intro"), (424.0, "Verse 1"), (440.0, "Verse 2"), (472.0, "Chorus"), (984.0, "STOP")]
        for k, (t, n) in enumerate(wanted):
            h.cmd(t="call", q=100 + k, id=h.snap["roots"]["song"], f="add_cue", a=[t, n])
        self.run_all(h, 100 + len(wanted) - 1)
        self.assertTrue(all(r["ok"] for r in h.replies if r.get("q", 0) >= 100), h.replies)
        now = sorted((c.name, c.time) for c in h.song.cue_points)
        self.assertEqual(now, sorted(keep + [(n, t) for t, n in wanted]))
        self.assertEqual(h.app.view.grid, 16.0, "the zoom goes back when done")

    def test_delete_off_grid_keeps_the_neighbour(self):
        h = Harness()
        h.song.add_cue("# Next | 86 | F", 400.0)
        h.song.add_cue("Intro", 408.0)
        h.cmd(t="call", q=1, id=h.snap["roots"]["song"], f="delete_cue", a=[408.0])
        self.run_all(h, 1)
        self.assertTrue(h.replies[-1]["ok"], h.replies)
        names = sorted((c.name, c.time) for c in h.song.cue_points if c.time >= 400)
        self.assertEqual(names, [("# Next | 86 | F", 400.0)])

    def test_past_the_end_is_a_clear_error(self):
        h = Harness()
        n = len(h.song.cue_points)
        h.cmd(t="call", q=1, id=h.snap["roots"]["song"], f="add_cue", a=[2000.0, "X"])
        self.run_all(h, 1)
        r = [x for x in h.replies if x.get("q") == 1][0]
        self.assertFalse(r["ok"])
        self.assertIn("past the end", r["err"])
        self.assertEqual(len(h.song.cue_points), n)


class ReusedAddressTest(unittest.TestCase):
    def test_a_new_locator_at_a_dead_ones_address_is_sent_as_new(self):
        h = Harness()
        old = [c for c in h.song.cue_points if c.name == "Verse"][0]
        old_id = h.id_of(old)
        h.song.cue_points = tuple(c for c in h.song.cue_points if c is not old)
        new = mock_live.CuePoint(h.song, "Bridge", 48.0)
        object.__setattr__(new, "_live_ptr", old._live_ptr)   # Live reuses the address
        h.song.cue_points = h.song.cue_points + (new,)
        h.deltas()
        for _ in range(3):
            h.tick()
        new_id = h.b.ids[new._live_ptr]
        sent = {}
        for d in h.deltas():
            for k, o in d.get("o", {}).items():
                sent.setdefault(k, {}).update(o.get("p", {}))
        self.assertEqual(sent[str(new_id)].get("name"), "Bridge")
        self.assertEqual(sent[str(new_id)].get("time"), 48.0)


class WriteTest(unittest.TestCase):
    def test_writes_wait_for_the_tick_and_report_back(self):
        h = Harness()
        drums = h.song.tracks[2]
        h.cmd(t="set", w=7, id=h.id_of(drums), p="mute", v=1)
        self.assertFalse(drums.mute, "nothing changes before Live's tick")
        h.tick()
        self.assertTrue(drums.mute)
        d = h.deltas()
        self.assertTrue(d)
        self.assertEqual(d[-1]["aw"], 7)
        self.assertEqual(d[-1]["o"][str(h.id_of(drums))]["p"]["mute"], 1)

    def test_types_follow_live(self):
        h = Harness()
        h.cmd(t="set", w=1, id=h.id_of(h.song), p="clip_trigger_quantization", v=4.0)
        h.cmd(t="set", w=2, id=h.id_of(h.song), p="tempo", v=134)
        h.cmd(t="set", w=3, id=h.id_of(h.song.tracks[0]), p="name", v=12)
        h.tick()
        self.assertIsInstance(h.song.clip_trigger_quantization, int)
        self.assertIsInstance(h.song.tempo, float)
        self.assertEqual(h.song.tracks[0].name, "12")

    def test_never_changes_the_set_inside_a_notification(self):
        # the mock raises like Live if a listener changes something
        h = Harness()
        h.cmd(t="set", w=1, id=h.id_of(h.song.tracks[1]), p="mute", v=1)
        h.song.is_playing = True
        for _ in range(20):
            h.song.advance(20)      # fires the position listener many times
        self.assertFalse(h.song.tracks[1].mute)
        h.tick()
        self.assertTrue(h.song.tracks[1].mute)

    def test_changes_made_in_live_are_reported(self):
        h = Harness()
        h.song.tracks[3].name = "Keys 2"
        h.song.cue_points[2].name = "Verso"
        h.tick()
        o = {}
        for d in h.deltas():
            o.update(d["o"])
        self.assertEqual(o[str(h.id_of(h.song.tracks[3]))]["p"]["name"], "Keys 2")
        self.assertEqual(o[str(h.id_of(h.song.cue_points[2]))]["p"]["name"], "Verso")


class CallTest(unittest.TestCase):
    def test_sync_call_sends_the_new_track_before_its_answer(self):
        h = Harness()
        h.cmd(t="call", q=1, w=1, id=h.id_of(h.song), f="create_audio_track", a=[-1])
        h.out[:] = []
        sent = []
        h.b.send = sent.append
        h.b.tick(lambda c, m: sent.append(m))
        kinds = [m["t"] for m in sent]
        self.assertIn("res", kinds)
        first_res = kinds.index("res")
        self.assertIn("d", kinds[:first_res], "deltas go out before the answer")
        d = sent[kinds.index("d")]
        new = h.song._v["tracks"][-1]
        self.assertIn(str(h.id_of(new)), d["o"])
        self.assertEqual(d["o"][str(h.id_of(new))]["k"], "track")
        song_d = d["o"].get(str(h.snap["roots"]["song"]), {}).get("p", {})
        self.assertIn({"$": h.id_of(new)}, song_d.get("tracks", []), "the song's track list is sent too, though Live notifies it later")

    def test_create_and_delete_clip(self):
        h = Harness()
        keys = h.song.tracks[3]
        h.cmd(t="call", q=1, w=1, id=h.id_of(keys), f="create_audio_clip", a=["/new.wav", 128])
        h.tick()
        clip = keys.arrangement_clips[-1]
        cid = h.id_of(clip)
        self.assertEqual(clip.file_path, "/new.wav")
        h.replies[:] = []
        h.cmd(t="call", q=2, w=2, id=h.id_of(keys), f="delete_clip", a=[{"$": cid}])
        h.tick()
        self.assertEqual(h.replies[-1]["ok"], True)
        self.assertNotIn(clip, keys.arrangement_clips)
        gone = [g for d in h.deltas() for g in d.get("gone", [])]
        self.assertIn(cid, gone)
        self.assertEqual(clip.listener_count(), 0, "listeners removed from deleted objects")

    def test_errors_come_back_as_answers(self):
        h = Harness()
        h.cmd(t="call", q=9, id=h.id_of(h.song), f="no_such_thing", a=[])
        h.tick()
        self.assertFalse(h.replies[-1]["ok"])
        self.assertIn("no_such_thing", h.replies[-1]["err"])

    def test_routing_by_identifier(self):
        h = Harness()
        tr = h.song.tracks[2]
        ext = route_id(mock_live.Track.ROUTES[0])
        h.cmd(t="set", q=1, w=1, id=h.id_of(tr), p="output_routing_type", v={"identifier": ext})
        h.tick()
        self.assertEqual(tr.output_routing_type.display_name, "Ext. Out")
        o = {}
        for d in h.deltas():
            o.update(d["o"].get(str(h.id_of(tr)), {}).get("p", {}))
        names = [c["display_name"] for c in o["available_output_routing_channels"]]
        self.assertEqual(names, ["1/2", "3/4"])

    def test_str_table(self):
        h = Harness()
        vol = h.song.tracks[0].mixer_device.volume
        h.cmd(t="call", q=1, id=h.id_of(vol), f="str_table", a=[5])
        h.tick()
        self.assertEqual(h.replies[-1]["v"], ["-inf dB", "-24.0 dB", "-14.0 dB", "-4.0 dB", "6.0 dB"])

    def test_warp_marker_finds_the_signature_that_works(self):
        h = Harness()
        clip = h.song.tracks[2].arrangement_clips[0]
        h.cmd(t="call", q=1, id=h.id_of(clip), f="add_warp_marker", a=[{"beat_time": 32.0, "sample_time": 16.0}])
        h.tick()
        self.assertTrue(h.replies[-1]["ok"], h.replies[-1])
        self.assertEqual(h.replies[-1]["v"], "object")
        self.assertEqual(len(clip.warp_markers), 3)

    def test_zoom(self):
        h = Harness()
        h.cmd(t="call", id=h.snap["roots"]["app_view"], f="zoom_view", a=[1, "Arranger", 0])
        h.tick()
        self.assertEqual(h.app.view.zooms, [(1, "Arranger", False)])

    def test_lazy_get_is_then_kept_updated(self):
        h = Harness()
        clip = h.song.tracks[2].arrangement_clips[0]
        h.cmd(t="get", q=1, id=h.id_of(clip), p="sample_rate", watch=1)
        h.tick()
        self.assertEqual(h.replies[-1]["v"], 44100)
        self.assertIn("sample_rate", h.b.state(h.id_of(clip))["p"])


class TimeTest(unittest.TestCase):
    def test_position_is_sent_often_while_playing(self):
        h = Harness()
        h.song.is_playing = True
        h.out[:] = []
        for _ in range(10):
            h.song.advance(10)
            time.sleep(0.01)
        times = [m for m in h.out if m["t"] == "time"]
        self.assertGreaterEqual(len(times), 5)
        self.assertEqual(times[-1]["p"], 1)
        self.assertAlmostEqual(times[-1]["s"], h.song.current_song_time, places=6)

    def test_meters_are_throttled(self):
        h = Harness()
        h.out[:] = []
        for k in range(50):
            h.song.tracks[2].output_meter_level = k / 50.0
        h.tick()
        meter_msgs = [m for m in h.out if m["t"] == "d" and any("output_meter_level" in v["p"] for v in m["o"].values())]
        self.assertEqual(len(meter_msgs), 1)

    def test_probe(self):
        h = Harness()
        for _ in range(3):
            h.tick()
            time.sleep(0.01)
        h.cmd(t="ping", q=4)
        h.tick()
        st = h.replies[-1]["v"]["stats"]
        self.assertEqual(st["ticks"], 4)
        self.assertIsNotNone(st["tick_ms"])


class NetTest(unittest.TestCase):
    def test_socket_round_trip(self):
        h = Harness()
        disc = os.path.join(tempfile.mkdtemp(), "bridge.json")
        srv = Server("tok", discovery_path=disc, ports=list(range(18790, 18800)))
        h.b.send = srv.broadcast
        srv.on_connect = lambda c: (srv.send(c, h.b.hello()), srv.send(c, h.b.snapshot()))
        srv.on_message = lambda c, m: h.b.receive(c, m)
        self.assertTrue(srv.start({"live": "test"}))
        info = json.load(open(disc))
        self.assertEqual(info["token"], "tok")
        s = socket.create_connection(("127.0.0.1", info["port"]))
        s.sendall(b'{"t":"auth","token":"tok"}\n{"t":"set","w":1,"id":%d,"p":"mute","v":1}\n' % h.id_of(h.song.tracks[0]))
        buf = b""
        deadline = time.time() + 3
        while time.time() < deadline and buf.count(b"\n") < 3:
            srv.poll()
            h.b.tick(lambda c, m: srv.send(c, m))
            srv.poll(handle=False)
            s.settimeout(0.05)
            try:
                buf += s.recv(1 << 20)
            except socket.timeout:
                pass
        lines = [json.loads(x) for x in buf.split(b"\n") if x]
        self.assertEqual(lines[0]["t"], "hello")
        self.assertEqual(lines[1]["t"], "snap")
        self.assertTrue(h.song.tracks[0].mute)
        s.close()
        srv.stop()
        self.assertFalse(os.path.exists(disc))

    def test_wrong_token_is_dropped(self):
        srv = Server("tok", ports=list(range(18800, 18810)))
        srv.on_connect = lambda c: self.fail("should not connect")
        srv.start()
        s = socket.create_connection(("127.0.0.1", srv.port))
        s.sendall(b'{"t":"auth","token":"nope"}\n')
        for _ in range(20):
            srv.poll()
            time.sleep(0.01)
        self.assertEqual(srv.authed_clients(), [])
        srv.stop()


class SpecTest(unittest.TestCase):
    def test_python_3_7_syntax(self):
        # Live 11 runs Python 3.7: no walrus, no positional-only params
        import ast
        pkg = os.path.join(os.path.dirname(HERE), "SetPilot")
        for f in os.listdir(pkg):
            if f.endswith(".py"):
                src = open(os.path.join(pkg, f)).read()
                tree = ast.parse(src, feature_version=(3, 7))
                self.assertIsNotNone(tree)


if __name__ == "__main__":
    unittest.main()
