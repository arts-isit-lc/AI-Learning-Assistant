#!/bin/bash

# Build psycopg2 layer using Docker with Python 3.12 for x86_64 architecture
docker run --platform linux/amd64 --rm -v $(pwd):/workspace python:3.12-slim bash -c "
apt-get update && apt-get install -y zip && \
cd /workspace && \
rm -rf layers/temp && \
mkdir -p layers/temp/python/lib/python3.12/site-packages && \
pip install --target layers/temp/python/lib/python3.12/site-packages psycopg2-binary==2.9.11 && \
cd layers/temp && \
zip -r ../psycopg2-py312.zip python/ && \
cd .. && rm -rf temp
"

echo "psycopg2 layer built successfully for x86_64!"