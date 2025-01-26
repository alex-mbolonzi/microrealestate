from fastapi import FastAPI, UploadFile, HTTPException, Form, File, Request, Response
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
from io import StringIO
from typing import List, Dict
import json
import httpx
import logging
from datetime import datetime
import asyncio
from starlette.responses import StreamingResponse
import os
from dateutil import parser
from pydantic import BaseModel

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,  # Set to DEBUG for more detailed logs
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%S'
)
logger = logging.getLogger(__name__)

# Add console handler to ensure logs are printed to stdout
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.DEBUG)
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)

# Log startup message
logger.info("Payment Processor Service starting up...")

# API configuration
API_BASE_URL = os.getenv('API_BASE_URL', 'http://api:8200')
GATEWAY_URL = os.getenv('GATEWAY_URL', 'http://gateway:80')
logger.info(f"API Base URL: {API_BASE_URL}")

app = FastAPI(title="Payment Processor Service")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, this should be configured via environment variable
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"]
)

# Add logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    logger.info(f"Incoming request: {request.method} {request.url}")
    logger.info(f"Headers: {dict(request.headers)}")

    # Convert the request's path to modify the URL
    modified_url_path = request.url.path.replace(
        "/api/v2/paymentprocessor/process-payments", "/process-payments"
    )

    # If the URL needs modification
    if request.url.path == "/api/v2/paymentprocessor/process-payments":
        # Create a new scope with the modified path
        request.scope["path"] = modified_url_path

    response = await call_next(request)
    logger.info(f"Response status: {response.status_code}")
    return response

class Payment(BaseModel):
    tenant_id: str
    payment_date: str
    payment_type: str
    reference: str
    amount: float
    description: str = ""
    promo_amount: float = 0
    promo_note: str = ""
    extra_charge: float = 0
    extra_charge_note: str = ""

class PaymentResult(BaseModel):
    success: bool
    tenant_id: str
    message: str
    details: Dict = {}

def pad_tenant_id(tenant_id: str) -> str:
    """Pad tenant_id with leading zeros to ensure it's six digits"""
    return str(tenant_id).strip().zfill(6)

def parse_payment_date(date_str: str) -> str:
    """
    Parse payment date from various formats and return in MM/DD/YYYY format.
    Handles common formats like DD/MM/YYYY, MM/DD/YYYY, etc.
    """
    try:
        # Parse the date string
        parsed_date = parser.parse(date_str, dayfirst=True)  # Assume DD/MM/YYYY format if ambiguous
        # Return in DD/MM/YYYY format
        return parsed_date.strftime('%d/%m/%Y')
    except (ValueError, TypeError) as e:
        logger.error(f"Error parsing date {date_str}: {str(e)}")
        raise ValueError(f"Invalid date format: {date_str}. Please use DD/MM/YYYY format.")

# Constants for frequency
PAYMENT_FREQUENCY = 'months'  # Monthly payments are standard for rental contracts

