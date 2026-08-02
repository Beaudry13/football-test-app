"""Add organizations (multi-tenancy)

Every existing coach becomes the ADMIN of their own new single-member
organization, named after the free-text `coaches.organization` string they
registered with. Coaches are deliberately NOT merged by matching that
string: two unrelated programs that both typed "Wildcats" would otherwise
be fused into one tenant and immediately see each other's data.

NOTE: the backfill in upgrade() is not truly reversible. downgrade()
restores the `organization` text column and drops the new tables, which
returns the schema to its previous shape and loses no information (each
coach owned all their own data before and after), but any org structure
created *after* this migration - multi-coach teams - cannot be represented
once the tenancy layer is gone.

Revision ID: d58221544f26
Revises: 4233792f38ab
Create Date: 2026-08-01 00:20:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd58221544f26'
down_revision = '4233792f38ab'
branch_labels = None
depends_on = None


coach_role_enum = sa.Enum('ADMIN', 'MEMBER', name='coachrole')


def upgrade():
    bind = op.get_bind()

    # --- 1. New tables -----------------------------------------------------
    op.create_table(
        'organizations',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'organization_invites',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('organization_id', sa.Integer(), nullable=False),
        sa.Column('code', sa.String(length=64), nullable=False),
        sa.Column('created_by_coach_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('accepted_by_coach_id', sa.Integer(), nullable=True),
        sa.Column('is_revoked', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id']),
        # SET NULL so removing a coach never trips over invite history.
        sa.ForeignKeyConstraint(['created_by_coach_id'], ['coaches.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['accepted_by_coach_id'], ['coaches.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('organization_invites', schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f('ix_organization_invites_organization_id'), ['organization_id'], unique=False
        )
        batch_op.create_index(
            batch_op.f('ix_organization_invites_code'), ['code'], unique=True
        )

    # --- 2. Nullable columns first, so existing rows stay valid ------------
    coach_role_enum.create(bind, checkfirst=True)

    with op.batch_alter_table('coaches', schema=None) as batch_op:
        batch_op.add_column(sa.Column('organization_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('role', coach_role_enum, nullable=True))
        batch_op.create_index(
            batch_op.f('ix_coaches_organization_id'), ['organization_id'], unique=False
        )
        batch_op.create_foreign_key(
            'fk_coaches_organization_id_organizations', 'organizations', ['organization_id'], ['id']
        )

    for table in ('quizzes', 'folders', 'groups'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column('organization_id', sa.Integer(), nullable=True))
            batch_op.create_index(
                batch_op.f(f'ix_{table}_organization_id'), ['organization_id'], unique=False
            )
            batch_op.create_foreign_key(
                f'fk_{table}_organization_id_organizations',
                'organizations',
                ['organization_id'],
                ['id'],
            )

    # --- 3. Backfill -------------------------------------------------------
    # Raw SQL against the schema *as of this revision*, never the ORM models,
    # which describe the final shape and would break this migration the next
    # time a model changes.
    coaches = bind.execute(
        sa.text("SELECT id, organization FROM coaches ORDER BY id")
    ).fetchall()

    for coach_id, org_name in coaches:
        name = (org_name or "").strip() or "My Organization"
        new_org_id = bind.execute(
            sa.text(
                "INSERT INTO organizations (name, created_at, updated_at) "
                "VALUES (:name, NOW(), NOW()) RETURNING id"
            ),
            {"name": name},
        ).scalar_one()

        bind.execute(
            sa.text(
                "UPDATE coaches SET organization_id = :org, role = 'ADMIN' WHERE id = :coach"
            ),
            {"org": new_org_id, "coach": coach_id},
        )
        for table in ("quizzes", "folders", "groups"):
            bind.execute(
                sa.text(
                    f"UPDATE {table} SET organization_id = :org WHERE coach_id = :coach"
                ),
                {"org": new_org_id, "coach": coach_id},
            )

    # --- 4. Lock the new columns down --------------------------------------
    with op.batch_alter_table('coaches', schema=None) as batch_op:
        batch_op.alter_column('organization_id', existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column('role', existing_type=coach_role_enum, nullable=False)

    for table in ('quizzes', 'folders', 'groups'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column('organization_id', existing_type=sa.Integer(), nullable=False)

    # --- 5. coach_id becomes a nullable creator reference ------------------
    # Quizzes/folders/groups now belong to the organization, so a departing
    # coach must not take the team's work with them. Recreate each FK with
    # ON DELETE SET NULL.
    for table, fk_name in (
        ('quizzes', 'quizzes_coach_id_fkey'),
        ('folders', 'folders_coach_id_fkey'),
        ('groups', 'groups_coach_id_fkey'),
    ):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column('coach_id', existing_type=sa.Integer(), nullable=True)
            batch_op.drop_constraint(fk_name, type_='foreignkey')
            batch_op.create_foreign_key(
                f'fk_{table}_coach_id_coaches', 'coaches', ['coach_id'], ['id'], ondelete='SET NULL'
            )

    # --- 6. Drop the now-redundant free-text column ------------------------
    with op.batch_alter_table('coaches', schema=None) as batch_op:
        batch_op.drop_column('organization')


def downgrade():
    bind = op.get_bind()

    with op.batch_alter_table('coaches', schema=None) as batch_op:
        batch_op.add_column(sa.Column('organization', sa.String(length=255), nullable=True))

    # Restore each coach's org name into the text column before the tables go.
    bind.execute(
        sa.text(
            "UPDATE coaches SET organization = organizations.name "
            "FROM organizations WHERE coaches.organization_id = organizations.id"
        )
    )
    bind.execute(
        sa.text("UPDATE coaches SET organization = 'Unknown' WHERE organization IS NULL")
    )

    with op.batch_alter_table('coaches', schema=None) as batch_op:
        batch_op.alter_column('organization', existing_type=sa.String(length=255), nullable=False)

    for table in ('quizzes', 'folders', 'groups'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_constraint(f'fk_{table}_coach_id_coaches', type_='foreignkey')
            batch_op.create_foreign_key(
                f'{table}_coach_id_fkey', 'coaches', ['coach_id'], ['id']
            )
            batch_op.drop_constraint(f'fk_{table}_organization_id_organizations', type_='foreignkey')
            batch_op.drop_index(batch_op.f(f'ix_{table}_organization_id'))
            batch_op.drop_column('organization_id')

    with op.batch_alter_table('coaches', schema=None) as batch_op:
        batch_op.drop_constraint('fk_coaches_organization_id_organizations', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_coaches_organization_id'))
        batch_op.drop_column('role')
        batch_op.drop_column('organization_id')

    with op.batch_alter_table('organization_invites', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_organization_invites_code'))
        batch_op.drop_index(batch_op.f('ix_organization_invites_organization_id'))
    op.drop_table('organization_invites')
    op.drop_table('organizations')

    coach_role_enum.drop(bind, checkfirst=True)
