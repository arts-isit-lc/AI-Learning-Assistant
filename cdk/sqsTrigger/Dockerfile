FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.12


# Copy requirements.txt
COPY requirements.txt ${LAMBDA_TASK_ROOT}

# Every dependency ships a manylinux wheel for AL2023 (glibc 2.34): no build toolchain.
RUN pip install --no-cache-dir -r requirements.txt

# Copy the source code
COPY src/ ${LAMBDA_TASK_ROOT}

# Set the CMD to your handler
CMD [ "main.handler" ]
