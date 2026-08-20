"""A REVIEW HINT ABOUT DUPLICATE PROGRAMS, AND NOTHING MORE.

WHY THIS EXISTS
---------------
`AccessRequest` is the last path where somebody still TYPES a program name -
they have no account yet, so there is nothing to copy it from. That is where
"UC", "Cincinnati", "University of Cincinnati" and "Cincinnati Football"
become four isolated programs with one coach each.

Staff invites already removed the typing for everyone joining an existing
program. This answers the remaining question at review time: has somebody like
this already signed up?

THE THING THIS MUST NEVER DO
-----------------------------
`TestItNeverActs` is the class that matters. Nothing here merges, links, blocks
or pre-fills. Combining two organizations because their names look alike would
hand a stranger somebody else's film, roster and results - the exact failure
the organization model exists to prevent. A human reads the list and decides.
"""

import pytest

from app.extensions import db
from app.models import AccessRequest, Coach, Organization
from app.services import similar_organizations


@pytest.fixture
def cincinnati(app):
    with app.app_context():
        org = Organization(name="Cincinnati Football")
        db.session.add(org)
        db.session.flush()
        coach = Coach(username="uccoach", email="uc@example.com", organization_id=org.id)
        coach.set_password("password123")
        db.session.add(coach)
        db.session.commit()
        return org.id


class TestSpottingTheDuplicate:
    @pytest.mark.parametrize(
        "typed",
        [
            "University of Cincinnati",
            "Cincinnati",
            "CINCINNATI HIGH SCHOOL",
            "Cincinnati Football",
            "  cincinnati  ",
        ],
    )
    def test_the_real_shapes_of_the_same_program_are_found(self, app, cincinnati, typed):
        """THE CASE THIS WAS BUILT FOR. Each of these is what a coach might
        type for a program already recorded as "Cincinnati Football"."""
        with app.app_context():
            matches = similar_organizations.candidates_for(typed)

        assert [m["organization_id"] for m in matches] == [cincinnati]

    def test_it_reports_what_a_human_needs_to_decide(self, app, cincinnati):
        with app.app_context():
            match = similar_organizations.candidates_for("University of Cincinnati")[0]

        assert match["name"] == "Cincinnati Football"
        assert match["organization_id"] == cincinnati
        # How many coaches are already there - an empty program and one with
        # six coaches in it are different decisions.
        assert match["coach_count"] == 1

    def test_an_unrelated_program_is_not_offered(self, app, cincinnati):
        with app.app_context():
            assert similar_organizations.candidates_for("Elder High School") == []

    def test_FILLER_WORDS_ALONE_ARE_NOT_A_MATCH(self, app, cincinnati):
        """Every program is "<somewhere> Football". Matching on that would
        offer every organization for every request and make the hint useless -
        which is worse than no hint, because it would be ignored."""
        with app.app_context():
            assert similar_organizations.candidates_for("Elder Football") == []
            assert similar_organizations.candidates_for("Football") == []

    def test_an_abbreviation_inside_a_longer_name_is_found(self, app):
        with app.app_context():
            db.session.add(Organization(name="UC Bearcats"))
            db.session.commit()

            matches = similar_organizations.candidates_for("UC")

        assert [m["name"] for m in matches] == ["UC Bearcats"]

    def test_a_request_that_named_no_team_gets_no_guesses(self, app, cincinnati):
        """Guessing from an email domain would be a different feature with a
        different failure mode. This one is allowed to say nothing."""
        with app.app_context():
            assert similar_organizations.candidates_for(None) == []
            assert similar_organizations.candidates_for("") == []
            assert similar_organizations.candidates_for("   ") == []

    def test_it_stops_at_a_readable_number(self, app):
        with app.app_context():
            for i in range(9):
                db.session.add(Organization(name=f"Cincinnati {i}"))
            db.session.commit()

            assert len(similar_organizations.candidates_for("Cincinnati")) == 5


class TestItNeverActs:
    def test_NOTHING_IS_MERGED_LINKED_OR_CHANGED(self, app, cincinnati):
        """THE PROPERTY THE WHOLE DESIGN RESTS ON. Similarity is a hint for a
        human; acting on it would hand somebody another program's data."""
        with app.app_context():
            before = {(o.id, o.name) for o in Organization.query.all()}
            coaches_before = Coach.query.count()

            similar_organizations.candidates_for("University of Cincinnati")

            assert {(o.id, o.name) for o in Organization.query.all()} == before
            assert Coach.query.count() == coaches_before

    def test_it_creates_no_organization_for_the_typed_name(self, app, cincinnati):
        with app.app_context():
            similar_organizations.candidates_for("University of Cincinnati")

            assert Organization.query.filter_by(name="University of Cincinnati").first() is None

    def test_it_reuses_the_merge_tools_normalisation(self):
        """One idea of "the same name", not two. If the merge tool's
        normalisation changes, this changes with it rather than drifting into
        a second opinion."""
        from app.services import organization_merge

        assert similar_organizations._normalize is organization_merge._normalize


class TestTheReviewCommand:
    def runner(self, app):
        return app.test_cli_runner()

    def test_it_shows_a_request_beside_the_program_it_might_be(self, app, cincinnati):
        with app.app_context():
            db.session.add(
                AccessRequest(
                    name="Coach Jordan",
                    email="jordan@example.com",
                    team="University of Cincinnati",
                )
            )
            db.session.commit()

        result = self.runner(app).invoke(args=["access-request", "list"])

        assert result.exit_code == 0, result.output
        assert "Coach Jordan" in result.output
        assert "University of Cincinnati" in result.output
        assert "Cincinnati Football" in result.output
        # It must READ as a hint, or somebody will treat it as a decision.
        assert "nothing has been merged or linked" in result.output

    def test_it_says_plainly_when_nothing_looks_similar(self, app, cincinnati):
        with app.app_context():
            db.session.add(
                AccessRequest(name="Coach Pat", email="pat@example.com", team="Elder")
            )
            db.session.commit()

        result = self.runner(app).invoke(args=["access-request", "list"])

        assert result.exit_code == 0
        assert "POSSIBLE EXISTING: none found" in result.output

    def test_it_handles_a_request_with_no_team(self, app, cincinnati):
        with app.app_context():
            db.session.add(
                AccessRequest(name="Coach Sam", email="sam@example.com", team=None)
            )
            db.session.commit()

        result = self.runner(app).invoke(args=["access-request", "list"])

        assert result.exit_code == 0
        assert "(not given)" in result.output

    def test_it_says_so_when_nobody_has_asked(self, app):
        result = self.runner(app).invoke(args=["access-request", "list"])

        assert result.exit_code == 0
        assert "No access requests yet." in result.output
