"""Peira Owner Dashboard - platform-level adoption and usage.

A THIRD LEVEL, ABOVE ORGANIZATIONS
-----------------------------------
Coach View is one coach's own work. Admin View is one organization's work.
This is Peira the product, across every organization - and it is NOT reached
from Admin View, because an organization admin must never get here.

THE PERMISSION IS ENFORCED ON THE BLUEPRINT, NOT PER ROUTE
-----------------------------------------------------------
`before_request` below runs for every rule registered here, so a route added
later is protected whether or not its author remembers to decorate it. Per
-route decorators are one forgotten line away from a platform-wide leak; this
shape makes forgetting impossible. tests/test_owner_dashboard.py additionally
walks the url_map and fails if any /api/owner rule escapes the gate.

Non-owners get 404, not 403 - see require_platform_owner for why.

ALMOST ENTIRELY READ-ONLY, AND CONTENT-FREE
--------------------------------------------
Every route is a GET except the two merge endpoints. `/merges/preview` is a
POST only because it takes a body; it writes nothing. `/merges/execute` is the
one deliberately destructive operation in the owner area, and a guard test
pins that list so a third mutating route cannot appear by accident. Payloads come from services/platform_metrics.py, which
selects aggregates and account metadata and never serializes a content model:
no quiz titles, questions, answers, explanations, drawings, playbook
filenames or player names. The dashboard answers who is using Peira and how
much, not what they are installing.
"""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import verify_jwt_in_request

from app.errors import ApiError
from app.schemas.owner import MergeExecuteSchema, MergePreviewSchema
from app.utils.validation import load_json_body
from app.extensions import db
from app.models import Organization
from app.services import organization_merge, platform_metrics
from app.utils.auth import require_platform_owner

owner_bp = Blueprint("owner", __name__)


@owner_bp.before_request
def _require_owner():
    """The gate for every route in this blueprint.

    An anonymous caller gets 401 and an authenticated non-owner gets 404 -
    the difference matters: 401 says "sign in", which is true for any Peira
    URL, while 404 declines to confirm that an owner area exists at all.

    CORS PREFLIGHT IS EXEMPT, and it has to be. A browser sends OPTIONS with
    no Authorization header by design, so it can never satisfy this check;
    the preflight carries no data and returns none, and the real GET that
    follows is still fully gated. This is also why the check calls
    verify_jwt_in_request() directly rather than wearing @jwt_required():
    that decorator silently exempts OPTIONS and would then fall straight
    through into an identity lookup with no verified token - a 500 on every
    preflight, which is exactly what happened before this was written down.
    """
    if request.method == "OPTIONS":
        return None
    verify_jwt_in_request()
    require_platform_owner()
    return None


@owner_bp.get("/overview")
def overview():
    """Platform totals, rolling windows, and feature adoption."""
    return jsonify(platform_metrics.platform_overview())


@owner_bp.get("/organizations")
def organizations():
    """Every organization with its usage rollups.

    Search and the empty filter are applied here rather than in SQL: the row
    set is one per tenant, so filtering in Python keeps platform_metrics
    owning the definitions and avoids a second place where "empty" could mean
    something slightly different.
    """
    rows = platform_metrics.organization_rows()

    search = (request.args.get("search") or "").strip().lower()
    if search:
        rows = [row for row in rows if search in row["name"].lower()]

    # Probe/test organizations are found by having nothing in them, never by
    # their name - see platform_metrics.organization_rows.
    if request.args.get("filter") == "empty":
        rows = [row for row in rows if row["is_empty"]]

    return jsonify({"organizations": rows, "count": len(rows)})


@owner_bp.get("/organizations/<int:organization_id>")
def organization_detail(organization_id: int):
    """One organization's usage and its coaches.

    404 for an id that does not exist, same as everywhere else in this app -
    there is no tenancy check to make here, since the caller is the platform
    owner and every organization is in scope by definition.
    """
    organization = db.session.get(Organization, organization_id)
    if organization is None:
        raise ApiError("Organization not found", status_code=404)
    return jsonify(platform_metrics.organization_detail(organization))


@owner_bp.get("/coaches")
def coaches():
    """Every coach account on the platform.

    Name and email are included because identifying and supporting an account
    is the whole point; password_hash is never selected and invitation codes
    are not touched.
    """
    rows = platform_metrics.coach_rows()

    search = (request.args.get("search") or "").strip().lower()
    if search:
        rows = [
            row
            for row in rows
            if search in row["username"].lower()
            or search in row["email"].lower()
            or search in row["organization_name"].lower()
        ]

    organization_id = request.args.get("organization_id", type=int)
    if organization_id is not None:
        rows = [row for row in rows if row["organization_id"] == organization_id]

    # "Attributed" only - a coach with no attributable activity is unknown,
    # not inactive. See platform_metrics.attributed_coach_activity.
    if request.args.get("filter") == "with_activity":
        rows = [row for row in rows if row["last_attributed_activity"] is not None]
    elif request.args.get("filter") == "no_activity":
        rows = [row for row in rows if row["last_attributed_activity"] is None]

    return jsonify({"coaches": rows, "count": len(rows)})


# ---------------------------------------------------------------------------
# Organization merge
#
# The only mutating capability in the owner area, and deliberately two steps:
# a preview that writes nothing, then an execution that re-verifies the
# preview still describes reality. See services/organization_merge.py.
# ---------------------------------------------------------------------------


@owner_bp.post("/merges/preview")
def merge_preview():
    """What WOULD happen. Writes nothing.

    A POST purely because it carries a body - there is no state change here,
    and a test asserts the database is byte-identical across a preview.
    """
    data = load_json_body(MergePreviewSchema())
    try:
        return jsonify(
            organization_merge.preview(
                data["source_organization_id"],
                data["destination_organization_id"],
                data.get("coach_roles"),
            )
        )
    except organization_merge.MergeRefused as refused:
        raise ApiError(str(refused), status_code=422, reason="merge_refused") from refused


@owner_bp.post("/merges/execute")
def merge_execute():
    """Perform the merge. One transaction, or nothing at all.

    Requires the fingerprint from a preview: if either organization changed in
    the meantime the merge is refused and a fresh preview must be reviewed,
    because the operator approved a picture that no longer matches reality.
    """
    coach = require_platform_owner()
    data = load_json_body(MergeExecuteSchema())
    try:
        result = organization_merge.execute(
            data["source_organization_id"],
            data["destination_organization_id"],
            expected_fingerprint=data["fingerprint"],
            performed_by=coach,
            decisions=data.get("coach_roles"),
            acknowledge_collisions=data["acknowledge_collisions"],
            acknowledge_duplicate_players=data["acknowledge_duplicate_players"],
        )
    except organization_merge.MergeRefused as refused:
        raise ApiError(str(refused), status_code=422, reason="merge_refused") from refused
    return jsonify(result), 200
