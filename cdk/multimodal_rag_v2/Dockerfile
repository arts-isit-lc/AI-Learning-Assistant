FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.11

# Force rebuild: 2026-06-24
ENV REBUILD_MARKER=20260624d

# Install system dependencies needed for native packages (psycopg2, PyMuPDF).
# zlib/libjpeg headers: Pillow >= 12.3 has no AL2-compatible wheel and builds from source.
RUN yum -y install postgresql-devel gcc gcc-c++ libpq make zlib-devel libjpeg-turbo-devel

# Copy and install Python dependencies
COPY requirements.txt ${LAMBDA_TASK_ROOT}
RUN pip install --no-cache-dir -r requirements.txt && \
    yum remove -y gcc gcc-c++ make postgresql-devel zlib-devel libjpeg-turbo-devel && \
    yum clean all && \
    rm -rf /var/cache/yum

# Copy the source code
COPY . ${LAMBDA_TASK_ROOT}/multimodal_rag_v2/

CMD ["multimodal_rag_v2.ingestion.handler.handler"]
# rebuild 1782249798
