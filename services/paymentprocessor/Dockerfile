FROM python:3.11-slim

WORKDIR /app

COPY services/paymentprocessor/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/paymentprocessor .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
