# Bridge protocol (version 1)

The SetPilot Remote Script (`live/SetPilot`) and the app talk over TCP on
127.0.0.1, one JSON object per line. The script picks a free port from
8790 to 8799 and writes it, with a random token, to `~/.setpilot/bridge.json`.
The app reads that file, connects and sends `{"t":"auth","token":...}`.

## Script to app

| t | meaning |
|---|---------|
| `hello` | protocol version, Live version |
| `snap` | every object the app needs: `o: {id: {k: kind, p: {prop: value}}}`, `roots: {song, app_view}` |
| `d` | what changed: `o` (changed props; new objects come whole with `k`), `gone` (ids), `aw` |
| `time` | song position `s`, playing `p`, `tempo`, `aw`; sent from Live's position listener while playing (about every 8 ms at most) |
| `res` | answer to a message that had `q`: `ok`, `v` or `err`; everything the request changed is sent as `d` before it |

Values are JSON; a Live object is `{"$": id}`. Ids are small numbers given by
the script for the session. Kinds and their properties are in
`live/SetPilot/spec.json`, shared by both sides.

## App to script

| t | meaning |
|---|---------|
| `set` | `id`, `p`, `v`, `w` (write number) |
| `call` | `id`, `f`, `a` (args), `w`; with `q` the app waits for `res` |
| `get` | `id`, `p`, `q`; `watch: 1` keeps that property updated from then on |
| `ping` | `q`; the answer carries the script's timing stats |

`aw` is the last write number Live has carried out. Until then the app keeps
its own newer value for that property (no flicker back to the old value).

## Timing

Live lets a script change the set only from `update_display` (about every
100 ms) or `receive_midi`. The app rings a doorbell, CC 119 on channel 16 on
its virtual MIDI port "SetPilot Bridge", after it writes; the script then runs
the commands at once. Without the doorbell commands wait for the next tick.
The app measures the round trip on connect and every minute and sends the
engine `latency <ms>`, so timed changes are asked for that much earlier.
