"""Peira Owner Dashboard: permission, privacy, and metric correctness.

THE THREE THINGS THIS FILE EXISTS TO PROVE
-------------------------------------------
1. Only a platform owner can reach /api/owner. Not a member, not an
   organization admin, not an anonymous caller - and a non-owner learns
   nothing about whether the area exists.

2. Owner responses carry NO customer content. A coach's email is account
   metadata and belongs here; a question, an answer, a quiz title or a
   playbook filename never does. The assertion is made against whole
   response bodies, so a field added carelessly to a payload fails the test
   even if nobody thought to check for it.

3. Platform ownership is ORTHOGONAL. Granting it must not widen Coach View,
   Admin View, or any organization boundary by even one row - which is the
   real risk of bolting a superuser flag onto an existing permission model.
"""

import json
import re

import pytest

from app.extensions import db
from app.models import Coach, CoachRole, Organization


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def register(client, *, username, email, organization):
    response = client.post(
        "/api/auth/register",
        json={
            "username": username,
            "email": email,
            "password": "Passw0rd!23",
            "organization": organization,
        },
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def headers(token):
    return {"Authorization": f"Bearer {token}"}


def make_owner(app, email):
    """Grant ownership the way the CLI does - by setting the flag."""
    with app.app_context():
        coach = Coach.query.filter_by(email=email).one()
        coach.is_platform_owner = True
        db.session.commit()
        return coach.id


@pytest.fixture
def owner(app, client):
    """A platform owner who is also an ordinary ADMIN of their own org."""
    data = register(
        client, username="peiraowner", email="owner@peira.test", organization="Peira HQ"
    )
    make_owner(app, "owner@peira.test")
    return data


@pytest.fixture
def customer(client):
    """A completely separate organization, whose data the owner must not see
    through any normal endpoint."""
    return register(
        client,
        username="cincycoach",
        email="coach@cincy.test",
        organization="Cincinnati Football",
    )


def build_content(client, token, *, title="Week 1 Install"):
    """A quiz with a question, so there is real content to leak if the owner
    payloads are careless."""
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers(token)).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "SECRET_QUESTION_TEXT",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
            "answer_explanation": "SECRET_EXPLANATION_TEXT",
        },
        headers=headers(token),
    )
    return quiz


# ---------------------------------------------------------------------------
# 1. Permission matrix
# ---------------------------------------------------------------------------

OWNER_ROUTES = [
    "/api/owner/overview",
    "/api/owner/organizations",
    "/api/owner/organizations/1",
    "/api/owner/coaches",
]


