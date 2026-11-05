# SetPilot bridge for Ableton Live (Live 11 and 12, any edition).
# Live loads this folder from the User Library's "Remote Scripts" folder and
# calls create_instance once a control surface slot uses it.


def create_instance(c_instance):
    # Live keeps Python modules loaded between uses; reload ours so an update
    # takes effect when the surface is chosen again, without restarting Live
    import importlib
    from . import core, net, surface
    for m in (core, net, surface):
        try:
            importlib.reload(m)
        except Exception:
            pass
    return surface.SetPilotSurface(c_instance)
