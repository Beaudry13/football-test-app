"""Recoverable coach invitations, and every way that recovery can fail.

THE PROPERTY THAT MATTERS MOST IS NOT THE ENCRYPTION. It is that encryption
never becomes a precondition for an invitation working. A missing key, a
rotated key, a corrupt value or a row from before the feature existed must all
leave the invite fully redeemable and merely un-re-readable - because the
alternative is a deployment where nobody can create an account because a
convenience feature is misconfigured.
"""
import pytest

from app.extensions import db
from app.models.beta_invite import BetaInvite
from app.services import beta_invites, invite_secrets


@pytest.fixture
def keyed(app):
    """An app context with a configured invite key."""
    with app.app_context():
        previous = app.config.get("INVITE_TOKEN_KEY")
        app.config["INVITE_TOKEN_KEY"] = "a-high-entropy-test-secret-value-0123456789"
        yield app
        app.config["INVITE_TOKEN_KEY"] = previous


@pytest.fixture
def unkeyed(app):
    with app.app_context():
        previous = app.config.get("INVITE_TOKEN_KEY")
        app.config["INVITE_TOKEN_KEY"] = None
        yield app
        app.config["INVITE_TOKEN_KEY"] = previous


class TestTheKeyIsDerived:
    """Render's generateValue emits an arbitrary random string, not the 32-byte
    url-safe base64 Fernet wants. Demanding that format would mean a
    hand-generated secret and an operator who has to know why."""

    def test_an_arbitrary_string_works_as_a_key(self, keyed):
        assert invite_secrets.is_configured()
        assert invite_secrets.decrypt(invite_secrets.encrypt("PEIRA-AAAA-BBBB-CCCC")) == (
            "PEIRA-AAAA-BBBB-CCCC"
        )

    def test_the_same_secret_always_derives_the_same_key(self, keyed):
        """Yesterday's ciphertext must open today, or the feature is a lie."""
        ciphertext = invite_secrets.encrypt("PEIRA-AAAA-BBBB-CCCC")
        assert invite_secrets.decrypt(ciphertext) == "PEIRA-AAAA-BBBB-CCCC"

    def test_a_different_secret_cannot_read_it(self, app, keyed):
        ciphertext = invite_secrets.encrypt("PEIRA-AAAA-BBBB-CCCC")
        app.config["INVITE_TOKEN_KEY"] = "an-entirely-different-secret-value-987654"

        assert invite_secrets.decrypt(ciphertext) is None

    def test_the_ciphertext_does_not_contain_the_plaintext(self, keyed):
        # Groups chosen so they cannot collide with Fernet's own framing: a
        # ciphertext always begins "gAAAAAB..." (version byte and timestamp in
        # base64), so asserting against a plaintext containing "AAAA" fails on
        # the framing rather than on any leak.
        ciphertext = invite_secrets.encrypt("PEIRA-7K3M-Q9XZ-2FWD")

        assert "PEIRA" not in ciphertext
        for group in ("7K3M", "Q9XZ", "2FWD"):
            assert group not in ciphertext


class TestEveryFailureIsSoft:
    def test_no_key_means_no_ciphertext_rather_than_an_error(self, unkeyed):
        assert invite_secrets.is_configured() is False
        assert invite_secrets.encrypt("PEIRA-AAAA-BBBB-CCCC") is None

    def test_decrypting_without_a_key_returns_none(self, unkeyed):
        assert invite_secrets.decrypt("gAAAAABm-not-a-real-token") is None

    def test_a_corrupt_ciphertext_returns_none(self, keyed):
        """Fernet is authenticated, so a tampered value fails rather than
        decrypting to nonsense the owner might then send to somebody."""
        good = invite_secrets.encrypt("PEIRA-AAAA-BBBB-CCCC")
        tampered = good[:-4] + "AAAA"

        assert invite_secrets.decrypt(tampered) is None

    def test_none_and_empty_are_handled(self, keyed):
        assert invite_secrets.decrypt(None) is None
        assert invite_secrets.decrypt("") is None
        assert invite_secrets.encrypt("") is None


