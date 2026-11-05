# A small Ableton Live, just enough of the Python object model for the
# bridge: listeners on properties, arrangement transport, cue points,
# tracks with mixers and arrangement clips, and output routing.
#
# Like the real Live it refuses changes made from inside a notification.

import itertools

_ptr = itertools.count(0x7f0000001000, 16)
_in_notify = [0]


class Vector(object):
    """Like Live's list types (TrackVector...): iterable, sized, indexable,
    but not a Python list or tuple."""
    def __init__(self, items):
        self._items = tuple(items)

    def __iter__(self):
        return iter(self._items)

    def __len__(self):
        return len(self._items)

    def __getitem__(self, i):
        return self._items[i]

    def __add__(self, other):
        return Vector(self._items + tuple(other))

    def __eq__(self, other):
        return isinstance(other, Vector) and other._items == self._items


class TrackVector(Vector):
    pass


class LiveError(RuntimeError):
    pass


class Observable(object):
    _props = ()

    def __init__(self, **values):
        object.__setattr__(self, "_live_ptr", next(_ptr))
        object.__setattr__(self, "_listeners", {})
        object.__setattr__(self, "_v", {})
        for k in self._props:
            self._v[k] = values.pop(k, None)
        for k, v in values.items():
            object.__setattr__(self, k, v)

    def __getattr__(self, name):
        v = object.__getattribute__(self, "_v")
        if name in v:
            x = v[name]
            return TrackVector(x) if isinstance(x, tuple) else x
        for pre, fn in (("add_", self._add), ("remove_", self._remove)):
            if name.startswith(pre) and name.endswith("_listener") and name[len(pre):-9] in self._props:
                prop = name[len(pre):-9]
                return lambda f, prop=prop, fn=fn: fn(prop, f)
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name in self._props:
            if _in_notify[0]:
                raise LiveError("Changes cannot be triggered by notifications")
            old = self._v.get(name)
            self._v[name] = value
            if old != value:
                self._notify(name)
        else:
            object.__setattr__(self, name, value)

    def _add(self, prop, f):
        self._listeners.setdefault(prop, []).append(f)

    def _remove(self, prop, f):
        self._listeners.get(prop, []).remove(f)

    def listener_count(self, prop=None):
        if prop:
            return len(self._listeners.get(prop, []))
        return sum(len(x) for x in self._listeners.values())

    def _notify(self, prop):
        _in_notify[0] += 1
        try:
            for f in list(self._listeners.get(prop, [])):
                f()
        finally:
            _in_notify[0] -= 1


class DeviceParameter(Observable):
    _props = ("value", "automation_state")

    def __init__(self, name, value=0.85, lo=0.0, hi=1.0):
        Observable.__init__(self, value=value, automation_state=0)
        self.name, self.min, self.max = name, lo, hi

    def str_for_value(self, v):
        if self.name == "Track Volume":
            if v <= 0:
                return "-inf dB"
            return "%.1f dB" % ((v - 0.85) * 40)
        return "%dC" % round(v * 50)

    def __str__(self):
        return self.str_for_value(self.value)


class Device(Observable):
    _props = ("name", "parameters")

    def __init__(self, name, params=(), class_name="PluginDevice"):
        Observable.__init__(self, name=name, parameters=tuple(params))
        self.class_name = class_name


class ChoiceParameter(DeviceParameter):
    def __init__(self, name, choices, index=0):
        DeviceParameter.__init__(self, name, value=float(index), lo=0.0, hi=float(len(choices) - 1))
        self.choices = choices

    def str_for_value(self, v):
        return self.choices[int(round(v))]


def setpilot_audio(role):
    roles = ["Click", "Cues", "Guide", "Tail"]
    return Device("SetPilot Audio", [ChoiceParameter("SetPilot Role", roles, roles.index(role))])


class MixerDevice(Observable):
    _props = ()

    def __init__(self):
        Observable.__init__(self)
        self.volume = DeviceParameter("Track Volume")
        self.panning = DeviceParameter("Track Panning", 0.0, -1.0, 1.0)


class RoutingType(object):
    def __init__(self, display_name, category=0):
        self.display_name, self.category = display_name, category


class WarpMarker(object):
    def __init__(self, beat_time=0.0, sample_time=0.0):
        self.beat_time, self.sample_time = beat_time, sample_time


class Clip(Observable):
    _props = ("start_time", "end_time", "looping", "loop_start", "loop_end", "start_marker", "end_marker",
              "warping", "warp_mode", "pitch_coarse", "muted", "warp_markers")

    def __init__(self, start, length, file_path="/x.wav"):
        Observable.__init__(self, start_time=float(start), end_time=float(start + length), looping=False,
                            loop_start=0.0, loop_end=float(length), start_marker=0.0, end_marker=float(length),
                            warping=True, warp_mode=0, pitch_coarse=0, muted=False,
                            warp_markers=(WarpMarker(0.0, 0.0), WarpMarker(0.03125, 0.025)))
        self.file_path = file_path
        self.sample_rate = 44100
        self.sample_length = 44100 * 60
        self.is_audio_clip = True
        self.gain_display_string = "0.0 dB"

    def add_warp_marker(self, m):
        if not isinstance(m, WarpMarker):
            raise TypeError("expects a WarpMarker")
        self.warp_markers = tuple(sorted(self.warp_markers + (m,), key=lambda x: x.beat_time))

    def move_warp_marker(self, beat, distance):
        ms = list(self.warp_markers)
        for k, m in enumerate(ms):
            if abs(m.beat_time - beat) < 1e-6:
                ms[k] = WarpMarker(m.beat_time + distance, m.sample_time)
                self.warp_markers = tuple(ms)
                return
        raise LiveError("no marker")


