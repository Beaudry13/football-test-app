"""Competition Mode: a live, coach-run event with its own session state.

DELIBERATELY NOT AN AccessCode MODE
------------------------------------
A graded or practice assignment is a standing invitation - it has no present
tense. A competition does: a lobby, a current round, a deadline ticking, a
leaderboard. That state has nowhere to live on AccessCode or PlayerAttempt.

Keeping it in its own tables also makes analytics isolation STRUCTURAL rather
than filtered. Competition never writes to player_attempts or answers, so
official Results, cumulative reports, Player Profile, the grading queue and
quiz averages cannot include it - the rows simply are not there. attempt_scope
exists because a forgotten filter is invisible; here there is nothing to
forget.
"""

import secrets
from datetime import datetime, timedelta, timezone

from app.extensions import db
from app.models.mixins import utcnow

# --- The state machine -----------------------------------------------------
#
# Strings, and a CHECK constraint rather than a native Postgres enum. A live
# state machine is exactly the kind of thing that gains a state later, and a
# native enum makes that a one-way door (see CLAUDE.md).

LOBBY = "LOBBY"
QUESTION_OPEN = "QUESTION_OPEN"
QUESTION_REVEAL = "QUESTION_REVEAL"
LEADERBOARD = "LEADERBOARD"
#: The coach-paced ending. A real server state rather than a client animation
#: because every phone must agree on which place has been revealed - a
#: client-side sequence would desync the room mid-suspense.
PODIUM = "PODIUM"
COMPLETE = "COMPLETE"
ABANDONED = "ABANDONED"

COMPETITION_STATUSES = (
    LOBBY,
    QUESTION_OPEN,
    QUESTION_REVEAL,
    LEADERBOARD,
    PODIUM,
    COMPLETE,
    ABANDONED,
)

#: Podium reveal steps. Coach-advanced, one at a time, so the room experiences
#: third/second/first together rather than seeing all three at once.
PODIUM_COMPLETE_CARD = 0
PODIUM_THIRD = 1
PODIUM_SECOND = 2
PODIUM_FIRST = 3
PODIUM_STANDINGS = 4
PODIUM_LAST_STEP = PODIUM_STANDINGS

#: Statuses in which the session is finished and accepts no further action.
TERMINAL_STATUSES = (COMPLETE, ABANDONED)

#: Players may only join during the lobby. Joining mid-competition would mean
#: a participant with no score for rounds already played, ranked against
#: people who played them - which is worse than being told to wait.
JOINABLE_STATUSES = (LOBBY,)

#: How long an unstarted session stays usable. A coach who opens a lobby and
#: walks away should not leave a live join code behind indefinitely.
LOBBY_LIFETIME = timedelta(hours=6)

#: Allowed per-question durations, in seconds. One session-level setting for
#: V1 - per-question timing is deliberately not built.
QUESTION_TIME_CHOICES = (10, 20, 30, 45, 60)
DEFAULT_QUESTION_TIME = 20


