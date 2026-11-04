# SetPilot bridge for Ableton Live (Live 11 and 12, any edition).
# Live loads this folder from the User Library's "Remote Scripts" folder and
# calls create_instance once a control surface slot uses it.

from .surface import SetPilotSurface


def create_instance(c_instance):
    return SetPilotSurface(c_instance)
