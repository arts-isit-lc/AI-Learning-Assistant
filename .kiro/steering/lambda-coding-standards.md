---
inclusion: fileMatch
fileMatchPattern: "cdk/**/*.py"
---

# Lambda Coding Standards (Python)

Applies to: container Lambdas (`text_generation`, `data_ingestion`, `sqsTrigger`) and zip Lambdas (`deleteLastMessage`, `eventNotification`, `deleteFile`, `getFilesFunction`, `initializer`).

**Mandatory.** Refactor affected sections to comply when touching existing code. Do not introduce conflicting patterns.

## Logging — Powertools Logger Only

```python
# FORBIDDEN: logging.basicConfig, logging.getLogger, structlog, print()
# REQUIRED:
from aws_lambda_powertools import Logger
logger = Logger(service="text-generation")  # match function's logical name
```

Service names: `"text-generation"` · `"data-ingestion"` · `"sqs-trigger"` · `"delete-last-message"` · `"event-notification"`

The only permitted `print()` is in the X-Ray bootstrap block (runs before logger is initialized).

## Handler Decorator — Required on Every Handler

```python
@logger.inject_lambda_context(clear_state=True, log_uncaught_exceptions=True)
def handler(event, context):  # prefer 'handler'; zip Lambdas use 'lambda_handler' — do not add a third convention
```

## Structured Logging

```python
logger.info("Processing request", extra={"session_id": session_id, "file_count": len(files)})
logger.exception("Failed to process")  # use exception (not error) to capture stack trace
```

## Correlation Keys
Append immediately after extracting from event. Use workload-relevant keys:
```python
logger.append_keys(session_id=session_id, course_id=course_id)   # text_generation, sqs-trigger
logger.append_keys(course_id=course_id, request_id=request_id)   # data_ingestion
```

## X-Ray — Required in All Container Lambdas
Place after imports, before other module-level code. Log failures — do not swallow silently:
```python
try:
    from aws_xray_sdk.core import patch_all, xray_recorder
    xray_recorder.configure(context_missing='LOG_ERROR')
    patch_all()
except Exception as e:
    print(f"X-Ray initialization failed (non-critical): {e}")
```

## Error Handling
- Log errors before re-raising; use `logger.exception()` (includes stack trace)
- Never swallow exceptions (X-Ray init block is the only exception)

## Database — SSL Required on All Paths
All connections go through RDS Proxy inside the VPC. Use `sslmode=require`. Do not change to `verify-ca`/`verify-full` without distributing the RDS CA bundle.

```python
connection_params = { ..., 'sslmode': 'require' }            # psycopg2 dict
create_engine("postgresql+psycopg2://...?sslmode=require")    # SQLAlchemy
psycopg2.connect(f"host={host} ... sslmode=require")          # raw psycopg2
```

## Dependencies

**Container Lambdas** — `requirements.txt` must include (do not remove):
```
aws-xray-sdk
aws-lambda-powertools
```

**Zip Lambdas** — use the shared `powertoolsLayer` from `ApiGatewayStack`; do not bundle Powertools in the zip.

## Refactoring
Align nearby code to these standards when modifying a file. A file must not mix Powertools Logger with `logging.getLogger()` or `print()` after being touched.