class CompetitionSession(db.Model):
    """One live competition. The server owns every piece of its state."""

    __tablename__ = "competition_sessions"

    id = db.Column(db.Integer, primary_key=True)
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    # SET NULL: a coach leaving the organization must not delete the record of
    # a competition their team played.
    coach_id = db.Column(db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True)
    quiz_id = db.Column(
        db.Integer, db.ForeignKey("quizzes.id", ondelete="CASCADE"), nullable=False
    )

    join_code = db.Column(db.String(16), nullable=False, unique=True, index=True)
    status = db.Column(db.String(24), nullable=False, default=LOBBY, server_default=LOBBY)

    #: THE POLLING PRIMITIVE. Bumped on every state change, and the only thing
    #: the one-second poll compares. Clients refetch the heavy payload - roster,
    #: question, leaderboard - only when this moves, which is what keeps a
    #: thirty-phone room from hammering the database with joins every second.
    version = db.Column(db.Integer, nullable=False, default=1, server_default="1")

    current_round = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    question_time_seconds = db.Column(
        db.Integer, nullable=False, default=DEFAULT_QUESTION_TIME, server_default="20"
    )
    #: Server-authoritative timing. A player's countdown is rendered FROM
    #: question_closes_at; it never decides anything.
    question_opened_at = db.Column(db.DateTime(timezone=True), nullable=True)
    question_closes_at = db.Column(db.DateTime(timezone=True), nullable=True)

    #: THE QUESTIONS THIS COMPETITION PLAYS, IN ORDER, frozen when the first
    #: question starts. Rounds index into THIS, never into quiz.questions - a
    #: coach editing the quiz mid-competition would otherwise shift every later
    #: round and score answers against questions nobody saw. Same reasoning as
    #: PlayerAttempt.question_order in Practice Mode.
    question_order = db.Column(db.JSON, nullable=False, default=list, server_default="[]")

    #: Which scoring formula produced this competition's points. Recorded so a
    #: future model cannot silently rewrite what an old result meant.
    scoring_version = db.Column(
        db.SmallInteger, nullable=False, default=1, server_default="1"
    )

    #: The last round whose standings the ROOM WAS ACTUALLY SHOWN.
    #:
    #: NULL until a leaderboard is displayed. This is the baseline movement
    #: arrows are measured against - not the previous round, because a coach
    #: who skips two leaderboards must still see arrows comparing against the
    #: last table the room saw. See services/competition_standings.
    last_leaderboard_round = db.Column(db.SmallInteger, nullable=True)

    #: How far through the podium reveal the coach has advanced.
    podium_step = db.Column(
        db.SmallInteger, nullable=False, default=0, server_default="0"
    )

    #: Eligibility scope and future options. JSON because the shape is young;
    #: a column per setting would be a migration per idea.
    settings = db.Column(db.JSON, nullable=False, default=dict)

    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    started_at = db.Column(db.DateTime(timezone=True), nullable=True)
    ended_at = db.Column(db.DateTime(timezone=True), nullable=True)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)

    quiz = db.relationship("Quiz")
    coach = db.relationship("Coach")
    participants = db.relationship(
        "CompetitionParticipant",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="CompetitionParticipant.joined_at",
    )

    # -- lifecycle ---------------------------------------------------------

    @staticmethod
    def default_expiry() -> datetime:
        return datetime.now(timezone.utc) + LOBBY_LIFETIME

    @property
    def is_expired(self) -> bool:
        expires = self.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) >= expires

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def accepts_joins(self) -> bool:
        return self.status in JOINABLE_STATUSES and not self.is_expired

    # -- the answering window ---------------------------------------------

    @property
    def answering_open(self) -> bool:
        """Whether an answer submitted RIGHT NOW would be in time.

        DERIVED, NOT A STATE. Answering closes because the clock ran out, not
        because anything transitioned - which is exactly what lets the coach
        keep control of the reveal without a background worker moving the room
        on before they are ready. The session sits in QUESTION_OPEN with the
        window shut, and the coach reveals when the teaching moment is right.

        Both conditions matter: a reveal closes answering immediately even if
        seconds remain (the coach moved on early because everyone was already
        in), and the clock closes it even though the status has not changed.
        """
        if self.status != QUESTION_OPEN:
            return False
        if self.question_opened_at is None or self.question_closes_at is None:
            return False
        opens = self.question_opened_at
        closes = self.question_closes_at
        if opens.tzinfo is None:
            opens = opens.replace(tzinfo=timezone.utc)
        if closes.tzinfo is None:
            closes = closes.replace(tzinfo=timezone.utc)
        # BOTH ends. Checking only the close time would leave the window open
        # during the 3-2-1 lead-in, when `question_opened_at` is still in the
        # future and the question is not yet on anyone's screen - a player
        # could have answered a question they had not been shown.
        return opens <= datetime.now(timezone.utc) < closes

    @property
    def all_in(self) -> bool:
        """Every seat in the room has answered this round.

        Informational only - it does NOT close the window and does NOT reveal
        anything. It exists so the host can stop watching a clock that no
        longer has anyone left to wait for, and move into the reveal when the
        coach chooses. Server authority and coach control both survive
        because this changes no state on its own.
        """
        if self.status != QUESTION_OPEN:
            return False
        total = self.participant_count or 0
        return total > 0 and (self.answered_count or 0) >= total

    @property
    def total_rounds(self) -> int:
        return len(self.question_order or [])

    def question_id_for_round(self, round_index: int) -> int | None:
        """The question a round plays, or None if the round is out of range.

        Reads the frozen order rather than the quiz, so this answer cannot
        change while the competition is running.
        """
        order = self.question_order or []
        if 0 <= round_index < len(order):
            return order[round_index]
        return None

    def bump(self) -> None:
        """Record that something changed.

        Every transition calls this. A caller that mutates state without it
        leaves every polling client on a stale view until something else
        happens to move the number - which is why transitions go through the
        service rather than being written by hand at each route.
        """
        self.version = (self.version or 0) + 1

    # -- serialisation -----------------------------------------------------

    def poll_state(self, now: datetime) -> dict:
        """The ONE-SECOND payload. Deliberately tiny.

        A COUNT AND NOTHING ELSE ABOUT PEOPLE. `participant_count` is here so a
        player's waiting room can show "12 in the room" without fetching the
        whole lobby every time the version moves. It is a scalar: no names, no
        player ids, no participant ids, no tokens, no roster. Adding any of
        those would turn the cheap poll into the expensive one and would
        publish identities to anyone holding the code.

        Still ONE query. `participant_count` is a column_property (see the
        bottom of this module), so the count is a correlated subquery inside
        the same SELECT that loads the session - not a second round trip, and
        not a lazy load of the participant collection.
        """
        return {
            "version": self.version,
            "status": self.status,
            "server_now": now.isoformat(),
            "current_round": self.current_round,
            "question_opened_at": (
                self.question_opened_at.isoformat() if self.question_opened_at else None
            ),
            "question_closes_at": (
                self.question_closes_at.isoformat() if self.question_closes_at else None
            ),
            "participant_count": self.participant_count,
            # Counters ride the poll; VERSION marks structural change. These
            # two move constantly during a round, and bumping the version for
            # each would make every phone in the room refetch heavy state on
            # every submission - the stampede the M1 load harness caught.
            "answered_count": self.answered_count,
            "all_in": self.all_in,
            "answering_open": self.answering_open,
            "total_rounds": self.total_rounds,
            "podium_step": self.podium_step,
        }

    def to_dict(self, *, include_participants: bool = False) -> dict:
        data = {
            "id": self.id,
            "quiz_id": self.quiz_id,
            "quiz_title": self.quiz.title if self.quiz else None,
            "join_code": self.join_code,
            "status": self.status,
            "version": self.version,
            "current_round": self.current_round,
            "total_rounds": self.total_rounds,
            "podium_step": self.podium_step,
            "scoring_version": self.scoring_version,
            "question_time_seconds": self.question_time_seconds,
            # The column_property, NOT len(self.participants): counting via
            # the relationship would load every participant row just to
            # discard them.
            "participant_count": self.participant_count,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "expires_at": self.expires_at.isoformat(),
        }
        if include_participants:
            data["participants"] = [p.to_dict() for p in self.participants]
        return data


