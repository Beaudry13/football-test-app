"""File storage abstraction for uploaded images.

`LocalFileStorage` writes to disk under the configured upload folder. It's
the only implementation for now, but routes depend on the `FileStorage`
interface rather than the concrete class so a cloud-backed implementation
(S3, GCS, etc.) can be swapped in later without touching route code.
"""

import uuid
from abc import ABC, abstractmethod
from pathlib import Path

from flask import current_app
from werkzeug.datastructures import FileStorage as UploadedFile
from werkzeug.utils import secure_filename

from app.errors import ApiError


class FileStorage(ABC):
    @abstractmethod
    def save_image(self, uploaded_file: UploadedFile) -> str:
        """Persist an uploaded image and return a URL/path clients can fetch."""

    @abstractmethod
    def delete_image(self, image_url: str) -> None:
        """Remove a previously stored image. No-op if it doesn't exist."""


class LocalFileStorage(FileStorage):
    def __init__(self, upload_folder: str, allowed_extensions: set[str]):
        self.upload_folder = Path(upload_folder)
        self.allowed_extensions = allowed_extensions

    def save_image(self, uploaded_file: UploadedFile) -> str:
        if not uploaded_file or not uploaded_file.filename:
            raise ApiError("No image file provided", status_code=400)

        original_name = secure_filename(uploaded_file.filename)
        extension = original_name.rsplit(".", 1)[-1].lower() if "." in original_name else ""
        if extension not in self.allowed_extensions:
            raise ApiError(
                f"Unsupported image type. Allowed: {', '.join(sorted(self.allowed_extensions))}",
                status_code=400,
            )

        stored_name = f"{uuid.uuid4().hex}.{extension}"
        self.upload_folder.mkdir(parents=True, exist_ok=True)
        uploaded_file.save(self.upload_folder / stored_name)

        return f"/uploads/{stored_name}"

    def delete_image(self, image_url: str) -> None:
        stored_name = image_url.rsplit("/", 1)[-1]
        path = self.upload_folder / stored_name
        if path.exists():
            path.unlink()


def get_file_storage() -> FileStorage:
    return LocalFileStorage(
        upload_folder=current_app.config["UPLOAD_FOLDER"],
        allowed_extensions=current_app.config["ALLOWED_IMAGE_EXTENSIONS"],
    )
