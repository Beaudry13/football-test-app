"""Blueprint registration."""

from flask import Flask


def register_blueprints(app: Flask) -> None:
    from app.routes.auth import auth_bp
    from app.routes.quizzes import quizzes_bp
    from app.routes.questions import questions_bp
    from app.routes.rosters import rosters_bp
    from app.routes.access_codes import access_codes_bp
    from app.routes.play import play_bp
    from app.routes.grading import grading_bp
    from app.routes.folders import folders_bp
    from app.routes.groups import groups_bp
    from app.routes.organizations import organizations_bp
    from app.routes.players import players_bp
    from app.routes.documents import documents_bp
    from app.routes.media import media_bp
    from app.routes.onboarding import onboarding_bp
    from app.routes.whats_new import whats_new_bp
    from app.routes.owner import owner_bp
    from app.routes.competition import competition_bp

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(quizzes_bp, url_prefix="/api/quizzes")
    app.register_blueprint(questions_bp, url_prefix="/api/quizzes")
    app.register_blueprint(rosters_bp, url_prefix="/api/quizzes")
    app.register_blueprint(access_codes_bp, url_prefix="/api/quizzes")
    app.register_blueprint(play_bp, url_prefix="/api/play")
    app.register_blueprint(grading_bp, url_prefix="/api")
    app.register_blueprint(folders_bp, url_prefix="/api/folders")
    app.register_blueprint(groups_bp, url_prefix="/api/groups")
    app.register_blueprint(organizations_bp, url_prefix="/api/organizations")
    app.register_blueprint(players_bp, url_prefix="/api/players")
    app.register_blueprint(documents_bp, url_prefix="/api/documents")
    # No url_prefix collision with /api/documents: the token is opaque and
    # this blueprint only ever matches /api/media/<token>.
    app.register_blueprint(media_bp, url_prefix="/api/media")
    app.register_blueprint(onboarding_bp, url_prefix="/api/onboarding")
    app.register_blueprint(whats_new_bp, url_prefix="/api/whats-new")
    # A level above organizations, not inside them - see routes/owner.py.
    # Every route is gated by the blueprint itself.
    app.register_blueprint(owner_bp, url_prefix="/api/owner")
    # Coach and player routes share one prefix because they drive one state
    # machine; the coach half is @jwt_required, the player half is public.
    app.register_blueprint(competition_bp, url_prefix="/api/competition")
