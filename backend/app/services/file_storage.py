"""File storage abstraction for uploaded images.

`LocalFileStorage` writes to disk under the configured upload folder -
fine for local dev, but most PaaS hosts (including Render) wipe local disk
on every redeploy/restart, so production uses `S3FileStorage` instead.
Routes depend on the `FileStorage` interface rather than either concrete
class, so the backend is chosen once in `get_file_storage()` and nothing
else needs to know which one is active.
"""

import io
import uuid
from abc import ABC, abstractmethod
from pathlib import Path

import boto3
from flask import current_app
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.datastructures import FileStorage as UploadedFile
from werkzeug.utils import secure_filename

from app.errors import ApiError

COMPRESSED_CONTENT_TYPE = "image/jpeg"
COMPRESSED_EXTENSION = "jpg"


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


def _compress_image(uploaded_file: UploadedFile, max_dimension: int, quality: int) -> bytes:
    """Recompresses an uploaded image to a JPEG capped at `max_dimension` on
    its longest side, for storage. Runs once, at upload time, before a coach
    can ever open the annotation editor - resizing an already-annotated
    image would shift shapes out from under the coordinate space they were
    drawn against (see AnnotationCanvas.tsx/AnnotationViewer.tsx), which is
    exactly the bug this project already fixed once for a different reason.
    Always outputs JPEG (transparency isn't a real use case for football
    film-still photos), so the caller must not assume the original
    extension/content-type survive.
    """
    raw_bytes = uploaded_file.stream.read()
    try:
        image = Image.open(io.BytesIO(raw_bytes))
        image.load()
    except (OSError, UnidentifiedImageError) as exc:
        raise ApiError("The uploaded file isn't a valid image", status_code=400) from exc

    # Must run before anything measures width/height - phone photos often
    # carry an EXIF rotation flag Pillow doesn't apply automatically, so
    # skipping this would silently bake a sideways image into storage.
    image = ImageOps.exif_transpose(image) or image
    # RGB, unconditionally: source may be P/RGBA/CMYK/etc, and JPEG has no
    # alpha channel to preserve one in even if we wanted to.
    image = image.convert("RGB")

    if max(image.width, image.height) > max_dimension:
        image.thumbnail((max_dimension, max_dimension), Image.LANCZOS)

    output = io.BytesIO()
    image.save(output, format="JPEG", quality=quality, optimize=True)
    return output.getvalue()


class FileStorage(ABC):
    @abstractmethod
    def save_image(self, uploaded_file: UploadedFile) -> str:
        """Persist an uploaded image and return a URL/path clients can fetch."""

    @abstractmethod
    def delete_image(self, image_url: str) -> None:
        """Remove a previously stored image. No-op if it doesn't exist."""

    @abstractmethod
    def load_image_bytes(self, image_url: str) -> bytes | None:
        """Read back a previously stored image's raw bytes (e.g. to embed in
        a PDF export). Read-only - never writes, never raises; returns None
        for a missing file or any read failure so a caller (like the export
        builder) can degrade cleanly instead of failing the whole request
        over one bad image."""


class LocalFileStorage(FileStorage):
    def __init__(self, upload_folder: str, allowed_extensions: set[str], max_dimension: int, jpeg_quality: int):
        self.upload_folder = Path(upload_folder)
        self.allowed_extensions = allowed_extensions
        self.max_dimension = max_dimension
        self.jpeg_quality = jpeg_quality

    def save_image(self, uploaded_file: UploadedFile) -> str:
        _validated_extension(uploaded_file, self.allowed_extensions)
        compressed = _compress_image(uploaded_file, self.max_dimension, self.jpeg_quality)

        stored_name = f"{uuid.uuid4().hex}.{COMPRESSED_EXTENSION}"
        self.upload_folder.mkdir(parents=True, exist_ok=True)
        (self.upload_folder / stored_name).write_bytes(compressed)

        return f"/uploads/{stored_name}"

    def delete_image(self, image_url: str) -> None:
        stored_name = image_url.rsplit("/", 1)[-1]
        path = self.upload_folder / stored_name
        if path.exists():
            path.unlink()

    def load_image_bytes(self, image_url: str) -> bytes | None:
        stored_name = image_url.rsplit("/", 1)[-1]
        path = self.upload_folder / stored_name
        try:
            return path.read_bytes()
        except OSError:
            return None


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
        max_dimension: int,
        jpeg_quality: int,
    ):
        self.allowed_extensions = allowed_extensions
        self.bucket_name = bucket_name
        self.public_url_base = public_url_base.rstrip("/")
        self.max_dimension = max_dimension
        self.jpeg_quality = jpeg_quality
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
        )

    def save_image(self, uploaded_file: UploadedFile) -> str:
        _validated_extension(uploaded_file, self.allowed_extensions)
        compressed = _compress_image(uploaded_file, self.max_dimension, self.jpeg_quality)

        stored_name = f"{uuid.uuid4().hex}.{COMPRESSED_EXTENSION}"
        self.client.put_object(
            Bucket=self.bucket_name,
            Key=stored_name,
            Body=compressed,
            ContentType=COMPRESSED_CONTENT_TYPE,
        )

        return f"{self.public_url_base}/{stored_name}"

    def delete_image(self, image_url: str) -> None:
        # delete_object is idempotent - no error if the key is already gone.
        stored_name = image_url.rsplit("/", 1)[-1]
        self.client.delete_object(Bucket=self.bucket_name, Key=stored_name)

    def load_image_bytes(self, image_url: str) -> bytes | None:
        stored_name = image_url.rsplit("/", 1)[-1]
        try:
            obj = self.client.get_object(Bucket=self.bucket_name, Key=stored_name)
            return obj["Body"].read()
        except Exception:
            # Broad on purpose: botocore raises its own ClientError hierarchy
            # for "not found" alongside network/credential errors, none of
            # which should ever fail a PDF export over one image.
            return None


def get_file_storage() -> FileStorage:
    if current_app.config["STORAGE_BACKEND"] == "s3":
        return S3FileStorage(
            allowed_extensions=current_app.config["ALLOWED_IMAGE_EXTENSIONS"],
            account_id=current_app.config["R2_ACCOUNT_ID"],
            access_key_id=current_app.config["R2_ACCESS_KEY_ID"],
            secret_access_key=current_app.config["R2_SECRET_ACCESS_KEY"],
            bucket_name=current_app.config["R2_BUCKET_NAME"],
            public_url_base=current_app.config["R2_PUBLIC_URL_BASE"],
            max_dimension=current_app.config["IMAGE_MAX_DIMENSION"],
            jpeg_quality=current_app.config["IMAGE_JPEG_QUALITY"],
        )
    return LocalFileStorage(
        upload_folder=current_app.config["UPLOAD_FOLDER"],
        allowed_extensions=current_app.config["ALLOWED_IMAGE_EXTENSIONS"],
        max_dimension=current_app.config["IMAGE_MAX_DIMENSION"],
        jpeg_quality=current_app.config["IMAGE_JPEG_QUALITY"],
    )
