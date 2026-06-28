---
inclusion: fileMatch
fileMatchPattern: "cdk/**/*.py"
---

# Lambda Coding Standards (Python)

Applies to all container Lambdas (`text_generation`, `multimodal_rag_v2`, `chatbot_v2`, `math_compute`, `sqsTrigger`) and zip Lambdas. Mandatory — refactor affected sections when touching existing code.

## Logging — Powertools Only
```python
from aws_lambda_powertools import Logger
logger = Logger(service="text-generation")  # match function's logical name
```
FORBIDDEN: `logging.basicConfig`, `logging.getLogger`, `structlog`, `print()` (except X-Ray bootstrap).

## Handler Decorator
```python
@logger.inject_lambda_context(clear_state=True, log_uncaught_exceptions=True)
def handler(event, context):
```

## Structured Logging + Correlation
```python
logger.append_keys(session_id=session_id, course_id=course_id)
logger.info("Processing", extra={"file_count": len(files)})
logger.exception("Failed")  # captures stack trace
```

## X-Ray — Required in Container Lambdas
```python
try:
    from aws_xray_sdk.core import patch_all, xray_recorder
    xray_recorder.configure(context_missing='LOG_ERROR')
    patch_all()
except Exception as e:
    print(f"X-Ray initialization failed (non-critical): {e}")
```

## Database — SSL Required
All connections via RDS Proxy: `sslmode=require`. Never `verify-ca`/`verify-full` without CA bundle.

## Dependencies
- Container: `requirements.txt` must include `aws-xray-sdk` + `aws-lambda-powertools`
- Zip: use shared `powertoolsLayer`, do not bundle
