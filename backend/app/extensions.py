"""Shared Flask extension instances.

Instantiated here (unbound) so models and blueprints can import them
without triggering circular imports; bound to the app in create_app().
"""

from flask_bcrypt import Bcrypt
from flask_cors import CORS
from flask_jwt_extended import JWTManager
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_migrate import Migrate
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
migrate = Migrate()
bcrypt = Bcrypt()
jwt = JWTManager()
cors = CORS()
# No default_limits: only the specific public, unauthenticated endpoints that
# are realistic abuse targets (login, register, access-code guessing) opt in
# via their own @limiter.limit(...), so normal authenticated dashboard usage
# is never throttled. In-memory storage is fine for a single dev process;
# a multi-worker production deployment needs a shared backend (e.g. Redis)
# passed via storage_uri, or each worker enforces its own separate limit.
limiter = Limiter(key_func=get_remote_address, default_limits=[])
