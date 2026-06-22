#!/usr/bin/env python3
"""Re-ingestion script — copies existing files from DataIngestionBucket to irBucket.

Triggers the V2 multimodal RAG ingestion pipeline by placing files at the
expected S3 key format: courses/{course_id}/{module_id}/{filename}

The V2 ragIngestionFunction has an S3 event source on irBucket with prefix
"courses/" — any ObjectCreated event there automatically triggers ingestion.

Usage:
    # Dry run (prints what would be copied, no actual changes):
    python reingest_to_v2.py --source-bucket AILA-DataIngestionBucket --target-bucket aila-ir-bucket --dry-run

    # Execute the copy:
    python reingest_to_v2.py --source-bucket AILA-DataIngestionBucket --target-bucket aila-ir-bucket

    # Copy only a specific course:
    python reingest_to_v2.py --source-bucket AILA-DataIngestionBucket --target-bucket aila-ir-bucket --course-id abc-123

    # With a custom AWS region:
    python reingest_to_v2.py --source-bucket AILA-DataIngestionBucket --target-bucket aila-ir-bucket --region ca-central-1

Notes:
    - Uses server-side S3 copy (no download/upload — fast and free within same region)
    - Skips files that don't match the expected V1 key format
    - Logs all operations for auditability
    - Safe to run multiple times (overwrites existing keys in irBucket, which
      re-triggers ingestion — idempotent because V2 handles deduplication via content hashing)
"""

import argparse
import sys
import time

import boto3
from botocore.exceptions import ClientError


def parse_v1_key(key: str) -> dict | None:
    """Parse a V1 S3 key into components.

    V1 format: {course_id}/{module_id}/documents/{filename}.{ext}

    Returns dict with course_id, module_id, filename or None if key doesn't match.
    """
    parts = key.split("/")
    if len(parts) < 4 or parts[2] != "documents":
        return None

    course_id = parts[0]
    module_id = parts[1]
    # Everything after "documents/" is the filename (could contain slashes in theory)
    filename = "/".join(parts[3:])

    if not filename:
        return None

    return {
        "course_id": course_id,
        "module_id": module_id,
        "filename": filename,
    }


def build_v2_key(course_id: str, module_id: str, filename: str) -> str:
    """Build the V2 S3 key format expected by ragIngestionFunction.

    V2 format: courses/{course_id}/{module_id}/{filename}
    """
    return f"courses/{course_id}/{module_id}/{filename}"


def list_source_objects(s3_client, bucket: str, prefix: str = "") -> list[dict]:
    """List all objects in the source bucket, handling pagination."""
    objects = []
    paginator = s3_client.get_paginator("list_objects_v2")
    page_iterator = paginator.paginate(Bucket=bucket, Prefix=prefix)

    for page in page_iterator:
        for obj in page.get("Contents", []):
            objects.append(obj)

    return objects


def copy_object(s3_client, source_bucket: str, source_key: str, target_bucket: str, target_key: str) -> bool:
    """Server-side copy from source to target. Returns True on success."""
    try:
        s3_client.copy_object(
            Bucket=target_bucket,
            Key=target_key,
            CopySource={"Bucket": source_bucket, "Key": source_key},
        )
        return True
    except ClientError as e:
        print(f"  ERROR copying {source_key}: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Copy existing files from DataIngestionBucket to irBucket for V2 re-ingestion."
    )
    parser.add_argument("--source-bucket", required=True, help="V1 DataIngestionBucket name")
    parser.add_argument("--target-bucket", required=True, help="V2 irBucket name")
    parser.add_argument("--region", default="ca-central-1", help="AWS region (default: ca-central-1)")
    parser.add_argument("--course-id", default=None, help="Only re-ingest files for this course ID")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be copied without executing")
    parser.add_argument("--delay", type=float, default=0.1, help="Delay between copies in seconds (default: 0.1)")
    args = parser.parse_args()

    s3_client = boto3.client("s3", region_name=args.region)

    print(f"Source bucket: {args.source_bucket}")
    print(f"Target bucket: {args.target_bucket}")
    print(f"Region: {args.region}")
    if args.course_id:
        print(f"Filtering to course: {args.course_id}")
    if args.dry_run:
        print("MODE: DRY RUN (no changes will be made)")
    print()

    # List all objects in source bucket
    prefix = f"{args.course_id}/" if args.course_id else ""
    print(f"Listing objects in s3://{args.source_bucket}/{prefix}...")
    objects = list_source_objects(s3_client, args.source_bucket, prefix)
    print(f"Found {len(objects)} total objects")
    print()

    # Filter and transform
    copied = 0
    skipped = 0
    errors = 0

    for obj in objects:
        source_key = obj["Key"]
        parsed = parse_v1_key(source_key)

        if parsed is None:
            skipped += 1
            if args.dry_run:
                print(f"  SKIP (non-document key): {source_key}")
            continue

        # Filter by course_id if specified
        if args.course_id and parsed["course_id"] != args.course_id:
            skipped += 1
            continue

        target_key = build_v2_key(parsed["course_id"], parsed["module_id"], parsed["filename"])

        if args.dry_run:
            print(f"  WOULD COPY: s3://{args.source_bucket}/{source_key}")
            print(f"         --> s3://{args.target_bucket}/{target_key}")
            copied += 1
        else:
            success = copy_object(s3_client, args.source_bucket, source_key, args.target_bucket, target_key)
            if success:
                copied += 1
                print(f"  COPIED ({copied}): {source_key} -> {target_key}")
            else:
                errors += 1

            # Small delay to avoid overwhelming the ingestion pipeline
            if args.delay > 0:
                time.sleep(args.delay)

    print()
    print("=" * 60)
    print(f"Summary:")
    print(f"  Copied:  {copied}")
    print(f"  Skipped: {skipped} (non-document keys)")
    print(f"  Errors:  {errors}")
    if args.dry_run:
        print(f"\n  (DRY RUN — no files were actually copied)")
    else:
        print(f"\n  V2 ingestion pipeline will process {copied} files automatically.")
    print("=" * 60)

    if errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