class Track(Observable):
    _props = ("name", "mute", "solo", "color", "output_meter_level", "arrangement_clips", "devices",
              "output_routing_type", "output_routing_channel", "available_output_routing_channels")
    ROUTES = (RoutingType("Ext. Out", 1), RoutingType("Main", 2), RoutingType("Band Bus", 3))

    def __init__(self, name, midi=False):
        Observable.__init__(self, name=name, mute=False, solo=False, color=0xff6600, output_meter_level=0.0,
                            arrangement_clips=(), devices=(), output_routing_type=self.ROUTES[1],
                            output_routing_channel=RoutingType(""), available_output_routing_channels=(RoutingType(""),))
        self.has_midi_input = midi
        self.is_foldable = False
        self.is_grouped = False
        self.mixer_device = MixerDevice()
        self.available_output_routing_types = self.ROUTES

    def __setattr__(self, name, value):
        Observable.__setattr__(self, name, value)
        if name == "output_routing_type" and value is not None:
            chans = (RoutingType("1/2"), RoutingType("3/4")) if value.display_name == "Ext. Out" else (RoutingType(""),)
            Observable.__setattr__(self, "available_output_routing_channels", chans)
            Observable.__setattr__(self, "output_routing_channel", chans[0])

    def create_audio_clip(self, path, position):
        c = Clip(position, 16, path)
        self.arrangement_clips = self.arrangement_clips + (c,)
        return c

    def delete_clip(self, clip):
        self.arrangement_clips = tuple(c for c in self.arrangement_clips if c is not clip)


class MasterTrack(Track):
    # like Live: asking the main track for what it lacks raises RuntimeError
    MISSING = ("mute", "solo", "arrangement_clips", "add_mute_listener", "add_solo_listener", "add_arrangement_clips_listener")

    def __getattribute__(self, name):
        if name in MasterTrack.MISSING:
            raise RuntimeError("Main track has no '%s' property!" % name.replace("add_", "").replace("_listener", ""))
        return Track.__getattribute__(self, name)

    def __getattr__(self, name):
        if name in MasterTrack.MISSING:
            raise RuntimeError("Main track has no '%s' property!" % name)
        return Track.__getattr__(self, name)


class CuePoint(Observable):
    _props = ("name", "time")

    def __init__(self, song, name, time):
        Observable.__init__(self, name=name, time=float(time))
        self._song = song

    def jump(self):
        self._song.current_song_time = self.time


class View(Observable):
    _props = ()

    def __init__(self):
        Observable.__init__(self)
        self.zooms = []

    def zoom_view(self, direction, name, modifier):
        if not isinstance(direction, int):
            raise TypeError("direction")
        self.zooms.append((direction, name, modifier))


class Application(object):
    def __init__(self):
        self.view = View()


class Song(Observable):
    _props = ("current_song_time", "is_playing", "tempo", "signature_numerator", "signature_denominator",
              "loop", "loop_start", "loop_length", "clip_trigger_quantization", "back_to_arranger",
              "cue_points", "tracks")

    def __init__(self):
        Observable.__init__(self, current_song_time=0.0, is_playing=False, tempo=120.0, signature_numerator=4,
                            signature_denominator=4, loop=False, loop_start=0.0, loop_length=16.0,
                            clip_trigger_quantization=4, back_to_arranger=False, cue_points=(), tracks=())
        self.master_track = MasterTrack("Main")
        self.last_event_time = 0.0
        self.song_length = 0.0

    def add_track(self, name, midi=False):
        t = Track(name, midi)
        self.tracks = self.tracks + (t,)
        return t

    def add_cue(self, name, time):
        c = CuePoint(self, name, time)
        self.cue_points = self.cue_points + (c,)
        return c

    def create_audio_track(self, index=-1):
        return self.add_track("Audio")

    def set_or_delete_cue(self):
        for c in self.cue_points:
            if abs(c.time - self.current_song_time) < 1e-3:
                self.cue_points = tuple(x for x in self.cue_points if x is not c)
                return
        self.add_cue("", self.current_song_time)

    def start_playing(self):
        self.is_playing = True

    def continue_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False

    def re_enable_automation(self):
        pass

    def advance(self, ms):
        if self.is_playing:
            self.current_song_time = self.current_song_time + ms / 1000.0 * self.tempo / 60.0


def demo_song():
    s = Song()
    for name in ("Click", "Guide", "Drums", "Keys"):
        t = s.add_track(name)
    s.tracks[2].arrangement_clips = (Clip(0, 64, "/stems/drums.wav"),)
    s.tracks[3].arrangement_clips = (Clip(0, 64, "/stems/keys.wav"),)
    for name, time in (("# Song | 120 | G", 0), ("Intro", 0), ("Verse", 16), ("STOP", 64)):
        s.add_cue(name, time)
    return s
