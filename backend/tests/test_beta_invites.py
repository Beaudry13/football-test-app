"""BETA INVITES - the foundation, with no route and no screen attached.

WHAT THIS IS FOR
----------------
Peira is free and open to sign up for today. This is the machinery that would
let invitations be handed out deliberately instead - a token that creates ONE
account and records which one it created, so "how did this coach get into the
beta" has an answer.

NOTHING USES IT YET, ON PURPOSE. Registration is untouched; wiring it in is a
product decision about whether public signup closes, not an implementation
detail, and it should be made deliberately rather than arrived at.

THE TOKEN IS A CREDENTIAL
-------------------------
Only its SHA-256 is stored, so a leaked database yields no usable invitations.
Every failure - unknown, revoked, already-redeemed - is one indistinguishable
answer, so a guessed token cannot be probed to learn which invites exist.

REDEMPTION IS A CONDITIONAL UPDATE, NOT A READ-THEN-WRITE
---------------------------------------------------------
`TestOnlyOneRedemptionWins` is the test this whole design exists for. Check-
then-assign would let two people holding the same link both pass the check and
both create an account, with the record of who used it being whoever committed
last. The database decides instead.

Worth recording: `OrganizationInvite` - the OTHER invite type, already shipped
- still does check-then-assign in `routes/auth.register_with_invite`, so it
has exactly that race. Reported rather than fixed here; it is live behaviour
and deserves its own change.
"""

import pytest
from sqlalchemy import update as sa_update

from app.extensions import db
from app.models import Coach, Organization
from app.models.beta_invite import BetaInvite
from app.services import beta_invites


@pytest.fixture
def coach_id(app):
    with app.app_context():
        org = Organization(name="Wildcats")
        db.session.add(org)
        db.session.flush()
        coach = Coach(username="owner", email="owner@example.com", organization_id=org.id)
        coach.set_password("password123")
        db.session.add(coach)
        db.session.commit()
        return coach.id


class TestIssuing:
    def test_the_token_is_returned_exactly_once_and_never_stored(self, app, coach_id):
        """THE PROPERTY THAT MAKES A LEAK HARMLESS. If the plaintext were
        recoverable from the row, a stolen backup would be a set of live
        account-creation grants."""
        with app.app_context():
            invite, token = beta_invites.issue(label="Coach Smith - Madeira")

            stored = db.session.get(BetaInvite, invite.id)
            blob = " ".join(str(v) for v in stored.to_dict().values())

            bare = beta_invites.normalise(token)
            assert bare not in stored.token_hash
            assert bare not in blob
            assert stored.token_hash != bare

    def test_it_looks_like_a_peira_code(self, app, coach_id):
        with app.app_context():
            _, token = beta_invites.issue()

            assert token.startswith("PEIRA-")
            assert len(token.split("-")) == 4

    def test_the_alphabet_avoids_characters_that_get_misheard(self, app):
        with app.app_context():
            for _ in range(20):
                _, token = beta_invites.issue()
                for banned in "ILOU01":
                    assert banned not in beta_invites.normalise(token), banned

    def test_two_invites_never_collide(self, app):
        with app.app_context():
            tokens = {beta_invites.issue()[1] for _ in range(25)}

            assert len(tokens) == 25

    def test_the_label_is_the_owners_own_note(self, app, coach_id):
        with app.app_context():
            invite, _ = beta_invites.issue(label="  Coach Smith - Madeira  ")

            assert invite.label == "Coach Smith - Madeira"

    def test_a_blank_label_is_stored_as_nothing(self, app):
        """One representation of "no note", not two."""
        with app.app_context():
            invite, _ = beta_invites.issue(label="   ")

            assert invite.label is None


