"""File storage abstraction for uploaded images.

`LocalFileStorage` writes to disk under the configured upload folder -
fine for local dev, but most PaaS hosts (including Render) wipe local disk
on every redeploy/restart, so production uses `S3FileStorage` instead.
Routes depend on the `FileStorage` interface rather than either concrete
class, so the backend is chosen once in `get_file_storage()` and nothing
else needs to know which one is active.
"""

import mimetypes
import uuid
from abc import ABC, abstractmethod
from pathlib import Path

import boto3
from flask import current_app
from werkzeug.datastructures import FileStorage as UploadedFile
from werkzeug.utils import secure_filename

from app.errors import ApiError


def _validated_extension(uploaded_file: UploadedFile, allowed_extensions: set[str]) -> str:
    if not uploaded_file or not uploaded_file.filename:
        raise ApiError("No image file provided", status_code=400)

    original_name = secure_filename(uploaded_file.filename)
    extension = original_name.rsplit(".", 1)[-1].lower() if "." in original_name else ""
    if extension not in allowed_extensions:
        raise ApiError(
            f"Unsupported image type. Allowed: {', '.join(sorted(allowed_extensions))}",
            status_code=400,
        )
    return extension


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
        extension = _validated_extension(uploaded_file, self.allowed_extensions)

        stored_name = f"{uuid.uuid4().hex}.{extension}"
        self.upload_folder.mkdir(parents=True, exist_ok=True)
        uploaded_file.save(self.upload_folder / stored_name)

        return f"/uploads/{stored_name}"

    def delete_image(self, image_url: str) -> None:
        stored_name = image_url.rsplit("/", 1)[-1]
        path = self.upload_folder / stored_name
        if path.exists():
            path.unlink()


class S3FileStorage(FileStorage):
    """Stores images in an S3-compatible bucket (built against Cloudflare R2).

    Returns the bucket's public URL directly as `image_url` rather than a
    server-relative path - the frontend's `resolveMediaUrl` already passes
    absolute URLs through unchanged, so this needs no frontend changes.
    """

    def __init__(
        self,
        allowed_extensions: set[str],
        account_id: str,
        access_key_id: str,
        secret_access_key: str,
        bucket_name: str,
        public_url_base: str,
    ):
        self.allowed_extensions = allowed_extensions
        self.bucket_name = bucket_name
        self.public_url_base = public_url_base.rstrip("/")
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
        )

    def save_image(self, uploaded_file: UploadedFile) -> str:
        extension = _validated_extension(uploaded_file, self.allowed_extensions)

        stored_name = f"{uuid.uuid4().hex}.{extension}"
        content_type = uploaded_file.content_type or mimetypes.guess_type(stored_name)[0] or "application/octet-stream"
        self.client.put_object(
            Bucket=self.bucket_name,
            Key=stored_name,
            Body=uploaded_file.stream,
            ContentType=content_type,
        )

        return f"{self.public_url_base}/{stored_name}"

    def delete_image(self, image_url: str) -> None:
        # delete_object is idempotent - no error if the key is already gone.
        stored_name = image_url.rsplit("/", 1)[-1]
        self.client.delete_object(Bucket=self.bucket_name, Key=stored_name)


def get_file_storage() -> FileStorage:
    if current_app.config["STORAGE_BACKEND"] == "s3":
        return S3FileStorage(
            allowed_extensions=current_app.config["ALLOWED_IMAGE_EXTENSIONS"],
            account_id=current_app.config["R2_ACCOUNT_ID"],
            access_key_id=current_app.config["R2_ACCESS_KEY_ID"],
            secret_access_key=current_app.config["R2_SECRET_ACCESS_KEY"],
            bucket_name=current_app.config["R2_BUCKET_NAME"],
            public_url_base=current_app.config["R2_PUBLIC_URL_BASE"],
        )
    return LocalFileStorage(
        upload_folder=current_app.config["UPLOAD_FOLDER"],
        allowed_extensions=current_app.config["ALLOWED_IMAGE_EXTENSIONS"],
    )
