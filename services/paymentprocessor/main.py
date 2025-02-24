from fastapi import FastAPI, UploadFile, HTTPException, Form, File, Request, Response
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
from io import StringIO
from typing import List, Dict
import json
import httpx
import logging
from starlette.responses import StreamingResponse
import os
from dateutil import parser
from datetime import datetime
from pydantic import BaseModel
import pymongo

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
# Get the MongoDB connection string from the environment variable
MONGO_URL = os.getenv('MONGO_URL', 'mongodb://localhost:27017')  # Default to localhost
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
    logger.debug(f"Incoming request: {request.method} {request.url}")
    logger.debug(f"Headers: {dict(request.headers)}")

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
    # Convert to integer first to remove any decimal points, then to string and pad
    return str(int(float(tenant_id))).strip().zfill(6)

def parse_payment_date(date_str: str) -> str:
    """
    Parse payment date from various formats and return in DD/MM/YYYY format.
    Handles common formats like DD/MM/YYYY, DD-MM-YYYY, etc.
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

def log_pending_payment(tenant_id, payment_date, payment_type, payment_reference, amount, narration):
    """
    Logs details of a failed payment attempt into the 'pendingPayments' collection.

    Args:
        tenant_id (str): Unique identifier for the tenant.
        payment_date (str): Date of the payment. Expected in "YYYY-MM-DD" format.
        payment_type (str): Type of payment (e.g., credit card, bank transfer, etc.).
        payment_reference (str): Unique reference for the payment.
        amount (float): Amount of payment.
        narration (str): Reason or details of why the payment failed.

    Returns:
        None
    """

    # Initialize MongoDB client using the connection string
    client = pymongo.MongoClient(MONGO_URL)

    # Select the database (replace 'database_name' with your actual database name)
    db = client['bomatech']

    try:
        # Define the document to be inserted
        pending_payment = {
            "tenantId": tenant_id,
            "paymentDate": payment_date,
            "paymentType": payment_type,
            "paymentReference": payment_reference,
            "amount": amount,
            "dateCreated": datetime.utcnow(),  # Automatically log creation date
            "dateUpdated": datetime.utcnow(),  # Automatically log the last update date
            "narration": narration
        }

        # Insert the document into the 'pendingPayments' collection
        db['pendingPayments'].insert_one(pending_payment)
        print(f"Pending payment logged successfully for tenantId: {tenant_id}")
    except Exception as e:
        # Log an error if the operation fails (logger is assumed to be defined)
        logger.error(f"Failed to log pending payment for tenantId: {tenant_id}. Error: {e}")


def check_payment_exists(payment_reference, db_name='bomatech', collection_name='occupants'):
    """
    Check if a payment with the given reference exists in the occupants collection.

    Args:
        payment_reference (str): The payment reference to check.
        db_name (str): The name of the MongoDB database. Defaults to 'bomatech'.
        collection_name (str): The name of the MongoDB collection. Defaults to 'occupants'.

    Returns:
        bool: True if the payment exists, False otherwise.
    """
    try:
        # Select the database and collection
        client = pymongo.MongoClient(MONGO_URL)
        collection = client[collection_name]

        # Define the filter to find the payment
        filter = {"rents.payments.reference": payment_reference}

        # Find the payment in the occupants collection
        payment = collection.find_one(filter)

        # Return True if the payment exists, False otherwise
        return payment is not None

    except PyMongoError as e:
        # Log the error and handle it appropriately
        logger.error(f"Error checking payment existence for reference {payment_reference}: {str(e)}")
        raise  # Re-raise the exception for the caller to handle

    except Exception as e:
        # Handle any other unexpected errors
        logger.error(f"Unexpected error in check_payment_exists: {str(e)}")
        raise

async def process_single_payment(payment: Payment, term: str, organization_id: str,
                                 auth_token: str = None) -> PaymentResult:
    """Process a single payment by calling the rent API endpoint."""
    try:
        # Pad the tenant reference with leading zeros
        padded_reference = pad_tenant_id(payment.tenant_id)
        logger.debug(f"Looking up tenant with reference: {padded_reference}")

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Language": "en",
            "organizationId": organization_id,
        }

        # Add authorization header if token is provided
        if auth_token:
            headers["Authorization"] = auth_token

        # Get tenant by reference number using the reference field
        tenant_url = f"{GATEWAY_URL}/api/v2/tenants?reference={padded_reference}"
        logger.debug(f"Looking up tenant with reference {padded_reference} at URL: {tenant_url}")

        # Use a separate client for tenant lookup
        async with httpx.AsyncClient(timeout=30.0) as lookup_client:
            tenant_response = await lookup_client.get(tenant_url, headers=headers)
            logger.debug(f"Tenant lookup response status: {tenant_response.status_code}")

            if tenant_response.status_code != 200:
                error_msg = f"Failed to find tenant with reference {padded_reference}: {tenant_response.text}"
                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_id,
                    message=error_msg
                )

            tenant_data = tenant_response.json()
            logger.debug(f"Raw tenant data: {json.dumps(tenant_data, indent=2)}")

            # Handle both list and single object responses
            if isinstance(tenant_data, list):
                if not tenant_data:
                    error_msg = f"No tenant found with reference {padded_reference}"

                    # Log to pendingPayments if the payment fails
                    log_pending_payment(
                        tenant_id=payment.tenant_id,
                        payment_date=payment.payment_date,
                        payment_type=payment.payment_type,
                        payment_reference=payment.reference,
                        amount=payment.amount,
                        narration=error_msg  # Explanation of failure
                    )

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

                    # Log to pendingPayments if the payment fails
                    log_pending_payment(
                        tenant_id=payment.tenant_id,
                        payment_date=payment.payment_date,
                        payment_type=payment.payment_type,
                        payment_reference=payment.reference,
                        amount=payment.amount,
                        narration=error_msg  # Explanation of failure
                    )

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

                    # Log to pendingPayments if the payment fails
                    log_pending_payment(
                        tenant_id=payment.tenant_id,
                        payment_date=payment.payment_date,
                        payment_type=payment.payment_type,
                        payment_reference=payment.reference,
                        amount=payment.amount,
                        narration=error_msg  # Explanation of failure
                    )

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

                # Log to pendingPayments if the payment fails
                log_pending_payment(
                    tenant_id=payment.tenant_id,
                    payment_date=payment.payment_date,
                    payment_type=payment.payment_type,
                    payment_reference=payment.reference,
                    amount=payment.amount,
                    narration=error_msg  # Explanation of failure
                )

                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_id,
                    message=error_msg
                )

            # Extract realmId from tenant data
            # realm_id = tenant.get('realmId')
            # if not realm_id:
            #     error_msg = f"Tenant data missing realmId field for reference {padded_reference}"
            #     logger.error(error_msg)
            #     return PaymentResult(
            #         success=False,
            #         tenant_id=payment.tenant_id,
            #         message=error_msg
            #     )
            #
            # logger.debug(
            #     f"Successfully found tenant. Reference: {padded_reference}, ID: {tenant_id}, Realm: {realm_id}")

            # Check if the tenant has previous payments
            has_payments = tenant.get("hasPayments", False)
            if has_payments:
                logger.debug(f"Tenant {tenant_id} has previous payments. Fetching payment history.")

                # Assuming term is in the format 'YYYY.MM'
                year, month = term.split('.')
                formatted_term = f"{year}{month.zfill(2)}0100"  # Format to YYYYMMDDHH

                # Fetch existing payments for the tenant
                get_payments_url = f"{GATEWAY_URL}/api/v2/rents/tenant/{tenant_id}/{formatted_term}"

                async with httpx.AsyncClient(timeout=30.0) as payments_client:
                    payments_response = await payments_client.get(get_payments_url, headers=headers)
                    logger.debug(f"Payments lookup response status: {payments_response.status_code}")

                    if payments_response.status_code != 200:
                        error_msg = f"Failed to fetch existing payments for tenant {tenant_id}: {payments_response.text}"

                        # Log to pendingPayments if the payment fails
                        log_pending_payment(
                            tenant_id=payment.tenant_id,
                            payment_date=payment.payment_date,
                            payment_type=payment.payment_type,
                            payment_reference=payment.reference,
                            amount=payment.amount,
                            narration=error_msg  # Explanation of failure
                        )

                        logger.error(error_msg)
                        return PaymentResult(
                            success=False,
                            tenant_id=tenant_id,
                            message=error_msg
                        )

                    logger.debug(f"Payments response : {payments_response.json()}")
                    existing_payments = payments_response.json().get('payments', [])
                    if not existing_payments:
                        logger.info(f"No existing payments found for tenant {tenant_id} and term {term}")
                        existing_payments = []  # Initialize as empty list

                    logger.debug(f"Existing payments for tenant {tenant_id}: {json.dumps(existing_payments, indent=2)}")
            else:
                logger.debug(f"Tenant {tenant_id} has no previous payments. Proceeding with new payment.")
                existing_payments = []

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
            "term": term  # Add formatted term to payment data
        }
        logger.debug(f"Payment data for tenant {tenant_id}: {json.dumps(payment_data, indent=2)}")

        update_payments_url = f"{GATEWAY_URL}/api/v2/rents/payment/{tenant_id}/{term}"

        # Use a separate client for payment request
        async with httpx.AsyncClient(timeout=30.0) as payment_client:
            payment_response = await payment_client.patch(update_payments_url, headers=headers, json=payment_data)
            logger.info(f"Payment response for tenant {tenant_id} - Status: {payment_response.status_code}")
            logger.info(f"Payment response body: {payment_response.text}")

            if payment_response.status_code != 200:
                error_msg = f"Failed to process payment for tenant {tenant_id}: {payment_response.text}"

                # Log to pendingPayments if the payment fails
                # log_pending_payment(
                #     tenant_id=payment.tenant_id,
                #     payment_date=payment.payment_date,
                #     payment_type=payment.payment_type,
                #     payment_reference=payment.reference,
                #     amount=payment.amount,
                #     narration=error_msg  # Explanation of failure
                # )

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

        # Log to pendingPayments if the payment fails
        log_pending_payment(
            tenant_id=payment.tenant_id,
            payment_date=payment.payment_date,
            payment_type=payment.payment_type,
            payment_reference=payment.reference,
            amount=payment.amount,
            narration=error_msg  # Explanation of failure
        )

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

            # Read the entire file into memory
            content = await file.read()
            total_size = len(content)
            yield f"data: {json.dumps(dict(status='uploading', progress=100, message='File uploaded successfully'))}\n\n"

            # Process the CSV content
            yield f"data: {json.dumps(dict(status='processing', progress=0, message='Processing CSV file...'))}\n\n"

            # Close the file to release resources
            await file.close()

            # Get organization ID from headers
            organization_id = request.headers.get('organizationid')
            auth_token = request.headers.get('authorization')

            csv_content = content.decode()
            df = pd.read_csv(StringIO(csv_content))
            logger.debug(f"DataFrame content:\n{df}")

            # Clear the file content from memory
            del content
            # Clear the decoded CSV content from memory (no longer needed)
            del csv_content

            # Validate required columns
            required_columns = {"tenant_id", "payment_date", "payment_type", "payment_reference", "amount"}
            if not required_columns.issubset(df.columns):
                error_msg = f"CSV file is missing required columns: {required_columns - set(df.columns)}"
                logger.error(error_msg)
                yield f"data: {json.dumps(dict(status='error', message=error_msg))}\n\n"
                return

            total_payments = len(df)
            update_interval = max(1, total_payments // 10)  # Send updates every 10% progress
            successful_payments = 0
            results = []

            for index, row in df.iterrows():
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

                    # Check if the payment exists in the occupants collection if it exists, skip the payment
                    if await check_payment_exists(payment.reference):
                        error_msg = f"Payment with reference {payment.reference} already exists in the database"
                        logger.error(error_msg)
                        results.append(PaymentResult(
                            success=False,
                            tenant_id=str(row.get('tenant_id', '')),
                            message=error_msg
                        ))

                        log_pending_payment(
                            tenant_id=payment.tenant_id,
                            payment_date=payment.payment_date,
                            payment_type=payment.payment_type,
                            payment_reference=payment.reference,
                            amount=payment.amount,
                            narration=error_msg  # Explanation of failure
                        )

                        yield f"data: {json.dumps(dict(status='error', message=error_msg))}\n\n"
                        continue

                    # Process the payment
                    result = await process_single_payment(payment, term, organization_id, auth_token)
                    if result.success:
                        successful_payments += 1
                    results.append(result)

                    # Send progress update
                    if (index + 1) % update_interval == 0 or (index + 1) == total_payments:
                        progress = int(((index + 1) / total_payments) * 100)
                        yield f"data: {json.dumps(dict(status='processing', progress=progress, message=f'Processing payments... {progress}% ({index + 1}/{total_payments})', current_result=result.dict()))}\n\n"

                except Exception as e:
                    error_msg = f"Error processing payment {index + 1}: {str(e)}"

                    # Log to pendingPayments if the payment fails
                    log_pending_payment(
                        tenant_id=payment.tenant_id,
                        payment_date=payment.payment_date,
                        payment_type=payment.payment_type,
                        payment_reference=payment.reference,
                        amount=payment.amount,
                        narration=error_msg  # Explanation of failure
                    )

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

            # Log to pendingPayments if the payment fails
            log_pending_payment(
                tenant_id=0,
                payment_date=datetime.utcnow(),
                payment_type='',
                payment_reference=0,
                amount=0,
                narration=error_msg  # Explanation of failure
            )

            logger.error(error_msg)
            yield f"data: {json.dumps(dict(status='error', message=error_msg, error=str(e)))}\n\n"

    return StreamingResponse(
        process_payments_generator(),
        media_type="text/event-stream"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