class TestFinding:
    def test_a_fresh_invite_is_found(self, app):
        with app.app_context():
            invite, token = beta_invites.issue()

            assert beta_invites.find_usable(token).id == invite.id

    @pytest.mark.parametrize(
        "mangle",
        [
            lambda t: t.lower(),
            lambda t: t.replace("-", ""),
            lambda t: f"  {t}  ",
            lambda t: t.replace("PEIRA-", ""),
            lambda t: t.lower().replace("-", " "),
        ],
    )
    def test_it_forgives_how_a_coach_typed_it(self, app, mangle):
        """Case, dashes, spaces and the prefix are presentation. A coach
        reading a code off a text message must not fail on any of them."""
        with app.app_context():
            invite, token = beta_invites.issue()

            assert beta_invites.find_usable(mangle(token)).id == invite.id

    def test_an_unknown_token_is_simply_not_found(self, app):
        with app.app_context():
            assert beta_invites.find_usable("PEIRA-2345-6789-ABCD") is None

    def test_empty_input_is_not_found(self, app):
        with app.app_context():
            assert beta_invites.find_usable("") is None
            assert beta_invites.find_usable(None) is None

    def test_a_redeemed_invite_is_not_found(self, app, coach_id):
        with app.app_context():
            invite, token = beta_invites.issue()
            beta_invites.redeem(invite, coach_id)
            db.session.commit()

            assert beta_invites.find_usable(token) is None

    def test_a_revoked_invite_is_not_found(self, app):
        with app.app_context():
            invite, token = beta_invites.issue()
            beta_invites.revoke(invite)
            db.session.commit()

            assert beta_invites.find_usable(token) is None

    def test_every_failure_is_indistinguishable(self, app, coach_id):
        """UNKNOWN, REVOKED AND USED ALL RETURN None. A caller cannot report
        which it was, so a guessed token cannot be probed for whether it
        exists."""
        with app.app_context():
            used, used_token = beta_invites.issue()
            beta_invites.redeem(used, coach_id)
            revoked, revoked_token = beta_invites.issue()
            beta_invites.revoke(revoked)
            db.session.commit()

            outcomes = {
                beta_invites.find_usable(used_token),
                beta_invites.find_usable(revoked_token),
                beta_invites.find_usable("PEIRA-2345-6789-ABCD"),
            }

            assert outcomes == {None}


class TestOnlyOneRedemptionWins:
    def test_redeeming_records_who_used_it(self, app, coach_id):
        with app.app_context():
            invite, _ = beta_invites.issue()

            assert beta_invites.redeem(invite, coach_id) is True
            db.session.commit()

            stored = db.session.get(BetaInvite, invite.id)
            assert stored.redeemed_by_coach_id == coach_id
            assert stored.redeemed_at is not None
            assert stored.is_usable() is False

    def test_A_SECOND_REDEMPTION_LOSES(self, app, coach_id):
        """Two claims in one session. Weak on its own - see the test below."""
        with app.app_context():
            invite, _ = beta_invites.issue()

            first = beta_invites.redeem(invite, coach_id)
            second = beta_invites.redeem(invite, coach_id)

            assert (first, second) == (True, False)

    def test_A_CONCURRENT_CLAIM_ON_ANOTHER_CONNECTION_LOSES(self, app, coach_id):
        """THE TEST THIS DESIGN EXISTS FOR, and the only one that discriminates.

        The single-session version above passes even against a naive
        check-then-write - measured, not assumed - because the second call
        re-reads an object the first already mutated in memory. A real race is
        two REQUESTS, on two connections, neither of which can see the other's
        uncommitted work.

        Here the other connection redeems and commits while this one is still
        holding an invite it looked up a moment earlier and believes is
        usable. Only asking the DATABASE can get this right.
        """
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session

        with app.app_context():
            invite, token = beta_invites.issue()
            invite_id = invite.id
            # What this request looked up before the other one arrived. Still
            # unredeemed as far as this session knows - and it stays that way.
            mine = beta_invites.find_usable(token)
            assert mine is not None and mine.is_usable()

            # render_as_string, not str(): str() masks the password, and a
            # second engine built from a masked URL cannot authenticate.
            url = db.engine.url.render_as_string(hide_password=False)

        other_engine = create_engine(url)
        try:
            with Session(other_engine) as other:
                other.execute(
                    sa_update(BetaInvite)
                    .where(BetaInvite.id == invite_id, BetaInvite.redeemed_at.is_(None))
                    .values(redeemed_at=BetaInvite.now(), redeemed_by_coach_id=coach_id)
                )
                other.commit()

            with app.app_context():
                # This session's object still says usable; the row does not.
                assert mine.is_usable() is True, "the stale view is the whole point"

                assert beta_invites.redeem(mine, coach_id) is False
        finally:
            other_engine.dispose()

    def test_a_concurrent_claim_by_ANOTHER_coach_loses(self, app, coach_id):
        """The version that matters: the second claimant is a different
        person, so a wrong answer here means a stranger got an account."""
        with app.app_context():
            other = Coach(
                username="stranger",
                email="stranger@example.com",
                organization_id=db.session.get(Coach, coach_id).organization_id,
            )
            other.set_password("password123")
            db.session.add(other)
            db.session.flush()
            invite, _ = beta_invites.issue()

            assert beta_invites.redeem(invite, coach_id) is True
            assert beta_invites.redeem(invite, other.id) is False
            db.session.commit()

            assert db.session.get(BetaInvite, invite.id).redeemed_by_coach_id == coach_id

    def test_a_revoked_invite_cannot_be_redeemed(self, app, coach_id):
        with app.app_context():
            invite, _ = beta_invites.issue()
            beta_invites.revoke(invite)

            assert beta_invites.redeem(invite, coach_id) is False

    def test_an_invite_revoked_between_lookup_and_redemption_loses(self, app, coach_id):
        """The window a read-then-write would miss entirely."""
        with app.app_context():
            invite, token = beta_invites.issue()
            found = beta_invites.find_usable(token)
            db.session.execute(
                sa_update(BetaInvite)
                .where(BetaInvite.id == invite.id)
                .values(revoked_at=BetaInvite.now())
            )

            assert beta_invites.redeem(found, coach_id) is False