async def process_single_payment(payment: Payment, term: str, organization_id: str, auth_token: str = None) -> PaymentResult:
    """Process a single payment by calling the rent API endpoint."""
    try:
        # Pad the tenant reference with leading zeros
        padded_reference = pad_tenant_id(payment.tenant_id)
        logger.debug(f"Looking up tenant with reference: {padded_reference}")

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "organizationId": organization_id,
        }
        
        # Add authorization header if token is provided
        if auth_token:
            headers["Authorization"] = auth_token

        # Get tenant by reference number using the reference field
        tenant_url = f"{GATEWAY_URL}/api/v2/tenants?reference={padded_reference}"
        logger.info(f"Looking up tenant with reference {padded_reference} at URL: {tenant_url}")
        
        # Use a separate client for tenant lookup
        async with httpx.AsyncClient(timeout=30.0) as lookup_client:
            tenant_response = await lookup_client.get(tenant_url, headers=headers)
            logger.info(f"Tenant lookup response status: {tenant_response.status_code}")
            
            if tenant_response.status_code != 200:
                error_msg = f"Failed to find tenant with reference {padded_reference}: {tenant_response.text}"
                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_id,
                    message=error_msg
                )
            
            tenant_data = tenant_response.json()
            logger.info(f"Raw tenant data: {json.dumps(tenant_data, indent=2)}")
            
            # Handle both list and single object responses
            if isinstance(tenant_data, list):
                if not tenant_data:
                    error_msg = f"No tenant found with reference {padded_reference}"
                    logger.error(error_msg)
                    return PaymentResult(
                        success=False,
                        tenant_id=payment.tenant_id,
                        message=error_msg
                    )
                # Find the tenant with matching reference
                tenant = None
                for t in tenant_data:
                    if str(t.get('reference', '')).strip() == padded_reference:
                        tenant = t
                        break
                if not tenant:
                    error_msg = f"No tenant found with exact reference {padded_reference}"
                    logger.error(error_msg)
                    return PaymentResult(
                        success=False,
                        tenant_id=payment.tenant_id,
                        message=error_msg
                    )
            else:
                # Verify the reference matches
                if str(tenant_data.get('reference', '')).strip() != padded_reference:
                    error_msg = f"Tenant reference mismatch. Expected {padded_reference}, got {tenant_data.get('reference', '')}"
                    logger.error(error_msg)
                    return PaymentResult(
                        success=False,
                        tenant_id=payment.tenant_id,
                        message=error_msg
                    )
                tenant = tenant_data
            
            tenant_id = tenant.get('_id')
            if not tenant_id:
                error_msg = f"Tenant data missing _id field for reference {padded_reference}"
                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_id,
                    message=error_msg
                )

            logger.info(f"Successfully found tenant. Reference: {padded_reference}, ID: {tenant_id}")

        # Fetch existing payments for the tenant
        payments_url = f"{GATEWAY_URL}/api/v2/rents/tenant/{tenant_id}/{term}"
        async with httpx.AsyncClient(timeout=30.0) as payments_client:
            payments_response = await payments_client.get(payments_url, headers=headers)
            logger.info(f"Payments lookup response status: {payments_response.status_code}")

            if payments_response.status_code != 200:
                error_msg = f"Failed to fetch existing payments for tenant {tenant_id}: {payments_response.text}"
                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=tenant_id,
                    message=error_msg
                )

            existing_payments = payments_response.json().get('payments', [])
            logger.info(f"Existing payments for tenant {tenant_id}: {json.dumps(existing_payments, indent=2)}")

        # Parse the term string (YYYY.MM) into the correct format (YYYYMMDDHH)
        year, month = term.split('.')
        formatted_term = f"{year}{month:02}0100"  # Set day to 01 and hour to 00

        # Format the new payment
        formatted_date = parse_payment_date(payment.payment_date)
        new_payment = {
            "type": payment.payment_type.lower() if payment.payment_type else "cash",
            "date": formatted_date,
            "reference": payment.reference,
            "amount": float(payment.amount)  # Ensure amount is float
        }

        # Merge existing payments with the new payment
        updated_payments = existing_payments + [new_payment]

        # Build the payment data
        payment_data = {
            "_id": tenant_id,  # Include tenant ID in payment data
            "payments": updated_payments,  # Send the entire payments array
            "description": payment.description or "",  # Ensure empty string if None
            "promo": float(payment.promo_amount or 0),  # Ensure float and default to 0
            "notepromo": payment.promo_note if payment.promo_amount and payment.promo_amount > 0 else "",
            "extracharge": float(payment.extra_charge or 0),  # Ensure float and default to 0
            "noteextracharge": payment.extra_charge_note if payment.extra_charge and payment.extra_charge > 0 else "",
            "term": formatted_term  # Add formatted term to payment data
        }
        logger.info(f"Payment data for tenant {tenant_id}: {json.dumps(payment_data, indent=2)}")

        # Use a separate client for payment request
        async with httpx.AsyncClient(timeout=30.0) as payment_client:
            payment_response = await payment_client.patch(payments_url, headers=headers, json=payment_data)
            logger.info(f"Payment response for tenant {tenant_id} - Status: {payment_response.status_code}")
            logger.info(f"Payment response body: {payment_response.text}")

            if payment_response.status_code != 200:
                error_msg = f"Failed to process payment for tenant {tenant_id}: {payment_response.text}"
                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=tenant_id,
                    message=error_msg
                )

            logger.info(f"Successfully processed payment for tenant {tenant_id}")
            return PaymentResult(
                success=True,
                tenant_id=tenant_id,
                message=f"Successfully processed payment for tenant {tenant_id}"
            )

    except Exception as e:
        error_msg = f"Error processing payment: {str(e)}"
        logger.error(error_msg)
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_id,
            message=error_msg
        )


