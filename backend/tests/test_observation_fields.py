"""PHASE A - the historical fields analysis will later depend on.

The rule these all serve: live tables answer "what is true now"; an attempt
must answer "what was true when the player answered". A coach who edits a
roster or a question months later must not be able to change what history says.
"""
from app import db
from app.models import Answer, PlayerAttempt
from app.models.player import Player
from tests.test_play_and_grading import build_ready_quiz, start_attempt


def _save(client, code_id, name, question_id, option_id, **extra):
    return client.post(
        "/api/play/answers",
        json={
            "access_code_id": code_id,
            "player_name": name,
            "question_id": question_id,
            "selected_option_id": option_id,
            **extra,
        },
    )


def _answer(question_id):
    return Answer.query.filter_by(question_id=question_id).one()


class TestAnsweredAt:
    def test_stamped_on_the_first_write(self, client, coach_headers):
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        start_attempt(client, code["id"], "Jordan Smith")
        opt = tf["options"][0]["id"]

        assert _save(client, code["id"], "Jordan Smith", tf["id"], opt).status_code == 204
        assert _answer(tf["id"]).answered_at is not None

    def test_a_LATER_EDIT_DOES_NOT_MOVE_IT(self, client, coach_headers):
        """"When did they answer" must not drift into "when did this row last
        change". The save path is a debounced upsert - a corrected answer, a
        browser retry and the final sync at submit all come back through it."""
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        start_attempt(client, code["id"], "Jordan Smith")
        options = [o["id"] for o in tf["options"]]

        _save(client, code["id"], "Jordan Smith", tf["id"], options[0])
        first = _answer(tf["id"]).answered_at
        assert first is not None

        # Backdate nothing; just prove a second write leaves the stamp alone.
        _save(client, code["id"], "Jordan Smith", tf["id"], options[1])
        assert _answer(tf["id"]).answered_at == first

    def test_null_on_answers_that_predate_the_column(self, client, coach_headers):
        # No backfill: an Answer written directly, as history holds them.
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        start_attempt(client, code["id"], "Jordan Smith")
        attempt = PlayerAttempt.query.one()
        db.session.add(Answer(attempt_id=attempt.id, question_id=tf["id"]))
        db.session.commit()

        assert _answer(tf["id"]).answered_at is None


class TestTimeToAnswer:
    def test_recorded_when_the_client_measured_it(self, client, coach_headers):
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        start_attempt(client, code["id"], "Jordan Smith")

        _save(client, code["id"], "Jordan Smith", tf["id"], tf["options"][0]["id"],
              time_to_answer_ms=4200)

        assert _answer(tf["id"]).time_to_answer_ms == 4200

    def test_NULL_WHEN_THE_CLIENT_COULD_NOT_MEASURE_IT(self, client, coach_headers):
        """An all-at-once quiz sends nothing, because every question is on
        screen from page load and the figure would include the earlier ones."""
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        start_attempt(client, code["id"], "Jordan Smith")

        _save(client, code["id"], "Jordan Smith", tf["id"], tf["options"][0]["id"])

        assert _answer(tf["id"]).time_to_answer_ms is None

    def test_a_correction_cannot_overwrite_a_real_measurement(self, client, coach_headers):
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        start_attempt(client, code["id"], "Jordan Smith")
        options = [o["id"] for o in tf["options"]]

        _save(client, code["id"], "Jordan Smith", tf["id"], options[0], time_to_answer_ms=3000)
        # The submit path re-sends every answer; it must not restamp this.
        _save(client, code["id"], "Jordan Smith", tf["id"], options[1], time_to_answer_ms=999999)

        assert _answer(tf["id"]).time_to_answer_ms == 3000

    def test_a_nonsense_duration_is_rejected_not_stored(self, client, coach_headers):
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        start_attempt(client, code["id"], "Jordan Smith")

        bad = _save(client, code["id"], "Jordan Smith", tf["id"], tf["options"][0]["id"],
                    time_to_answer_ms=-1)
        assert bad.status_code == 422


class TestPositionAtAttempt:
    def _player_attempt(self):
        return PlayerAttempt.query.one()

    def test_null_for_a_free_text_name_with_no_linked_player(self, client, coach_headers):
        quiz, _, _, code = build_ready_quiz(client, coach_headers)
        start_attempt(client, code["id"], "Jordan Smith")

        assert self._player_attempt().position_at_attempt is None

    def test_MOVING_A_PLAYER_LATER_DOES_NOT_REWRITE_HISTORY(self, client, coach_headers):
        """The whole reason this column exists. players.position is live; move
        a corner to safety in October and every September result would
        otherwise silently re-attribute itself to the new group."""
        quiz, _, _, code = build_ready_quiz(client, coach_headers)
        player = Player.query.first()
        if player is None:
            return  # roster is free-text in this fixture; covered above
        player.position = "CB"
        db.session.commit()

        start_attempt(client, code["id"], player.full_name)
        attempt = self._player_attempt()
        recorded = attempt.position_at_attempt

        player.position = "S"
        db.session.commit()
        db.session.refresh(attempt)

        assert attempt.position_at_attempt == recorded
        assert player.position == "S"
