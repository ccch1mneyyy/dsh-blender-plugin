"""Scene revision probe for the host viewport panel (v2.3).

The panel needs to know that the *GUI* scene changed even when the change came
from the user's mouse (no agent command runs, so the backend's command-based
``scene_version`` never moves).  This module is injected into the running
Blender by the backend; it keeps a cheap counter on every depsgraph update and
writes a tiny JSON state file into the shared work directory (the backend reads
that file with zero Blender round-trips).

It deliberately does **not** depend on the add-on's code: it only needs
``execute_code`` (every supported addon has it) and ``bpy``.  The backend
injects it lazily and detects a Blender restart by the heartbeat going stale.

State file fields (``scene_revision.json``):
  revision     monotonically increasing counter (reset when Blender restarts)
  last_edit_at unix seconds of the last depsgraph update (0 = no edit yet)
  heartbeat_at unix seconds of the last write (2 s timer keeps it fresh)
  pid          Blender process id (backend can tell restarts apart)
  version      SCENE_REVISION_VERSION
"""

import json
import os
import time

import bpy

SCENE_REVISION_VERSION = 1
# A drag fires depsgraph_update_post many times per second; coalesce writes so
# the shared work directory sees at most ~4 small writes per second.
WRITE_INTERVAL = 0.25
# Keep the state file fresh while Blender is idle; the backend uses this to
# detect a restarted Blender (K/state and the injected module are gone).
HEARTBEAT_INTERVAL = 2.0


def _state():
    state = getattr(K, "dsh_scene_revision_state", None)
    if not isinstance(state, dict):
        state = {
            "revision": 0,
            "last_edit_at": 0.0,
            "heartbeat_at": 0.0,
            "pid": os.getpid(),
            "version": SCENE_REVISION_VERSION,
        }
        K.dsh_scene_revision_state = state
    return state


def _write(force=False):
    """Write the state file atomically; throttled unless ``force``."""
    path = getattr(K, "dsh_scene_revision_path", "")
    if not path:
        return False
    state = _state()
    now = time.time()
    if not force and (now - float(state.get("heartbeat_at") or 0.0)) < WRITE_INTERVAL:
        return False
    state["heartbeat_at"] = now
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "revision": int(state["revision"]),
                    "last_edit_at": float(state["last_edit_at"]),
                    "heartbeat_at": now,
                    "pid": int(state["pid"]),
                    "version": int(SCENE_REVISION_VERSION),
                },
                handle,
                separators=(",", ":"),
            )
        os.replace(tmp, path)
        return True
    except Exception:
        # The backend retries on the next poll; a failed write must never
        # break Blender's depsgraph callbacks.
        return False


def _on_depsgraph(scene, depsgraph=None):
    state = _state()
    state["revision"] = int(state["revision"]) + 1
    state["last_edit_at"] = time.time()
    _write()


def _heartbeat():
    _write(force=True)
    return HEARTBEAT_INTERVAL


# Re-injection in the same Blender (dev loop / backend retry) must not stack
# handlers or timers: remove what a previous injection stored on K.
try:
    old_handler = getattr(K, "dsh_scene_revision_handler", None)
    if old_handler is not None and old_handler in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(old_handler)
except Exception:
    pass
try:
    old_timer = getattr(K, "dsh_scene_revision_timer", None)
    if old_timer is not None and bpy.app.timers.is_registered(old_timer):
        bpy.app.timers.unregister(old_timer)
except Exception:
    pass

if _on_depsgraph not in bpy.app.handlers.depsgraph_update_post:
    bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph)
K.dsh_scene_revision_handler = _on_depsgraph

try:
    bpy.app.timers.register(_heartbeat, first_interval=HEARTBEAT_INTERVAL, persistent=True)
    K.dsh_scene_revision_timer = _heartbeat
except Exception:
    K.dsh_scene_revision_timer = None

_write(force=True)
K.dsh_scene_revision_api = {
    "version": SCENE_REVISION_VERSION,
    "state": _state,
    "write": _write,
}
