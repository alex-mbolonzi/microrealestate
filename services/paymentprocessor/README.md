# Payment Processor Service

A Python-based microservice for processing payment CSV files in the MicroRealEstate application.

## Features

- CSV file validation and processing
- Payment data validation
- RESTful API endpoint for file upload
- Containerized service

## API Endpoints

### POST /process-payments/
Processes a CSV file containing payment information.

Required CSV columns:
- tenant_id: Tenant identifier
- payment_date: Payment date (MM/DD/YYYY format)
- payment_type: Type of payment (optional, defaults to 'cash')
- payment_reference: Payment reference number (optional)
- amount: Payment amount (must be positive)

## Running Locally

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Run the service:
```bash
python main.py
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

## Testing

You can test the API using curl:
```bash
curl -X POST -F "file=@payments.csv" http://localhost:8001/process-payments/
```

Or use the Swagger UI at http://localhost:8001/docs
