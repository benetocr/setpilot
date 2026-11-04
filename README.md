# SetPilot app

Playback companion for Ableton Live 11 and 12 (any edition), Mac and Windows.

```
core/       engine, dashboard server and UI (shared with the Max for Live device)
bridge/     mirror of Live's state and the LiveAPI the engine expects
host/       the app: Live connection, engine thread, doorbell, announce
live/       SetPilot Remote Script (Python), its mock Live and tests
installer/  finds Live and installs the Remote Script, no questions asked
dev/        simulators and tests
docs/       protocol
```

Run: `npm start`. Test: `npm test` (engine direct and through the bridge,
the Remote Script against the mock Live, the installer, and end to end with
the real script and host over TCP).

Through the bridge with 100 ms of write delay (Live's slowest case):
`npm run test:latency`.
