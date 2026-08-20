"""Model package. Import order matters for relationship string resolution."""

from app.models.beta_invite import BetaInvite
from app.models.access_request import AccessRequest
from app.models.staff_invite_request import StaffInviteRequest
from app.models.organization import Organization, OrganizationInvite
from app.models.coach import Coach, CoachRole
from app.models.folder import Folder
from app.models.player import Player
from app.models.group import Group, GroupPlayer
from app.models.quiz import Quiz
from app.models.question import Question, QuestionOption, QuestionType
from app.models.question_region import QuestionRegion, RegionRole
from app.models.question_image import QuestionImage
from app.models.roster import Roster, RosterPlayer
from app.models.access_code import AccessCode
from app.models.answer_drawing import AnswerDrawing
from app.models.answer_selected_option import AnswerSelectedOption
from app.models.source_document import SourceDocument
from app.models.document_page import DocumentPage
from app.models.response import Answer, AttemptStatus, PlayerAttempt
from app.models.attempt_question_snapshot import AttemptQuestionSnapshot
from app.models.question_exclusion import QuestionExclusion
from app.models.grade_audit_log import GradeAuditLog
from app.models.organization_merge import OrganizationMerge
from app.models.competition import (
    CompetitionAnswer,
    CompetitionParticipant,
    CompetitionSession,
)

__all__ = [
    "BetaInvite",
    "AccessRequest",
    "StaffInviteRequest",
    "Organization",
    "OrganizationInvite",
    "Coach",
    "CoachRole",
    "Folder",
    "Player",
    "Group",
    "GroupPlayer",
    "Quiz",
    "Question",
    "QuestionOption",
    "QuestionType",
    "QuestionRegion",
    "RegionRole",
    "QuestionImage",
    "Roster",
    "RosterPlayer",
    "AccessCode",
    "PlayerAttempt",
    "AttemptStatus",
    "Answer",
    "AnswerDrawing",
    "AnswerSelectedOption",
    "AttemptQuestionSnapshot",
    "QuestionExclusion",
    "GradeAuditLog",
    "OrganizationMerge",
    "CompetitionSession",
    "CompetitionParticipant",
    "CompetitionAnswer",
    "SourceDocument",
    "DocumentPage",
]
