FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.11

# Install system dependencies, then remove build tools after pip install to reduce image size
RUN yum -y install postgresql-devel gcc gcc-c++ libpq make

# Copy requirements.txt
COPY requirements.txt ${LAMBDA_TASK_ROOT}

# Install Python packages then remove build tools
RUN pip install --no-cache-dir -r requirements.txt && \
    yum remove -y gcc gcc-c++ make postgresql-devel && \
    yum clean all && \
    rm -rf /var/cache/yum

# Copy the source code
COPY src/ ${LAMBDA_TASK_ROOT}

# Set the CMD to your handler
CMD [ "main.handler" ]