class CompetitionParticipant(db.Model):
    """One player's seat in one competition.

    Identified by canonical `player_id` throughout. There is no nickname field
    and no name matching: a joke name would waste the coach's results, and a
    fuzzy match would attribute one player's score to another.
    """

    __tablename__ = "competition_participants"
    __table_args__ = (
        # One seat per person, enforced by the DATABASE. A refresh, a
        # double-tap or a second phone cannot mint a second identity whatever
        # the client believes.
        db.UniqueConstraint("session_id", "player_id", name="uq_competition_participant"),
    )

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(
        db.Integer,
        db.ForeignKey("competition_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    player_id = db.Column(
        db.Integer, db.ForeignKey("players.id", ondelete="CASCADE"), nullable=False
    )
    #: Snapshotted at join, so the lobby still reads correctly if the player is
    #: renamed or deactivated while the session is live.
    display_name = db.Column(db.String(255), nullable=False)

    #: THE PLAYER'S ONLY CREDENTIAL.
    #:
    #: Picking your name from the roster happens in the open - the join code is
    #: public and so is the roster it renders. What must NOT be public is
    #: proving you are that player afterwards. `player_id` cannot do that job:
    #: it is a sequential key AND it is published in the identity picker, so
    #: anyone holding the code would know everyone's. Neither can `id`, for the
    #: same reason.
    #:
    #: So the seat gets a secret instead: 32 random bytes, minted once at join,
    #: never derived from anything, returned in exactly one response, and never
    #: included in any list payload. `to_dict()` below deliberately omits it -
    #: that omission is a security boundary, not a formatting choice, and there
    #: is a test asserting it.
    reconnect_token = db.Column(db.String(64), nullable=False, unique=True, index=True)

    joined_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    total_points = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    current_streak = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    best_streak = db.Column(db.Integer, nullable=False, default=0, server_default="0")

    session = db.relationship("CompetitionSession", back_populates="participants")
    player = db.relationship("Player")

    @staticmethod
    def new_token() -> str:
        """256 bits from the OS CSPRNG. Not seeded from player_id, not a hash
        of anything guessable, not sequential."""
        return secrets.token_urlsafe(32)

    def to_dict(self) -> dict:
        """NEVER includes reconnect_token. This is what the host view and the
        lobby list render from, so a token leaked here would be published to
        every other participant in the room."""
        return {
            "id": self.id,
            "player_id": self.player_id,
            "display_name": self.display_name,
            "joined_at": self.joined_at.isoformat(),
            "total_points": self.total_points,
            "current_streak": self.current_streak,
            "best_streak": self.best_streak,
        }


class CompetitionAnswer(db.Model):
    """One player's answer to one round.

    NOT an `answers` row. Competition answers carry response latency and
    points, are never hand-graded, and must never reach an official report -
    keeping them in their own table is what makes that structural rather than
    a filter somebody has to remember.
    """

    __tablename__ = "competition_answers"
    __table_args__ = (
        db.UniqueConstraint(
            "session_id", "participant_id", "round_index", name="uq_competition_answer_per_round"
        ),
    )

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(
        db.Integer,
        db.ForeignKey("competition_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    participant_id = db.Column(
        db.Integer,
        db.ForeignKey("competition_participants.id", ondelete="CASCADE"),
        nullable=False,
    )
    question_id = db.Column(
        db.Integer, db.ForeignKey("questions.id", ondelete="CASCADE"), nullable=False
    )
    round_index = db.Column(db.Integer, nullable=False)

    selected_option_id = db.Column(db.Integer, nullable=True)
    answer_text = db.Column(db.Text, nullable=True)
    is_correct = db.Column(db.Boolean, nullable=False)

    responded_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    #: The audit trail for a score. Stored rather than recomputed so a
    #: disputed result can be explained from what actually happened.
    response_ms = db.Column(db.Integer, nullable=False)
    points_awarded = db.Column(db.Integer, nullable=False)

    participant = db.relationship("CompetitionParticipant")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "participant_id": self.participant_id,
            "question_id": self.question_id,
            "round_index": self.round_index,
            "is_correct": self.is_correct,
            "response_ms": self.response_ms,
            "points_awarded": self.points_awarded,
        }


# ---------------------------------------------------------------------------
# participant_count
# ---------------------------------------------------------------------------
#
# Declared here rather than inside the class because it references
# CompetitionParticipant, which is defined below CompetitionSession.
#
# WHY A column_property AND NOT A STORED COUNTER
# ----------------------------------------------
# A denormalised counter column has to be incremented on join, decremented on
# removal, and repaired whenever those disagree - and a count that drifts is
# worse than one that costs a subquery, because nothing ever tells you it is
# wrong. This is derived from the rows themselves, so it cannot drift.
#
# WHY IT DOES NOT COST A SECOND QUERY
# ------------------------------------
# SQLAlchemy inlines a column_property into the SELECT that loads the parent,
# so the 1 Hz poll remains exactly one statement - the invariant the load test
# depends on and that test_the_poll_issues_one_query asserts.
#
# THE PLAN, MEASURED RATHER THAN ASSUMED
# ---------------------------------------
#   Aggregate  (actual time=0.043..0.044 rows=1)
#     -> Index Only Scan using ix_competition_participants_session_id
#          Index Cond: (session_id = 1)
#   Execution Time: 0.069 ms
#
# Index Only Scan on the index the participants FK already has. No new index
# is needed, and none was added.
CompetitionSession.participant_count = db.column_property(
    db.select(db.func.count(CompetitionParticipant.id))
    .where(CompetitionParticipant.session_id == CompetitionSession.id)
    .correlate_except(CompetitionParticipant)
    .scalar_subquery(),
    # deferred=False is the default and is what we want: the poll must get the
    # count in its single SELECT, not in a follow-up.
)


# ---------------------------------------------------------------------------
# answered_count
# ---------------------------------------------------------------------------
#
# The same inlined-subquery trick as participant_count, scoped to whichever
# round the session is currently on. Declared here because it references both
# CompetitionSession and CompetitionAnswer.
#
# WHY IT IS NOT A STORED COUNTER
# -------------------------------
# It would have to be incremented on every submission and reset on every round
# change, and a counter that disagrees with the answer rows is a scoreboard
# nobody can explain. Derived from the rows, it cannot drift.
#
# WHY IT IS SAFE ON THE 1 Hz PATH
# --------------------------------
# It is inlined into the session SELECT, so the poll stays ONE statement even
# though it now reports two counts. `current_round` is a column on the same
# row, so the correlation needs no join.
CompetitionSession.answered_count = db.column_property(
    db.select(db.func.count(CompetitionAnswer.id))
    .where(
        CompetitionAnswer.session_id == CompetitionSession.id,
        CompetitionAnswer.round_index == CompetitionSession.current_round,
    )
    .correlate_except(CompetitionAnswer)
    .scalar_subquery()
)
