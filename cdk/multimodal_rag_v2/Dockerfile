FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.12

# Force rebuild: 2026-06-24
ENV REBUILD_MARKER=20260624d

# Copy and install Python dependencies
COPY requirements.txt ${LAMBDA_TASK_ROOT}
# Every dependency ships a manylinux wheel for AL2023 (glibc 2.34): no build toolchain.
RUN pip install --no-cache-dir -r requirements.txt

# Copy the source code
COPY . ${LAMBDA_TASK_ROOT}/multimodal_rag_v2/

CMD ["multimodal_rag_v2.ingestion.handler.handler"]
# rebuild 1782249798