@app.post("/process-payments")
async def process_payments(
        request: Request,
        file: UploadFile = File(...),
        term: str = Form(...)
):
    """Process bulk payments from a CSV file with progress tracking"""

    async def process_payments_generator():
        try:
            logger.info(f"Starting bulk payment processing for term: {term}")

            # Read the CSV file content in chunks
            chunk_size = 8192  # 8KB chunks
            content = bytearray()
            total_size = 0

            # First pass: get total size
            chunk = await file.read(chunk_size)
            while chunk:
                total_size += len(chunk)
                content.extend(chunk)
                chunk = await file.read(chunk_size)

            # Reset file pointer
            await file.seek(0)
            content.clear()  # Clear content to start fresh
            logger.info("File pointer reset for second pass.")

            # Send initial progress
            yield f"data: {json.dumps(dict(status='uploading', progress=0, message='Starting file upload...'))}\n\n"

            # Second pass: actual processing with progress
            bytes_read = 0
            chunk = await file.read(chunk_size)
            while chunk:
                content.extend(chunk)
                bytes_read += len(chunk)
                progress = int((bytes_read / total_size) * 100)

                yield f"data: {json.dumps(dict(status='uploading', progress=progress, message=f'Uploading file... {progress}%'))}\n\n"

                chunk = await file.read(chunk_size)

            # File is uploaded, now process it
            yield f"data: {json.dumps(dict(status='processing', progress=0, message='Processing CSV file...'))}\n\n"

            csv_content = content.decode()

            # Get organization ID from headers
            organization_id = request.headers.get('organizationid')
            auth_token = request.headers.get('authorization')

            # Read CSV into pandas DataFrame
            df = pd.read_csv(StringIO(csv_content))
            logger.info(f"DataFrame content:\n{df}")  # Log DataFrame content

            total_payments = len(df)
            logger.info(f"Total payments to process: {total_payments}")

            # Initialize results list
            results = []
            successful_payments = 0

            # Process each payment with progress updates
            for index, row in df.iterrows():
                logger.info(f"Processing row {index + 1}: {row}")  # Log each row
                try:
                    # Create payment object
                    payment = Payment(
                        tenant_id=str(row['tenant_id']).strip(),
                        payment_date=str(row['payment_date']).strip(),
                        payment_type=str(row['payment_type']).strip(),
                        reference=str(row['payment_reference']).strip(),
                        amount=float(row['amount']),
                        description=str(row.get('description', '')).strip(),
                        promo_amount=float(row.get('promo_amount', 0)),
                        promo_note=str(row.get('promo_note', '')).strip(),
                        extra_charge=float(row.get('extra_charge', 0)),
                        extra_charge_note=str(row.get('extra_charge_note', '')).strip()
                    )

                    # Process the payment
                    result = await process_single_payment(payment, term, organization_id, auth_token)
                    if result.success:
                        successful_payments += 1
                    results.append(result)

                    # Send progress update
                    progress = int(((index + 1) / total_payments) * 100)
                    yield f"data: {json.dumps(dict(status='processing', progress=progress, message=f'Processing payments... {progress}% ({index + 1}/{total_payments})', current_result=result.dict()))}\n\n"

                except Exception as e:
                    error_msg = f"Error processing payment {index + 1}: {str(e)}"
                    logger.error(error_msg)
                    results.append(PaymentResult(
                        success=False,
                        tenant_id=str(row.get('tenant_id', '')),
                        message=f"Failed to process payment: {str(e)}",
                        details={"error": str(e)}
                    ))

                    yield f"data: {json.dumps(dict(status='error', message=error_msg, error=str(e)))}\n\n"

            # Send final results
            yield f"data: {json.dumps(dict(status='complete', progress=100, message=f'Processing complete. {successful_payments}/{total_payments} payments successful.', results=[result.dict() for result in results]))}\n\n"

        except Exception as e:
            error_msg = f"Error in bulk payment processing: {str(e)}"
            logger.error(error_msg)
            yield f"data: {json.dumps(dict(status='error', message=error_msg, error=str(e)))}\n\n"

    return StreamingResponse(
        process_payments_generator(),
        media_type="text/event-stream"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
