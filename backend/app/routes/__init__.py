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

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(quizzes_bp, url_prefix="/api/quizzes")
    app.register_blueprint(questions_bp, url_prefix="/api/quizzes")
    app.register_blueprint(rosters_bp, url_prefix="/api/quizzes")
    app.register_blueprint(access_codes_bp, url_prefix="/api/quizzes")
    app.register_blueprint(play_bp, url_prefix="/api/play")
    app.register_blueprint(grading_bp, url_prefix="/api")
