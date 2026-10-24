"""Installs: what the coach is installing this week

Revision ID: a7d4e2c19b63
Revises: b6e2d8f41a07
Create Date: 2026-10-23

INSTALLS (app/models/install.py). A lightweight working set - "Week 7 - West
Virginia" - that REFERS to existing football: a Motion Lab play, a quiz or
Rep, a concept. It copies nothing: items are references, with one optional
level of sections and an order.

Additive and reversible: three new tables, nothing existing altered, no
backfill. Deleting football removes its items (CASCADE); deleting an install
or a section never touches football (a section's items fall back to no
section). Downgrading drops the three tables - installs are organization, so
no football or player work is lost.
"""
import sqlalchemy as sa
from alembic import op

revision = "a7d4e2c19b63"
down_revision = "b6e2d8f41a07"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "installs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("coach_id", sa.Integer(), sa.ForeignKey("coaches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("position_group", sa.String(length=40), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_installs_organization_id", "installs", ["organization_id"])
    op.create_index("ix_installs_coach_id", "installs", ["coach_id"])

    op.create_table(
        "install_sections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("install_id", sa.Integer(), sa.ForeignKey("installs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(length=80), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_install_sections_install_id", "install_sections", ["install_id"])

    op.create_table(
        "install_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("install_id", sa.Integer(), sa.ForeignKey("installs.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "section_id", sa.Integer(), sa.ForeignKey("install_sections.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column(
            "motion_play_id", sa.Integer(), sa.ForeignKey("motion_plays.id", ondelete="CASCADE"), nullable=True
        ),
        sa.Column("quiz_id", sa.Integer(), sa.ForeignKey("quizzes.id", ondelete="CASCADE"), nullable=True),
        sa.Column("concept_id", sa.Integer(), sa.ForeignKey("concepts.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.UniqueConstraint("install_id", "motion_play_id", name="uq_install_items_play"),
        sa.UniqueConstraint("install_id", "quiz_id", name="uq_install_items_quiz"),
        sa.UniqueConstraint("install_id", "concept_id", name="uq_install_items_concept"),
        sa.CheckConstraint(
            "(kind = 'play' AND motion_play_id IS NOT NULL AND quiz_id IS NULL AND concept_id IS NULL)"
            " OR (kind = 'quiz' AND quiz_id IS NOT NULL AND motion_play_id IS NULL AND concept_id IS NULL)"
            " OR (kind = 'concept' AND concept_id IS NOT NULL AND motion_play_id IS NULL AND quiz_id IS NULL)",
            name="ck_install_items_one_reference",
        ),
    )
    op.create_index("ix_install_items_install_id", "install_items", ["install_id"])
    op.create_index("ix_install_items_section_id", "install_items", ["section_id"])
    op.create_index("ix_install_items_motion_play_id", "install_items", ["motion_play_id"])
    op.create_index("ix_install_items_quiz_id", "install_items", ["quiz_id"])
    op.create_index("ix_install_items_concept_id", "install_items", ["concept_id"])


def downgrade():
    op.drop_table("install_items")
    op.drop_table("install_sections")
    op.drop_table("installs")
