# Payment Processor Service

A Python FastAPI microservice for processing bulk payment CSV files in the MicroRealEstate application.

## Features

- CSV file validation and processing
- Payment data validation with detailed error messages
- RESTful API endpoint for file upload
- Containerized service with FastAPI and pandas

## API Endpoint

### POST /process-payments/
Processes a CSV file containing payment information.

Required CSV columns:
- tenant_id: Tenant identifier
- payment_date: Payment date (MM/DD/YYYY format)
- payment_type: Type of payment (optional, defaults to 'cash')
- payment_reference: Payment reference number (optional)
- amount: Payment amount (must be positive)

Response format:
```json
[
  {
    "tenant_reference": "string",
    "payment_date": "YYYY-MM-DD",
    "payment_type": "string",
    "reference": "string",
    "amount": 0
  }
]
```

## Running Locally

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Run the service:
```bash
uvicorn main:app --host 0.0.0.0 --port 8001
```

The service will be available at http://localhost:8001

## Running with Docker

1. Build the image:
```bash
docker build -t payment-processor .
```

2. Run the container:
```bash
docker run -p 8001:8001 payment-processor
```

## API Documentation

When running locally, you can access:
- Swagger UI documentation at http://localhost:8001/docs
- OpenAPI specification at http://localhost:8001/openapi.json

## Testing

You can test the API using curl:
```bash
curl -X POST -F "file=@payments.csv" http://localhost:8001/process-payments/
```

Example CSV file format:
```csv
tenant_id,payment_date,payment_type,payment_reference,amount
T123,12/31/2023,bank_transfer,REF001,1000.00
T456,01/15/2024,cash,,500.50
