"""Encrypting a coach invitation so the owner can open it again tomorrow.

WHAT THIS IS FOR, AND WHAT IT IS NOT
------------------------------------
`BetaInvite` stores only a SHA-256 of its token, and REDEMPTION STILL WORKS
THAT WAY - a candidate is hashed and matched against `token_hash`, exactly as
before. Nothing here participates in deciding whether an invitation is valid.

This module exists for one product reason: an owner who issued an invite on
Monday needs to send the SAME code on Tuesday. Reissuing a different token
would invalidate whatever they had already passed on, so the plaintext has to
survive somewhere the owner can reach - and encrypted, under a key that lives
in the environment rather than the database, is the least-bad place.

THE HONEST COST, STATED ONCE
-----------------------------
Before this, a stolen database dump yielded no usable invitations at all. It
still yields none ON ITS OWN. But a dump TOGETHER WITH the environment now
yields the codes of invitations that are still pending. That is a real
reduction and it is the price of the feature; it is bounded by clearing the
ciphertext the moment an invite stops being pending (see
services/beta_invites.redeem and .revoke).

THE KEY IS DERIVED, NOT REQUIRED TO BE A FERNET KEY
----------------------------------------------------
Fernet wants 32 bytes of url-safe base64. Render's `generateValue: true` -
which is how SECRET_KEY and JWT_SECRET_KEY are already provisioned - emits an
arbitrary random string that is NOT that format, so demanding a literal Fernet
key would mean a hand-generated secret and an operator who has to know why.

HKDF-SHA256 turns whatever high-entropy string the environment supplies into a
correctly shaped key, deterministically, so the same env value always derives
the same key and yesterday's ciphertext still opens today. The `info` string
pins this derivation to this purpose: the same secret used elsewhere would
derive a different key here.

EVERY FAILURE IS SOFT
----------------------
A missing key, a rotated key, a corrupt value, a row from before this existed -
all return None rather than raising. An invitation whose code cannot be
recovered is an inconvenience the owner can solve by replacing it; an exception
here would take down the Owner Dashboard, and worse, a raise on the ISSUE path
would stop invitations being created at all. Encryption is a convenience layered
on top of the invite; it must never become a precondition for one.
"""
from __future__ import annotations

from flask import current_app

#: Bound to this purpose, so the same secret elsewhere derives a different key.
_HKDF_INFO = b"peira-coach-invite-token-v1"


def _fernet():
    """A Fernet for the configured key, or None if there is no usable key.

    Imported lazily so a deployment without `cryptography` - or with a broken
    install - degrades to hash-only rather than failing at import time and
    taking the whole application with it.
    """
    secret = current_app.config.get("INVITE_TOKEN_KEY")
    if not secret:
        return None

    try:
        import base64

        from cryptography.fernet import Fernet
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF

        material = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=_HKDF_INFO,
        ).derive(secret.encode("utf-8"))
        return Fernet(base64.urlsafe_b64encode(material))
    except Exception:
        # A broken key or a missing library must not break issuing invites.
        return None


def encrypt(token: str) -> str | None:
    """Ciphertext for storage, or None if no key is configured.

    None is a normal outcome, not an error: the invite is still issued, still
    redeemable, and simply cannot be re-read by the owner later.
    """
    fernet = _fernet()
    if fernet is None or not token:
        return None
    try:
        return fernet.encrypt(token.encode("utf-8")).decode("ascii")
    except Exception:
        return None


def decrypt(ciphertext: str | None) -> str | None:
    """The original token, or None for every failure.

    None covers: no ciphertext stored (an invite from before this existed), no
    key configured, a key that has since been rotated or regenerated, and a
    corrupt or tampered value - Fernet is authenticated, so a modified
    ciphertext fails rather than decrypting to nonsense. The caller tells the
    owner the code cannot be recovered; it must never guess.
    """
    if not ciphertext:
        return None
    fernet = _fernet()
    if fernet is None:
        return None
    try:
        return fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except Exception:
        return None


def is_configured() -> bool:
    """Whether recoverable invites are possible at all in this deployment.

    Lets the owner surface distinguish "this invite predates the feature" from
    "this deployment has no key", which are different problems with different
    fixes.
    """
    return _fernet() is not None
