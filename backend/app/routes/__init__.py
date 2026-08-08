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
