#!/usr/bin/env python3
"""Build a temporary Release Elementary Flow cache transfer on a remote host."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import unquote, urlparse

TRANSFER_SCHEMA = "tiangong.release.elementary-flow-cache-transfer.v1"
REQUEST_SCHEMA = "tiangong.release.elementary-flow-cache-export-request.v1"


class ProtocolError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def require_text(config: dict, key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ProtocolError(
            "flow_cache_remote_configuration_invalid",
            f"Remote export request is missing {key}",
            {"field": key},
        )
    return value.strip()


def project_ref_from_connection(connection_string: str) -> str | None:
    parsed = urlparse(connection_string)
    username = unquote(parsed.username or "")
    if "." in username:
        candidate = username.rsplit(".", 1)[1]
        if candidate:
            return candidate.lower()
    hostname = (parsed.hostname or "").lower()
    if hostname.startswith("db.") and hostname.endswith(".supabase.co"):
        return hostname.split(".", 2)[1]
    return None


def project_ref_from_s3_endpoint(endpoint: str) -> str | None:
    hostname = (urlparse(endpoint).hostname or "").lower()
    if hostname.endswith(".storage.supabase.co"):
        return hostname.split(".", 1)[0]
    return None


def validate_project_binding(config: dict) -> str:
    connection_ref = project_ref_from_connection(
        require_text(config, "connectionString")
    )
    storage_ref = project_ref_from_s3_endpoint(require_text(config, "s3Endpoint"))
    expected_ref = config.get("expectedProjectRef")
    if isinstance(expected_ref, str) and expected_ref.strip():
        expected_ref = expected_ref.strip().lower()
    else:
        expected_ref = None
    if (
        connection_ref is None
        or storage_ref is None
        or connection_ref != storage_ref
        or (expected_ref is not None and expected_ref != connection_ref)
    ):
        raise ProtocolError(
            "flow_cache_remote_project_binding_mismatch",
            "Database and Supabase Storage project binding could not be verified",
            {
                "databaseProjectResolved": connection_ref is not None,
                "storageProjectResolved": storage_ref is not None,
                "expectedProjectProvided": expected_ref is not None,
            },
        )
    return connection_ref


def export_snapshot(config: dict, destination: Path) -> dict:
    if shutil.which("psql") is None:
        raise ProtocolError(
            "flow_cache_remote_dependency_missing",
            "Remote runtime requires psql",
            {"dependency": "psql"},
        )
    parsed = urlparse(require_text(config, "connectionString"))
    if not parsed.hostname or not parsed.username:
        raise ProtocolError(
            "flow_cache_remote_configuration_invalid",
            "Database connection string is invalid",
            {"field": "connectionString"},
        )
    database = unquote(parsed.path.lstrip("/")) or "postgres"
    pg_environment = os.environ.copy()
    pg_environment.update(
        {
            "PGHOST": parsed.hostname,
            "PGPORT": str(parsed.port or 5432),
            "PGDATABASE": database,
            "PGUSER": unquote(parsed.username),
            "PGPASSWORD": unquote(parsed.password or ""),
            "PGAPPNAME": "tiangong-lca-release-flow-cache-remote",
            "PGCONNECT_TIMEOUT": "10",
        }
    )
    query_parameters = dict(
        item.split("=", 1) if "=" in item else (item, "")
        for item in parsed.query.split("&")
        if item
    )
    if query_parameters.get("sslmode"):
        pg_environment["PGSSLMODE"] = query_parameters["sslmode"]
    sql = """
        begin transaction isolation level repeatable read read only;
        set local statement_timeout = '30min';
        select jsonb_build_object(
          'kind', 'watermark',
          'value', jsonb_build_object(
            'publishedCount', count(*)::bigint,
            'maxModifiedAt', max(modified_at)::text
          )
        )::text
          from public.flows
         where state_code between 100 and 199;
        select jsonb_build_object(
          'kind', 'record',
          'value', jsonb_build_object(
            'datasetType', 'flow',
            'uuid', lower(id::text),
            'version', btrim(version::text),
            'document', coalesce(json, json_ordered::jsonb)
          )
        )::text
          from public.flows
         where state_code between 100 and 199
           and coalesce(json, json_ordered::jsonb)
                 #>> '{flowDataSet,modellingAndValidation,LCIMethod,typeOfDataSet}'
               = 'Elementary flow'
         order by id, btrim(version::text);
        commit;
    """
    artifact_hash = hashlib.sha256()
    artifact_byte_size = 0
    record_count = 0
    watermark = None
    process = subprocess.Popen(
        ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
        env=pg_environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
    )
    try:
        assert process.stdout is not None
        with destination.open("wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
                for output_line in process.stdout:
                    envelope = json.loads(output_line)
                    if envelope.get("kind") == "watermark":
                        if watermark is not None:
                            raise ProtocolError(
                                "flow_cache_remote_database_protocol_invalid",
                                "Database export returned more than one watermark",
                            )
                        watermark = envelope.get("value")
                    elif envelope.get("kind") == "record":
                        record = envelope.get("value")
                        line = (
                            json.dumps(
                                record,
                                ensure_ascii=False,
                                separators=(",", ":"),
                                allow_nan=False,
                            )
                            + "\n"
                        ).encode("utf-8")
                        compressed.write(line)
                        artifact_hash.update(line)
                        artifact_byte_size += len(line)
                        record_count += 1
                    else:
                        raise ProtocolError(
                            "flow_cache_remote_database_protocol_invalid",
                            "Database export returned an unknown envelope",
                        )
        process.wait()
        if process.returncode != 0:
            raise ProtocolError(
                "flow_cache_remote_database_export_failed",
                "Remote psql snapshot export failed",
                {"exitCode": process.returncode},
            )
        if watermark is None:
            raise ProtocolError(
                "flow_cache_remote_database_protocol_invalid",
                "Database export did not return its snapshot watermark",
            )
    except Exception:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        raise

    compressed_hash = hashlib.sha256()
    with destination.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            compressed_hash.update(chunk)
    return {
        "databaseWatermark": {
            "publishedCount": int(watermark["publishedCount"]),
            "maxModifiedAt": watermark.get("maxModifiedAt"),
        },
        "artifactSha256": artifact_hash.hexdigest(),
        "artifactByteSize": artifact_byte_size,
        "recordCount": record_count,
        "compressedSha256": compressed_hash.hexdigest(),
        "compressedByteSize": destination.stat().st_size,
    }


def upload_transfer(config: dict, source: Path, evidence: dict) -> dict:
    try:
        import boto3
        from botocore.config import Config
    except ModuleNotFoundError as error:
        raise ProtocolError(
            "flow_cache_remote_dependency_missing",
            "Remote Python runtime requires boto3 and botocore",
            {"dependency": error.name},
        ) from None

    prefix = require_text(config, "objectPrefix").strip("/")
    if not prefix or any(part in ("", ".", "..") for part in prefix.split("/")):
        raise ProtocolError(
            "flow_cache_remote_configuration_invalid",
            "Temporary object prefix is invalid",
            {"field": "objectPrefix"},
        )
    bucket = require_text(config, "s3Bucket")
    key = f"{prefix}/{uuid.uuid4()}.ndjson.gz"
    expires_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)
    client = boto3.client(
        "s3",
        endpoint_url=require_text(config, "s3Endpoint"),
        region_name=require_text(config, "s3Region"),
        aws_access_key_id=require_text(config, "s3AccessKeyId"),
        aws_secret_access_key=require_text(config, "s3SecretAccessKey"),
        aws_session_token=config.get("s3SessionToken") or None,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )
    uploaded = False
    try:
        client.upload_file(
            str(source),
            bucket,
            key,
            ExtraArgs={
                "ContentType": "application/gzip",
                "Expires": expires_at,
                "Metadata": {
                    "schema-version": TRANSFER_SCHEMA,
                    "artifact-sha256": evidence["artifactSha256"],
                    "compressed-sha256": evidence["compressedSha256"],
                },
            },
        )
        uploaded = True
        download_url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=3_600,
        )
        delete_url = client.generate_presigned_url(
            "delete_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=3_600,
        )
        return {
            **evidence,
            "downloadUrl": download_url,
            "deleteUrl": delete_url,
            "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
        }
    except Exception:
        if uploaded:
            try:
                client.delete_object(Bucket=bucket, Key=key)
            except Exception:
                pass
        raise


def main() -> None:
    config = json.load(sys.stdin)
    if config.get("schemaVersion") != REQUEST_SCHEMA:
        raise ProtocolError(
            "flow_cache_remote_protocol_invalid",
            "Unsupported remote cache export request schema",
        )
    validate_project_binding(config)
    with tempfile.TemporaryDirectory(prefix="release-flow-cache-data-") as directory:
        compressed = Path(directory) / "elementary-flows.ndjson.gz"
        evidence = export_snapshot(config, compressed)
        transfer = upload_transfer(config, compressed, evidence)
    created_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    result = {
        "schemaVersion": TRANSFER_SCHEMA,
        "createdAt": created_at,
        **transfer,
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except ProtocolError as error:
        sys.stderr.write(
            json.dumps(
                {
                    "code": error.code,
                    "message": error.message,
                    "details": error.details,
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        raise SystemExit(1) from None
    except Exception as error:
        sys.stderr.write(
            json.dumps(
                {
                    "code": "flow_cache_remote_export_failed",
                    "message": "Remote host could not produce the Elementary Flow cache transfer",
                    "details": {"failureType": type(error).__name__},
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        raise SystemExit(1) from None
