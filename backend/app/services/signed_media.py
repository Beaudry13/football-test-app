"""Short-lived signed URLs for browser delivery of protected renders.

WHY SIGNED URLS RATHER THAN AN AUTHENTICATED ENDPOINT
-----------------------------------------------------
Players hold no credential of any kind. Every /play route identifies a player
from `(access_code_id, player_name)` in the request *body*; there is no token,
no cookie and no session. And a browser cannot attach an Authorization header
to an `<img src>` regardless of what the app would like.

So a URL that is itself the credential is not a shortcut here - it is the only
mechanism that works. See docs/DESIGN-playbook-quiz.md §0b and §7a.

THE TOKEN
---------
    v1.<payload>.<signature>

`payload` is compact JSON, base64url. `signature` is HMAC-SHA256 over the
literal string `"v1.<payload>"` using the app's SECRET_KEY.

WHY THE VERSION PREFIX EXISTS FROM DAY ONE
------------------------------------------
Once a coach has sent a quiz, signed URLs are in the wild - in browser caches,
in open tabs, in a phone that has been asleep for a week. Changing the payload
shape or the algorithm later without a version prefix means every one of those
becomes an unexplained broken image. With it, `v2` can be introduced while `v1`
is still accepted for as long as it needs to be, and retired deliberately.

WHY `aud` AND `variant` ARE ALREADY HERE
----------------------------------------
Both are unused in Milestone 1 and both exist anyway, for the same reason:

  - `variant` will carry the mask-set hash in M2, so one page can have several
    differently-masked renders.
  - `aud` will carry `ac:<access_code_id>` so a URL leaked out of one quiz
    cannot be replayed to read a page from another.

Adding either later would change the payload shape, which is precisely what
the version prefix is meant to protect against needing to do. Reserving them
now costs a few bytes and saves a v2.

WHAT CANNOT BE SIGNED
---------------------
There is no `kind` that resolves to the original PDF. Requirement 9 - that no
unauthenticated user and no player can obtain the source document - therefore
holds because the capability does not exist, not because a check somewhere
remembers to refuse it. `resolve_media` below is the only reader, and it can
only reach `document_pages` rasters.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from flask import current_app

SCHEME_VERSION = "v1"

#: What a token may point at. Note the absence of anything meaning "the PDF".
KIND_PAGE = "page"
KIND_THUMBNAIL = "thumb"
VALID_KINDS = frozenset({KIND_PAGE, KIND_THUMBNAIL})

#: Audience for a coach-issued URL. Player audiences (`ac:<id>`) arrive with
#: the player experience in M2/M4.
AUDIENCE_COACH = "coach"


class InvalidMediaToken(Exception):
    """A token that is malformed, expired, tampered with, or of a version this
    build does not understand. Deliberately one exception for all of those:
    the caller returns the same 404 either way, so that a probe cannot learn
    which of its guesses was closer."""


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _sign(signing_input: str) -> str:
    secret = current_app.config["SECRET_KEY"].encode("utf-8")
    return _b64url_encode(hmac.new(secret, signing_input.encode("utf-8"), hashlib.sha256).digest())


def sign_media_token(
    kind: str,
    resource_id: int,
    *,
    variant: str = "",
    audience: str = AUDIENCE_COACH,
    ttl_seconds: int | None = None,
) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"Unknown media kind: {kind!r}")

    ttl = ttl_seconds if ttl_seconds is not None else current_app.config["SIGNED_MEDIA_TTL_SECONDS"]
    payload = {
        "k": kind,
        "i": resource_id,
        "v": variant,
        "a": audience,
        "e": int(time.time()) + int(ttl),
    }
    # sort_keys and the compact separators keep the encoding deterministic, so
    # the same inputs always produce the same token and a signature can be
    # reasoned about in a test.
    encoded = _b64url_encode(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )
    signing_input = f"{SCHEME_VERSION}.{encoded}"
    return f"{signing_input}.{_sign(signing_input)}"


def verify_media_token(token: str) -> dict:
    """Returns the payload, or raises InvalidMediaToken.

    The signature is checked BEFORE the payload is interpreted, and with
    `hmac.compare_digest`, so neither the contents nor the timing of a
    comparison can be used to forge one.
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise InvalidMediaToken("Malformed token")

    version, encoded, signature = parts
    if version != SCHEME_VERSION:
        raise InvalidMediaToken(f"Unsupported token version: {version!r}")

    expected = _sign(f"{version}.{encoded}")
    if not hmac.compare_digest(expected, signature):
        raise InvalidMediaToken("Bad signature")

    try:
        payload = json.loads(_b64url_decode(encoded))
    except (ValueError, TypeError) as exc:
        raise InvalidMediaToken("Undecodable payload") from exc

    if not isinstance(payload, dict):
        raise InvalidMediaToken("Undecodable payload")
    if payload.get("k") not in VALID_KINDS:
        raise InvalidMediaToken("Unknown kind")
    if not isinstance(payload.get("i"), int) or isinstance(payload.get("i"), bool):
        raise InvalidMediaToken("Bad resource id")

    expires_at = payload.get("e")
    if not isinstance(expires_at, int) or isinstance(expires_at, bool):
        raise InvalidMediaToken("Bad expiry")
    if expires_at <= int(time.time()):
        raise InvalidMediaToken("Expired")

    return payload


def seconds_until_expiry(payload: dict) -> int:
    """How long a client may cache this response. Never longer than the token
    itself remains valid, so a cached image cannot outlive its authorisation."""
    return max(0, int(payload["e"]) - int(time.time()))