class TestRevoking:
    def test_it_records_when_rather_than_a_flag(self, app):
        with app.app_context():
            invite, _ = beta_invites.issue()

            assert beta_invites.revoke(invite) is True
            db.session.commit()

            assert db.session.get(BetaInvite, invite.id).revoked_at is not None

    def test_an_ALREADY_REDEEMED_invite_cannot_be_revoked(self, app, coach_id):
        """History must not say an invite was cancelled when it was used."""
        with app.app_context():
            invite, _ = beta_invites.issue()
            beta_invites.redeem(invite, coach_id)

            assert beta_invites.revoke(invite) is False
            db.session.commit()

            stored = db.session.get(BetaInvite, invite.id)
            assert stored.revoked_at is None
            assert stored.redeemed_by_coach_id == coach_id


class TestWhatTheOwnerCanSee:
    def test_the_payload_carries_no_token_at_all(self, app, coach_id):
        """Not the plaintext, and not the hash either - a hash in a payload is
        an offline guessing target for a 60-bit token."""
        with app.app_context():
            invite, _ = beta_invites.issue(label="Coach Smith")

            payload = invite.to_dict()

            assert "token" not in payload
            assert "token_hash" not in payload
            assert payload["token_prefix"]
            assert payload["label"] == "Coach Smith"

    def test_it_answers_the_questions_the_owner_actually_has(self, app, coach_id):
        """How many issued, how many redeemed, and which invite produced which
        coach - the whole reason this table exists."""
        with app.app_context():
            beta_invites.issue(label="A")
            used, _ = beta_invites.issue(label="B")
            beta_invites.redeem(used, coach_id)
            db.session.commit()

            all_invites = BetaInvite.query.all()
            redeemed = [i for i in all_invites if i.redeemed_at is not None]

            assert len(all_invites) == 2
            assert len(redeemed) == 1
            assert redeemed[0].redeemed_by_coach_id == coach_id


class TestNothingElseChanged:
    def test_public_registration_is_still_open(self, client):
        """DELIBERATE. This foundation changes no behaviour - closing public
        signup is a product decision, not a side effect of adding a table."""
        created = client.post(
            "/api/auth/register",
            json={
                "username": "newcoach",
                "email": "new@example.com",
                "password": "password123",
                "organization": "New Program",
            },
        )

        assert created.status_code == 201

    def test_the_organization_invite_type_is_untouched(self, app):
        """The other invite - coach joins an EXISTING org - is a separate
        model and must stay that way."""
        from app.models import OrganizationInvite

        assert OrganizationInvite.__tablename__ == "organization_invites"
        assert BetaInvite.__tablename__ == "beta_invites"
