FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.11

# Install system dependencies needed for native packages (psycopg2, PyMuPDF)
RUN yum -y install postgresql-devel gcc gcc-c++ libpq make

# Copy and install Python dependencies
COPY requirements.txt ${LAMBDA_TASK_ROOT}
RUN pip install --no-cache-dir -r requirements.txt && \
    yum remove -y gcc gcc-c++ make postgresql-devel && \
    yum clean all && \
    rm -rf /var/cache/yum

# Copy the source code
COPY . ${LAMBDA_TASK_ROOT}/multimodal_rag_v2/

CMD ["multimodal_rag_v2.ingestion.handler.handler"]
