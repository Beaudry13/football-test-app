"""Structural validation of Motion Lab documents.

WHAT THIS PROTECTS, AND WHAT IT DELIBERATELY DOES NOT
-----------------------------------------------------
The server protects STRUCTURE, TENANCY AND RESOURCES: a document is an object
of the authored shape, bounded in size and count, with finite numbers, known
enum words and bounded strings. That is what keeps a malformed or hostile
payload from filling a JSONB column with something no client can open.

It does NOT decide whether a play makes football sense - whether a pitch can
reach its target, whether an engagement point is reachable, whether a
referenced player still exists. That is the Motion Lab engine's job, and the
validated frontend model already repairs or drops such intent when a play is
opened (sanitizePlay in frontend/src/motion-lab/engine/play.ts). Writing a
second football interpreter in Python would give PEIRA two opinions about the
same play. There is one, and it lives in the engine.

UNKNOWN KEYS ARE REFUSED. The stored document is the authored model and
nothing else, so a client cannot quietly start persisting derived state -
schedules, frames, orientation, playback position - by adding a field. A new
authored field is a schema change: bump SUPPORTED_SCHEMA_VERSIONS and this
file together.
"""

from __future__ import annotations

import json
import math

from app.errors import ApiError

#: The frontend model's SCHEMA_VERSION values this server accepts.
SUPPORTED_SCHEMA_VERSIONS = frozenset({1})

#: Serialized size ceilings. A real play is a few KB (22 players, a handful of
#: anchors each); these leave two orders of magnitude of headroom.
MAX_PLAY_DOCUMENT_BYTES = 256 * 1024
MAX_LOOK_DOCUMENT_BYTES = 64 * 1024

MAX_PLAYERS = 40
MAX_PATH_ANCHORS = 250
MAX_ENGAGEMENTS = 60
MAX_ID_LENGTH = 64
MAX_LABEL_LENGTH = 16
#: Field coordinates are yards (the field is 53.3 wide); anything this far out
#: is not a position, it is garbage.
MAX_ABS_COORDINATE = 1000.0
MAX_DELAY_SECONDS = 60.0

SIDES = {"offense", "defense"}
TIMINGS = {"pre-snap", "on-snap", "delayed"}
SPEEDS = {"controlled", "normal", "fast"}
END_BEHAVIORS = {"continue", "settle"}
HASHES = {"left", "middle", "right"}
FILTERS = {"all", "offense", "defense", "none"}
BALL_KINDS = {"keep", "handoff", "pitch", "pass", "play-action"}

PLAY_KEYS = {"players", "ball", "ballThen", "engagements", "situation", "filter"}
LOOK_KEYS = {"players"}
PLAYER_KEYS = {"id", "side", "label", "x", "y", "path", "timing", "delay", "speed", "endBehavior"}
BALL_KEYS = {"kind", "carrierId", "targetId", "fakeId", "catchPoint", "releasePoint"}
ENGAGEMENT_KEYS = {"id", "kind", "a", "b", "point", "release"}
SITUATION_KEYS = {"losYard", "hash", "down", "distance", "show"}
POINT_KEYS = {"x", "y"}


class _Invalid(Exception):
    pass


def _fail(path: str, message: str):
    raise _Invalid(f"{path}: {message}")