class TestIssuingStillWorksWithoutAKey:
    """THE CRITICAL PROPERTY. A misconfigured convenience must never stop
    invitations being created or redeemed."""

    def test_an_invite_issues_and_redeems_with_no_key_configured(self, unkeyed):
        invite, token = beta_invites.issue(label="No key here")

        assert token.startswith("PEIRA-")
        assert invite.token_ciphertext is None
        assert invite.is_usable()
        # And the hash path is untouched.
        assert beta_invites.find_usable(token) is invite

    def test_reveal_is_none_without_a_key_but_the_invite_lives(self, unkeyed):
        invite, token = beta_invites.issue()

        assert beta_invites.reveal(invite) is None
        assert beta_invites.find_usable(token) is invite


class TestRecoveringAPendingInvite:
    def test_the_owner_gets_back_the_SAME_code(self, keyed):
        """The whole point: an invite sent on Monday is the invite shown on
        Tuesday, not a different one."""
        invite, token = beta_invites.issue(label="Coach Benedict")

        assert beta_invites.reveal(invite) == token

    def test_the_plaintext_is_not_in_the_row(self, keyed):
        invite, token = beta_invites.issue()

        bare = token.replace("PEIRA-", "").replace("-", "")
        assert invite.token_ciphertext and bare not in invite.token_ciphertext
        assert bare not in (invite.token_hash or "")

    def test_a_legacy_row_with_no_ciphertext_reveals_nothing(self, keyed):
        """Exactly the state every invite issued before this feature is in."""
        invite, token = beta_invites.issue()
        invite.token_ciphertext = None
        db.session.commit()

        assert beta_invites.reveal(invite) is None
        # ...and it still redeems, which is the point.
        assert beta_invites.find_usable(token) is invite


class TestTheSecretDisappearsWhenNoLongerPending:
    def test_redeeming_clears_the_ciphertext(self, keyed, client, coach_headers):
        from app.models import Coach

        invite, _token = beta_invites.issue()
        coach = Coach.query.first()
        assert beta_invites.redeem(invite, coach.id) is True
        db.session.commit()
        db.session.refresh(invite)

        assert invite.token_ciphertext is None
        assert beta_invites.reveal(invite) is None

    def test_revoking_clears_the_ciphertext(self, keyed):
        invite, _token = beta_invites.issue()
        assert beta_invites.revoke(invite) is True
        db.session.commit()
        db.session.refresh(invite)

        assert invite.token_ciphertext is None
        assert beta_invites.reveal(invite) is None

    def test_an_expired_invite_is_not_revealed_even_though_it_still_holds_one(
        self, keyed
    ):
        """DELIBERATE: expiry has no event to hook, so the ciphertext is left
        in place and `reveal` refuses on state instead. An expired invitation
        is not a live grant - its code redeems nothing - so the row is not a
        usable secret, and adding a write to a read path to tidy it would be
        the more surprising choice."""
        from datetime import timedelta

        invite, _token = beta_invites.issue()
        invite.expires_at = BetaInvite.now() - timedelta(days=1)
        db.session.commit()

        assert invite.token_ciphertext is not None
        assert beta_invites.reveal(invite) is None


class TestReplacingAnUnrecoverableInvite:
    def test_it_issues_a_new_code_on_the_SAME_row(self, keyed):
        invite, original = beta_invites.issue(label="Coach Benedict")
        invite.token_ciphertext = None  # the legacy state
        db.session.commit()
        original_id, original_label = invite.id, invite.label

        replacement = beta_invites.replace_token(invite)
        db.session.commit()
        db.session.refresh(invite)

        assert replacement and replacement != original
        assert invite.id == original_id
        assert invite.label == original_label  # the audit trail survives
        assert beta_invites.reveal(invite) == replacement

    def test_the_previous_code_stops_working(self, keyed):
        invite, original = beta_invites.issue()
        beta_invites.replace_token(invite)
        db.session.commit()

        assert beta_invites.find_usable(original) is None

    def test_the_new_code_redeems(self, keyed):
        invite, _original = beta_invites.issue()
        replacement = beta_invites.replace_token(invite)
        db.session.commit()

        assert beta_invites.find_usable(replacement) is invite

    def test_it_refuses_an_invite_that_is_no_longer_open(self, keyed):
        invite, _token = beta_invites.issue()
        beta_invites.revoke(invite)
        db.session.commit()

        assert beta_invites.replace_token(invite) is None
