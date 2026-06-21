FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.11

RUN yum -y install postgresql-devel gcc gcc-c++ make

COPY requirements.txt ${LAMBDA_TASK_ROOT}

RUN pip install --no-cache-dir -r requirements.txt && \
    yum remove -y gcc gcc-c++ make postgresql-devel && \
    yum clean all && \
    rm -rf /var/cache/yum

COPY src/ ${LAMBDA_TASK_ROOT}

CMD [ "main.handler" ]
