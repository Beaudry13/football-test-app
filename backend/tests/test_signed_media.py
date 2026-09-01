"""Signed media tokens: the only credential a browser presents for a
protected render, and therefore the whole access-control boundary."""

import base64
import json
import time

import pytest

from app.services.signed_media import (
    AUDIENCE_COACH,
    KIND_PAGE,
    KIND_QUESTION_MASK,
    KIND_THUMBNAIL,
    SCHEME_VERSION,
    InvalidMediaToken,
    seconds_until_expiry,
    sign_media_token,
    verify_media_token,
)


def _tamper_payload(app, token: str, **changes) -> str:
    """Rewrite a token's payload, keeping its original (now wrong) signature."""
    version, encoded, signature = token.split(".")
    padding = "=" * (-len(encoded) % 4)
    payload = json.loads(base64.urlsafe_b64decode(encoded + padding))
    payload.update(changes)
    rewritten = (
        base64.urlsafe_b64encode(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"{version}.{rewritten}.{signature}"


class TestTokenRoundTrip:
    def test_a_signed_token_verifies(self, app):
        with app.app_context():
            payload = verify_media_token(sign_media_token(KIND_PAGE, 42))
        assert payload["k"] == KIND_PAGE
        assert payload["i"] == 42

    def test_carries_the_reserved_fields(self, app):
        # `variant` and `aud` are unused in M1 and present anyway, so that M2
        # (mask sets) and M4 (per-access-code audiences) do not have to change
        # the payload shape - which is the thing the version prefix exists to
        # avoid needing to do.
        with app.app_context():
            payload = verify_media_token(sign_media_token(KIND_PAGE, 1))
        assert payload["v"] == ""
        assert payload["a"] == AUDIENCE_COACH

    def test_variant_survives_the_round_trip(self, app):
        with app.app_context():
            payload = verify_media_token(sign_media_token(KIND_PAGE, 1, variant="abc123"))
        assert payload["v"] == "abc123"

    def test_version_prefix_is_present(self, app):
        with app.app_context():
            assert sign_media_token(KIND_PAGE, 1).startswith(f"{SCHEME_VERSION}.")

    def test_refuses_to_sign_an_unknown_kind(self, app):
        with app.app_context():
            with pytest.raises(ValueError):
                sign_media_token("source_pdf", 1)

    def test_there_is_no_kind_that_reaches_the_source_pdf(self):
        # "A player cannot obtain the source document" holds by construction
        # rather than by a check somebody has to remember: the capability to
        # address a PDF does not exist.
        #
        # Asserted as an EXACT set on purpose. Adding a token kind is exactly
        # the change that could quietly create such a capability, so it should
        # not be possible to do it without this test failing and forcing the
        # question to be asked again.
        from app.services.signed_media import (
            KIND_CLIP,
            KIND_CLIP_POSTER,
            KIND_DELIVERED_MASK,
            VALID_KINDS,
        )

        # `dmask` was added when delivered region geometry started being
        # frozen into the snapshot. It resolves an
        # `attempt_question_snapshots` row to a mask rendered from the
        # rectangle that attempt was given - still a page-derived image, and
        # still nothing that names the document. The question this test exists
        # to force was asked, which is the test working rather than failing.
        #
        # `clip` and `cpost` were added for Record Clip, and this test failing
        # is what forced the question to be asked again. The answer: neither
        # can reach a document. They resolve a `question_clips` row to that
        # row's own `storage_key` / `poster_key` - objects uploaded by a coach
        # from a screen recording, which have no relationship to a
        # SourceDocument of any kind. The dispatch in routes/media.py reads
        # those two columns and nothing else.
        #
        # Note this widens the guarantee slightly and honestly: not every kind
        # is page-derived any more. What still holds - and what this test is
        # actually for - is that no kind names the source PDF.
        assert VALID_KINDS == {
            KIND_PAGE,
            KIND_THUMBNAIL,
            KIND_QUESTION_MASK,
            KIND_DELIVERED_MASK,
            KIND_CLIP,
            KIND_CLIP_POSTER,
        }
        # No kind names the document itself.
        assert all("pdf" not in kind and "document" not in kind for kind in VALID_KINDS)

    def test_a_clip_token_cannot_name_a_document(self):
        # The structural half of the guarantee above. If someone later gave
        # QuestionClip a document reference, the clip kinds WOULD become a
        # path to a PDF - so the model is asserted to carry only its own two
        # storage keys.
        from app.models import QuestionClip

        columns = {c.key for c in QuestionClip.__table__.columns}
        assert {"storage_key", "poster_key"} <= columns
        assert not any(
            "document" in name or "pdf" in name or "source" in name for name in columns
        )
        assert not hasattr(QuestionClip, "document")
        assert not hasattr(QuestionClip, "source_document")


class TestTokenRejection:
    def test_expired_token_is_rejected(self, app):
        with app.app_context():
            token = sign_media_token(KIND_PAGE, 1, ttl_seconds=-1)
            with pytest.raises(InvalidMediaToken):
                verify_media_token(token)

    def test_tampered_payload_is_rejected(self, app):
        with app.app_context():
            token = sign_media_token(KIND_PAGE, 1)
            # Repointing a valid token at a different page is the obvious
            # attack: one legitimately-obtained URL reading the whole document.
            with pytest.raises(InvalidMediaToken):
                verify_media_token(_tamper_payload(app, token, i=999))

    def test_extending_the_expiry_is_rejected(self, app):
        with app.app_context():
            token = sign_media_token(KIND_PAGE, 1, ttl_seconds=1)
            with pytest.raises(InvalidMediaToken):
                verify_media_token(_tamper_payload(app, token, e=int(time.time()) + 99999))

    def test_tampered_signature_is_rejected(self, app):
        with app.app_context():
            version, encoded, signature = sign_media_token(KIND_PAGE, 1).split(".")
            flipped = ("A" if signature[0] != "A" else "B") + signature[1:]
            with pytest.raises(InvalidMediaToken):
                verify_media_token(f"{version}.{encoded}.{flipped}")

    def test_unsigned_token_is_rejected(self, app):
        with app.app_context():
            with pytest.raises(InvalidMediaToken):
                verify_media_token(f"{SCHEME_VERSION}.eyJrIjoicGFnZSJ9.")

    def test_unknown_version_is_rejected(self, app):
        with app.app_context():
            _, encoded, signature = sign_media_token(KIND_PAGE, 1).split(".")
            with pytest.raises(InvalidMediaToken):
                verify_media_token(f"v99.{encoded}.{signature}")

    @pytest.mark.parametrize("malformed", ["", "junk", "a.b", "a.b.c.d", "v1..", "..."])
    def test_malformed_tokens_are_rejected(self, app, malformed):
        with app.app_context():
            with pytest.raises(InvalidMediaToken):
                verify_media_token(malformed)

    def test_a_token_signed_with_another_secret_is_rejected(self, app):
        with app.app_context():
            token = sign_media_token(KIND_PAGE, 1)
            original = app.config["SECRET_KEY"]
            app.config["SECRET_KEY"] = "a-completely-different-secret-key-32b"
            try:
                with pytest.raises(InvalidMediaToken):
                    verify_media_token(token)
            finally:
                app.config["SECRET_KEY"] = original


class TestCacheLifetime:
    def test_never_outlives_the_token(self, app):
        with app.app_context():
            payload = verify_media_token(sign_media_token(KIND_PAGE, 1, ttl_seconds=60))
        assert 0 < seconds_until_expiry(payload) <= 60
