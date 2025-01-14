FROM python:3.11-slim

WORKDIR /app

# Install required system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    python3-dev \
    libpq-dev \
    build-essential && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY services/paymentprocessor/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/paymentprocessor .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