def _object(value, path: str, allowed: set[str], required: set[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        _fail(path, f"unknown field(s) {', '.join(unknown)}")
    missing = sorted(required - set(value))
    if missing:
        _fail(path, f"missing field(s) {', '.join(missing)}")
    return value


def _number(value, path: str, *, low: float = -MAX_ABS_COORDINATE, high: float = MAX_ABS_COORDINATE):
    # bool is an int in Python; it is not a number here.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "must be a number")
    if not math.isfinite(value):
        _fail(path, "must be a finite number")
    if value < low or value > high:
        _fail(path, f"must be between {low} and {high}")
    return value


def _string(value, path: str, *, max_length: int = MAX_ID_LENGTH, choices: set[str] | None = None):
    if not isinstance(value, str):
        _fail(path, "must be a string")
    if len(value) > max_length:
        _fail(path, f"must be at most {max_length} characters")
    if choices is not None and value not in choices:
        _fail(path, f"must be one of {', '.join(sorted(choices))}")
    return value


def _optional(value) -> bool:
    return value is None


def _point(value, path: str):
    point = _object(value, path, POINT_KEYS, POINT_KEYS)
    _number(point["x"], f"{path}.x")
    _number(point["y"], f"{path}.y")


def _players(value, path: str):
    if not isinstance(value, list):
        _fail(path, "must be a list")
    if len(value) > MAX_PLAYERS:
        _fail(path, f"at most {MAX_PLAYERS} players")
    seen: set[str] = set()
    for i, raw in enumerate(value):
        p = f"{path}[{i}]"
        player = _object(raw, p, PLAYER_KEYS, {"id", "x", "y"})
        player_id = _string(player["id"], f"{p}.id")
        if player_id in seen:
            _fail(f"{p}.id", "is used by more than one player")
        seen.add(player_id)
        _number(player["x"], f"{p}.x")
        _number(player["y"], f"{p}.y")
        if "side" in player:
            _string(player["side"], f"{p}.side", choices=SIDES)
        if "label" in player:
            _string(player["label"], f"{p}.label", max_length=MAX_LABEL_LENGTH)
        if "path" in player:
            path_value = player["path"]
            if not isinstance(path_value, list):
                _fail(f"{p}.path", "must be a list")
            if len(path_value) > MAX_PATH_ANCHORS:
                _fail(f"{p}.path", f"at most {MAX_PATH_ANCHORS} anchors")
            for j, anchor in enumerate(path_value):
                _point(anchor, f"{p}.path[{j}]")
        if "timing" in player:
            _string(player["timing"], f"{p}.timing", choices=TIMINGS)
        if "delay" in player:
            _number(player["delay"], f"{p}.delay", low=0, high=MAX_DELAY_SECONDS)
        if "speed" in player:
            _string(player["speed"], f"{p}.speed", choices=SPEEDS)
        if "endBehavior" in player and not _optional(player["endBehavior"]):
            _string(player["endBehavior"], f"{p}.endBehavior", choices=END_BEHAVIORS)


def _ball(value, path: str):
    if _optional(value):
        return
    ball = _object(value, path, BALL_KEYS, {"kind"})
    _string(ball["kind"], f"{path}.kind", choices=BALL_KINDS)
    # References are checked for SHAPE only. Whether they name a player who is
    # still on the field is the engine's call - sanitizePlay drops a dangling
    # one on open rather than pointing it at somebody else.
    for key in ("carrierId", "targetId", "fakeId"):
        if key in ball and not _optional(ball[key]):
            _string(ball[key], f"{path}.{key}")
    for key in ("catchPoint", "releasePoint"):
        if key in ball and not _optional(ball[key]):
            _point(ball[key], f"{path}.{key}")


def _engagements(value, path: str):
    if not isinstance(value, list):
        _fail(path, "must be a list")
    if len(value) > MAX_ENGAGEMENTS:
        _fail(path, f"at most {MAX_ENGAGEMENTS} engagements")
    for i, raw in enumerate(value):
        p = f"{path}[{i}]"
        engagement = _object(raw, p, ENGAGEMENT_KEYS, {"a", "b", "point"})
        if "id" in engagement:
            _string(engagement["id"], f"{p}.id")
        if "kind" in engagement:
            _string(engagement["kind"], f"{p}.kind", choices={"engage"})
        _string(engagement["a"], f"{p}.a")
        _string(engagement["b"], f"{p}.b")
        _point(engagement["point"], f"{p}.point")
        if "release" in engagement and not _optional(engagement["release"]):
            _string(engagement["release"], f"{p}.release")


def _situation(value, path: str):
    situation = _object(value, path, SITUATION_KEYS)
    if "losYard" in situation:
        _number(situation["losYard"], f"{path}.losYard", low=0, high=100)
    if "hash" in situation:
        _string(situation["hash"], f"{path}.hash", choices=HASHES)
    if "down" in situation:
        _number(situation["down"], f"{path}.down", low=1, high=4)
    if "distance" in situation:
        _number(situation["distance"], f"{path}.distance", low=0, high=100)
    if "show" in situation and not isinstance(situation["show"], bool):
        _fail(f"{path}.show", "must be true or false")


def _size(document, limit: int):
    encoded = json.dumps(document, separators=(",", ":"), allow_nan=True)
    if len(encoded.encode("utf-8")) > limit:
        raise ApiError(
            "This play is too large to save.",
            status_code=413,
            reason="document_too_large",
        )


def _refuse(error: _Invalid):
    raise ApiError("Validation failed", status_code=422, details={"document": [str(error)]})


def _version(schema_version):
    if isinstance(schema_version, bool) or schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        raise ApiError(
            "Validation failed",
            status_code=422,
            details={"schema_version": [f"must be one of {sorted(SUPPORTED_SCHEMA_VERSIONS)}"]},
        )


def validate_play_document(document, schema_version) -> dict:
    """Refuse (422/413) anything that is not a structurally sound play."""
    _version(schema_version)
    try:
        doc = _object(document, "document", PLAY_KEYS, {"players"})
        _size(doc, MAX_PLAY_DOCUMENT_BYTES)
        _players(doc["players"], "players")
        for key in ("ball", "ballThen"):
            if key in doc:
                _ball(doc[key], key)
        if "engagements" in doc:
            _engagements(doc["engagements"], "engagements")
        if "situation" in doc:
            _situation(doc["situation"], "situation")
        if "filter" in doc:
            _string(doc["filter"], "filter", choices=FILTERS)
    except _Invalid as error:
        _refuse(error)
    return doc


def validate_look_document(document, schema_version) -> dict:
    """Refuse anything that is not a structurally sound look (players only)."""
    _version(schema_version)
    try:
        doc = _object(document, "document", LOOK_KEYS, {"players"})
        _size(doc, MAX_LOOK_DOCUMENT_BYTES)
        _players(doc["players"], "players")
    except _Invalid as error:
        _refuse(error)
    return doc