class TestPermissionMatrix:
    @pytest.mark.parametrize("route", OWNER_ROUTES)
    def test_anonymous_is_401(self, client, route):
        assert client.get(route).status_code == 401

    @pytest.mark.parametrize("route", OWNER_ROUTES)
    def test_an_ordinary_member_gets_404(self, client, customer, route):
        """404, not 403. A customer probing /api/owner must not be told that
        an owner area exists."""
        response = client.get(route, headers=headers(customer["access_token"]))
        assert response.status_code == 404

    @pytest.mark.parametrize("route", OWNER_ROUTES)
    def test_an_organization_admin_gets_404(self, app, client, customer, route):
        """The registering coach is an ADMIN of their own organization. Org
        admin is a different axis entirely and buys nothing here."""
        with app.app_context():
            coach = Coach.query.filter_by(email="coach@cincy.test").one()
            assert coach.role == CoachRole.ADMIN
            assert coach.is_platform_owner is False

        response = client.get(route, headers=headers(customer["access_token"]))
        assert response.status_code == 404

    def test_the_platform_owner_gets_in(self, client, owner):
        for route in ["/api/owner/overview", "/api/owner/organizations", "/api/owner/coaches"]:
            assert client.get(route, headers=headers(owner["access_token"])).status_code == 200

    def test_revoking_ownership_closes_the_door_again(self, app, client, owner):
        assert (
            client.get("/api/owner/overview", headers=headers(owner["access_token"])).status_code
            == 200
        )

        with app.app_context():
            coach = Coach.query.filter_by(email="owner@peira.test").one()
            coach.is_platform_owner = False
            db.session.commit()

        assert (
            client.get("/api/owner/overview", headers=headers(owner["access_token"])).status_code
            == 404
        )

    @pytest.mark.parametrize("route", OWNER_ROUTES)
    def test_the_cors_preflight_is_not_broken_by_the_gate(self, client, route):
        """REGRESSION. A browser sends OPTIONS with no Authorization header,
        so a preflight can never satisfy the owner check.

        This was a real 500 that no other test could catch: Flask's test
        client does not send preflights, and flask_jwt_extended exempts
        OPTIONS from verification - so the gate fell through to an identity
        lookup with no verified token. Every owner screen failed to load in a
        browser while the whole suite stayed green.
        """
        response = client.options(
            route,
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        assert response.status_code < 400, response.get_data(as_text=True)

    def test_the_preflight_exemption_does_not_leak_data(self, client, customer):
        """The exemption is for the handshake only - OPTIONS returns no body,
        so exempting it cannot disclose anything."""
        response = client.options(
            "/api/owner/overview", headers={"Origin": "http://localhost:5173"}
        )
        assert response.get_data(as_text=True).strip() in ("", "{}")

    def test_every_owner_route_is_gated_by_the_blueprint(self, app):
        """THE GUARD. Walks the url_map so a route added later cannot quietly
        skip the permission - the failure mode this test exists for is a new
        endpoint, not the four that exist today."""
        with app.app_context():
            owner_rules = [
                rule for rule in app.url_map.iter_rules() if rule.rule.startswith("/api/owner")
            ]
            assert owner_rules, "no owner routes found - has the blueprint moved?"
            for rule in owner_rules:
                assert rule.endpoint.startswith("owner."), (
                    f"{rule.rule} is under /api/owner but is not registered on owner_bp, "
                    "so the blueprint's before_request gate does not protect it"
                )

    #: The ONLY owner endpoints allowed to accept a mutating verb. Organization
    #: merge is a deliberate exception to the read-only rule: preview is a POST
    #: because it carries a body and writes nothing, execute is the one
    #: destructive owner operation. Pinned here so a THIRD mutating route
    #: cannot appear without someone changing this list on purpose.
    MUTATING_ALLOWLIST = {"/api/owner/merges/preview", "/api/owner/merges/execute"}

    def test_no_unexpected_mutating_owner_route_exists(self, app):
        with app.app_context():
            for rule in app.url_map.iter_rules():
                if not rule.rule.startswith("/api/owner"):
                    continue
                mutating = rule.methods & {"POST", "PUT", "PATCH", "DELETE"}
                if mutating and rule.rule not in self.MUTATING_ALLOWLIST:
                    raise AssertionError(f"{rule.rule} exposes {mutating} and is not allow-listed")

    def test_the_allowlisted_merge_routes_actually_exist(self, app):
        """Keeps the allow-list honest: if a merge route is renamed or
        removed, this fails rather than leaving a permanent blanket exemption
        for a path nothing serves."""
        with app.app_context():
            existing = {rule.rule for rule in app.url_map.iter_rules()}
            assert self.MUTATING_ALLOWLIST <= existing


# ---------------------------------------------------------------------------
# 2. Privacy
# ---------------------------------------------------------------------------

#: Substrings that must never appear in an owner response. Some are field
#: names, some are values planted by the fixtures - both matter, because a
#: field can leak by being serialized OR by being embedded in a nested dict.
FORBIDDEN_SUBSTRINGS = [
    "question_text",
    "answer_text",
    "answer_explanation",
    "coach_feedback",
    "password_hash",
    "SECRET_QUESTION_TEXT",
    "SECRET_EXPLANATION_TEXT",
    # Quiz titles are football content and are excluded from V1 entirely.
    "Week 1 Install",
    # Drawing documents and playbook filenames.
    "strokes",
    "original_filename",
    ".pdf",
    # Invitation secrets.
    "invite_code",
]


class TestNoCustomerContent:
    @pytest.fixture(autouse=True)
    def _content(self, client, customer):
        build_content(client, customer["access_token"])

    def _bodies(self, client, owner):
        bodies = {}
        for route in ["/api/owner/overview", "/api/owner/organizations", "/api/owner/coaches"]:
            response = client.get(route, headers=headers(owner["access_token"]))
            assert response.status_code == 200
            bodies[route] = response.get_data(as_text=True)

        orgs = json.loads(bodies["/api/owner/organizations"])["organizations"]
        for org in orgs:
            route = f"/api/owner/organizations/{org['id']}"
            response = client.get(route, headers=headers(owner["access_token"]))
            assert response.status_code == 200
            bodies[route] = response.get_data(as_text=True)
        return bodies

    @pytest.mark.parametrize("forbidden", FORBIDDEN_SUBSTRINGS)
    def test_no_owner_response_contains_customer_content(self, client, owner, forbidden):
        for route, body in self._bodies(client, owner).items():
            assert forbidden not in body, f"{route} leaked {forbidden!r}"

    def test_player_names_are_never_listed(self, client, customer, owner):
        """Counts of players, never a roster. The org detail is the page most
        likely to drift into listing people."""
        client.post(
            "/api/players",
            json={"first_name": "Jordan", "last_name": "Smith"},
            headers=headers(customer["access_token"]),
        )

        for route, body in self._bodies(client, owner).items():
            assert "Jordan" not in body, f"{route} leaked a player name"
            assert "Smith" not in body, f"{route} leaked a player name"

    def test_coach_identity_IS_present(self, client, owner):
        """The deliberate exception: supporting an account is impossible from
        an id alone. Asserted so nobody 'fixes' it as a leak later."""
        body = client.get("/api/owner/coaches", headers=headers(owner["access_token"])).get_json()
        emails = {row["email"] for row in body["coaches"]}
        assert "coach@cincy.test" in emails

    def test_no_response_carries_anything_that_looks_like_a_hash_or_token(
        self, client, owner
    ):
        for route, body in self._bodies(client, owner).items():
            # bcrypt hashes start $2b$; a stray one means a coach row was
            # serialized wholesale instead of column by column.
            assert "$2b$" not in body, f"{route} leaked a password hash"
            assert not re.search(r"\beyJ[A-Za-z0-9_-]{10,}", body), f"{route} leaked a JWT"


# ---------------------------------------------------------------------------
# 3. Ownership is orthogonal
# ---------------------------------------------------------------------------


class TestOwnershipDoesNotWidenAnything:
    def test_coach_view_still_shows_only_the_owners_own_quizzes(
        self, client, owner, customer
    ):
        """The single most important non-regression: a platform owner using
        the normal dashboard is an ordinary coach."""
        build_content(client, customer["access_token"], title="Cincy Only")
        mine = client.post(
            "/api/quizzes", json={"title": "My Own Quiz"}, headers=headers(owner["access_token"])
        ).get_json()

        listed = client.get("/api/quizzes", headers=headers(owner["access_token"])).get_json()
        rows = listed["quizzes"] if isinstance(listed, dict) else listed

        assert [q["id"] for q in rows] == [mine["id"]]
        assert "Cincy Only" not in json.dumps(rows)

    def test_admin_view_still_stops_at_the_owners_own_organization(
        self, client, owner, customer
    ):
        build_content(client, customer["access_token"], title="Cincy Only")

        listed = client.get(
            "/api/organizations/quizzes", headers=headers(owner["access_token"])
        ).get_json()

        assert "Cincy Only" not in json.dumps(listed)

    def test_a_single_quiz_in_another_organization_is_still_404(
        self, client, owner, customer
    ):
        theirs = build_content(client, customer["access_token"])

        response = client.get(
            f"/api/quizzes/{theirs['id']}", headers=headers(owner["access_token"])
        )
        assert response.status_code == 404

    def test_another_organizations_players_are_still_404(self, client, owner, customer):
        player = client.post(
            "/api/players",
            json={"first_name": "Jordan", "last_name": "Smith"},
            headers=headers(customer["access_token"]),
        ).get_json()

        assert (
            client.get(
                f"/api/players/{player['id']}", headers=headers(owner["access_token"])
            ).status_code
            == 404
        )

    def test_ownership_does_not_confer_organization_admin(self, app, client):
        """A platform owner who is only a MEMBER of their org stays a MEMBER."""
        data = register(
            client, username="memberowner", email="member@peira.test", organization="Peira Two"
        )
        with app.app_context():
            coach = Coach.query.filter_by(email="member@peira.test").one()
            coach.role = CoachRole.MEMBER
            coach.is_platform_owner = True
            db.session.commit()

        # Owner routes: in. Org-admin routes: still refused.
        assert (
            client.get("/api/owner/overview", headers=headers(data["access_token"])).status_code
            == 200
        )
        assert (
            client.get("/api/organizations/invites", headers=headers(data["access_token"])).status_code
            == 403
        )


# ---------------------------------------------------------------------------
# 4. Metric correctness
# ---------------------------------------------------------------------------


class TestMetrics:
    def test_totals_count_the_whole_platform(self, client, owner, customer):
        build_content(client, customer["access_token"])
        client.post(
            "/api/players",
            json={"first_name": "Jordan", "last_name": "Smith"},
            headers=headers(customer["access_token"]),
        )

        totals = client.get(
            "/api/owner/overview", headers=headers(owner["access_token"])
        ).get_json()["totals"]

        # Two organizations: the owner's and the customer's.
        assert totals["organizations"] == 2
        assert totals["coaches"] == 2
        assert totals["quizzes"] == 1
        assert totals["active_players"] == 1

    def test_new_in_window_counts_what_was_just_created(self, client, owner, customer):
        overview = client.get(
            "/api/owner/overview", headers=headers(owner["access_token"])
        ).get_json()

        assert overview["windows"]["7"]["new_organizations"] == 2
        assert overview["windows"]["30"]["new_coaches"] == 2

    def test_an_organization_row_rolls_up_its_own_usage_only(
        self, client, owner, customer
    ):
        build_content(client, customer["access_token"])

        rows = client.get(
            "/api/owner/organizations", headers=headers(owner["access_token"])
        ).get_json()["organizations"]
        cincy = next(r for r in rows if r["name"] == "Cincinnati Football")
        hq = next(r for r in rows if r["name"] == "Peira HQ")

        assert cincy["quizzes"] == 1
        assert cincy["coaches"] == 1
        # The owner's own organization must not absorb the customer's numbers.
        assert hq["quizzes"] == 0

    def test_empty_is_derived_from_data_not_from_the_name(self, client, owner, customer):
        """A probe organization is found by having nothing in it. A real one
        with content is not empty even if it were named 'ZZ Test'."""
        register(client, username="zzprobe", email="zz@probe.test", organization="ZZ Prod Probe")
        build_content(client, customer["access_token"])

        rows = client.get(
            "/api/owner/organizations?filter=empty", headers=headers(owner["access_token"])
        ).get_json()["organizations"]
        names = {r["name"] for r in rows}

        assert "ZZ Prod Probe" in names
        # Has a quiz, so not empty - despite being the only org doing anything.
        assert "Cincinnati Football" not in names

    def test_a_named_zz_organization_with_content_is_not_empty(self, client, owner):
        """The inverse, stated separately because it is the whole point of
        deriving emptiness from data."""
        zz = register(
            client, username="zzbusy", email="zzbusy@probe.test", organization="ZZ Other Org"
        )
        build_content(client, zz["access_token"])

        rows = client.get(
            "/api/owner/organizations?filter=empty", headers=headers(owner["access_token"])
        ).get_json()["organizations"]

        assert "ZZ Other Org" not in {r["name"] for r in rows}

    def test_search_filters_organizations_by_their_own_name(self, client, owner, customer):
        rows = client.get(
            "/api/owner/organizations?search=cincinnati", headers=headers(owner["access_token"])
        ).get_json()["organizations"]

        assert [r["name"] for r in rows] == ["Cincinnati Football"]

    def test_organization_detail_reports_usage_and_coaches(
        self, app, client, owner, customer
    ):
        build_content(client, customer["access_token"])
        with app.app_context():
            org_id = Organization.query.filter_by(name="Cincinnati Football").one().id

        detail = client.get(
            f"/api/owner/organizations/{org_id}", headers=headers(owner["access_token"])
        ).get_json()

        assert detail["name"] == "Cincinnati Football"
        assert detail["usage"]["quizzes"] == 1
        assert detail["usage"]["coaches"] == 1
        assert [c["email"] for c in detail["coaches"]] == ["coach@cincy.test"]
        # Counts of players, never a list of them.
        assert "players" not in detail or isinstance(detail["usage"]["players"], int)

    def test_a_missing_organization_is_404(self, client, owner):
        assert (
            client.get(
                "/api/owner/organizations/999999", headers=headers(owner["access_token"])
            ).status_code
            == 404
        )

    def test_quizzes_created_is_attributed_to_the_creator(self, client, owner, customer):
        build_content(client, customer["access_token"])
        build_content(client, customer["access_token"], title="Week 2 Install")

        rows = client.get(
            "/api/owner/coaches", headers=headers(owner["access_token"])
        ).get_json()["coaches"]
        cincy = next(r for r in rows if r["email"] == "coach@cincy.test")
        hq = next(r for r in rows if r["email"] == "owner@peira.test")

        assert cincy["quizzes_created"] == 2
        assert hq["quizzes_created"] == 0

    def test_last_attributed_activity_is_null_until_something_attributable_happens(
        self, client, owner
    ):
        """A brand-new coach has created nothing, uploaded nothing and graded
        nothing - so the honest answer is "unknown", rendered as an em dash,
        NOT a fabricated date."""
        rows = client.get(
            "/api/owner/coaches", headers=headers(owner["access_token"])
        ).get_json()["coaches"]
        hq = next(r for r in rows if r["email"] == "owner@peira.test")

        assert hq["last_attributed_activity"] is None

    def test_creating_a_quiz_sets_last_attributed_activity(self, client, owner, customer):
        build_content(client, customer["access_token"])

        rows = client.get(
            "/api/owner/coaches", headers=headers(owner["access_token"])
        ).get_json()["coaches"]
        cincy = next(r for r in rows if r["email"] == "coach@cincy.test")

        assert cincy["last_attributed_activity"] is not None

    def test_dismissing_onboarding_is_NOT_activity(self, client, owner):
        """coaches.updated_at moves when a coach dismisses the checklist or
        opens What's New. Reading help is not usage, and counting it would
        make every account look permanently active."""
        client.post("/api/onboarding/dismiss", headers=headers(owner["access_token"]))

        rows = client.get(
            "/api/owner/coaches", headers=headers(owner["access_token"])
        ).get_json()["coaches"]
        hq = next(r for r in rows if r["email"] == "owner@peira.test")

        assert hq["last_attributed_activity"] is None

    def test_coach_search_matches_name_email_or_organization(self, client, owner, customer):
        by_org = client.get(
            "/api/owner/coaches?search=cincinnati", headers=headers(owner["access_token"])
        ).get_json()["coaches"]
        by_email = client.get(
            "/api/owner/coaches?search=cincy.test", headers=headers(owner["access_token"])
        ).get_json()["coaches"]

        assert [c["email"] for c in by_org] == ["coach@cincy.test"]
        assert [c["email"] for c in by_email] == ["coach@cincy.test"]

    def test_feature_adoption_counts_organizations_that_have_ever_used_a_feature(
        self, client, owner, customer
    ):
        client.post(
            "/api/groups", json={"name": "Linebackers"}, headers=headers(customer["access_token"])
        )

        adoption = client.get(
            "/api/owner/overview", headers=headers(owner["access_token"])
        ).get_json()["feature_adoption"]
        by_key = {row["key"]: row for row in adoption}

        assert by_key["groups"]["organizations"] == 1
        assert by_key["groups"]["label"] == "Groups"
        # Nothing has used these yet.
        assert by_key["draw_response"]["organizations"] == 0
        assert by_key["nested_folders"]["organizations"] == 0

    def test_every_feature_key_is_reported_even_at_zero(self, client, owner):
        adoption = client.get(
            "/api/owner/overview", headers=headers(owner["access_token"])
        ).get_json()["feature_adoption"]

        assert {row["key"] for row in adoption} == {
            "practice_mode",
            "playbook_quiz",
            "draw_response",
            "groups",
            "nested_folders",
        }


# ---------------------------------------------------------------------------
# 5. The CLI
# ---------------------------------------------------------------------------


class TestOwnerCli:
    def test_grant_and_revoke_round_trip(self, app, client, customer):
        runner = app.test_cli_runner()

        result = runner.invoke(args=["owner", "grant", "coach@cincy.test"])
        assert result.exit_code == 0, result.output
        assert "Granted platform ownership" in result.output
        with app.app_context():
            assert Coach.query.filter_by(email="coach@cincy.test").one().is_platform_owner

        result = runner.invoke(args=["owner", "revoke", "coach@cincy.test"])
        assert result.exit_code == 0, result.output
        with app.app_context():
            assert not Coach.query.filter_by(email="coach@cincy.test").one().is_platform_owner

    def test_grant_is_case_insensitive_on_email(self, app, client, customer):
        result = app.test_cli_runner().invoke(args=["owner", "grant", "COACH@CINCY.TEST"])
        assert result.exit_code == 0, result.output
        with app.app_context():
            assert Coach.query.filter_by(email="coach@cincy.test").one().is_platform_owner

    def test_an_unknown_email_fails_loudly(self, app, client):
        """Silence would look identical to success on a terminal, and this is
        the one command where that ambiguity is dangerous."""
        result = app.test_cli_runner().invoke(args=["owner", "grant", "nobody@nowhere.test"])

        assert result.exit_code != 0
        assert "No coach account" in result.output

    def test_list_reports_who_can_reach_the_dashboard(self, app, client, owner):
        result = app.test_cli_runner().invoke(args=["owner", "list"])

        assert result.exit_code == 0
        assert "owner@peira.test" in result.output

    def test_the_migration_grants_nobody(self, app, client, customer):
        """Registering does not make anyone an owner, and neither does the
        migration - ownership is only ever conferred deliberately."""
        with app.app_context():
            assert Coach.query.filter_by(is_platform_owner=True).count() == 0
