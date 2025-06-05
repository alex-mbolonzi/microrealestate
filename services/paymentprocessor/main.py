from fastapi import FastAPI, UploadFile, HTTPException, Form, File, Request, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, validator
from pydantic_settings import BaseSettings
from typing import List, Dict, Optional
import pandas as pd
from io import StringIO
import json
import httpx
import logging
import structlog
from datetime import datetime
from dateutil import parser
import os
from motor.motor_asyncio import AsyncIOMotorClient
from contextlib import asynccontextmanager
import asyncio
from functools import lru_cache


# Configuration
class Settings(BaseSettings):
    api_url: str
    gateway_url: str
    mongo_url: str
    payment_batch_size: int = 10
    http_timeout: float = 30.0
    allow_origins: List[str] = ["*"]

    class Config:
        env_file = ".env"


settings = Settings()


# Structured logging
def configure_logging():
    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer()
        ],
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    return structlog.get_logger()


logger = configure_logging()

# Application setup
app = FastAPI(title="Payment Processor Service")
router = APIRouter(
    prefix="/api/v2/paymentprocessor",
    tags=["payments"],
    responses={404: {"description": "Not found"}},
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# MongoDB connection pool
@asynccontextmanager
async def get_mongo_client():
    client = AsyncIOMotorClient(settings.mongo_url)
    try:
        yield client
    finally:
        client.close()


# Models
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

    @validator('payment_date')
    def validate_payment_date(cls, v):
        try:
            return parser.parse(v, dayfirst=True).strftime('%d/%m/%Y')
        except (ValueError, TypeError) as e:
            raise ValueError(f"Invalid date format: {v}. Please use DD/MM/YYYY format.")

    @validator('amount', 'promo_amount', 'extra_charge')
    def validate_amounts(cls, v):
        if v < 0:
            raise ValueError("Amount cannot be negative")
        return round(v, 2)


class PaymentResult(BaseModel):
    success: bool
    tenant_id: str
    message: str
    details: Dict = {}

async def parse_payment_date(date_str: str) -> str:
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


# Helpers
async def pad_tenant_id(tenant_id: str) -> str:
    return str(int(float(tenant_id))).strip().zfill(6)


@lru_cache(maxsize=1000)
def _get_tenant_cache_key(padded_reference: str, organization_id: str) -> str:
    return f"{organization_id}:{padded_reference}"


async def get_tenant_by_reference(padded_reference: str, headers: dict) -> Optional[Dict]:
    tenant_url = f"{settings.gateway_url}/api/v2/tenants?reference={padded_reference}"
    organization_id = headers.get('organizationId', 'N/A')

    logger.debug("Attempting to fetch tenant", url=tenant_url, reference=padded_reference,
                 organization_id=organization_id)

    try:
        response = await app.state.http_client.get(tenant_url, headers=headers)
        logger.debug("Tenant fetch response received", url=tenant_url, status_code=response.status_code)

        if response.status_code != 200:
            logger.warning("Tenant API returned non-200 status",
                           url=tenant_url,
                           status_code=response.status_code,
                           response_text=response.text[:500],  # Log up to 500 chars of response body
                           reference=padded_reference)
            return None

        tenant_data = response.json()
        if isinstance(tenant_data, list):
            found_tenant = next((t for t in tenant_data if str(t.get('reference', '')).strip() == padded_reference),
                                None)
            if not found_tenant:
                logger.warning("Tenant not found in list response from Gateway", url=tenant_url,
                               reference=padded_reference, response_data=tenant_data)
            return found_tenant

        if str(tenant_data.get('reference', '')).strip() == padded_reference:
            return tenant_data
        else:
            logger.warning("Tenant reference mismatch in single response from Gateway", url=tenant_url,
                           expected_ref=padded_reference, actual_ref=tenant_data.get('reference', 'N/A'))
            return None

    except httpx.TimeoutException as e:
        # Crucial: Log specific httpx timeout info
        logger.error("HTTP Timeout fetching tenant",
                     url=tenant_url, reference=padded_reference,
                     error_type=type(e).__name__,
                     error_message=str(e),
                     error_repr=repr(e),  # Log full representation for deep debug
                     exc_info=True)
        raise  # Re-raise to be caught by process_single_payment

    except httpx.RequestError as e:
        # Crucial: Log specific httpx request error info
        logger.error("HTTP Request Error fetching tenant (connection/DNS issue)",
                     url=tenant_url, reference=padded_reference,
                     error_type=type(e).__name__,
                     error_message=str(e),
                     error_repr=repr(e),
                     exc_info=True)
        raise  # Re-raise to be caught by process_single_payment

    except json.JSONDecodeError as e:  # Catch JSON decoding errors if response is not valid JSON
        logger.error("JSON decode error from Gateway response",
                     url=tenant_url, reference=padded_reference,
                     error_type=type(e).__name__,
                     error_message=str(e),
                     error_repr=repr(e),
                     response_text=response.text[:500] if 'response' in locals() else 'N/A',  # Check if response exists
                     exc_info=True)
        raise

    except Exception as e:
        logger.error("Unexpected error fetching tenant",
                     url=tenant_url, reference=padded_reference,
                     error_type=type(e).__name__,
                     error_message=str(e),
                     error_repr=repr(e),
                     exc_info=True)
        raise


async def log_pending_payment(tenant_id: str, payment_date: str, payment_type: str,
                              payment_reference: str, amount: float, narration: str):
    async with get_mongo_client() as client:
        db = client['bomatech']
        try:
            await db['pendingPayments'].insert_one({
                "tenantId": tenant_id,
                "paymentDate": payment_date,
                "paymentType": payment_type,
                "paymentReference": payment_reference,
                "amount": amount,
                "dateCreated": datetime.utcnow(),
                "dateUpdated": datetime.utcnow(),
                "narration": narration
            })
            logger.info("Pending payment logged", tenant_id=tenant_id)
        except Exception as e:
            logger.error("Failed to log pending payment", tenant_id=tenant_id, error=str(e))

async def check_payment_exists(payment_reference: str) -> bool:
    async with get_mongo_client() as client:
        db = client['bomatech']
        try:
            count = await db['occupants'].count_documents(
                {"rents.payments.reference": payment_reference}
            )
            return count > 0
        except Exception as e:
            logger.error("Error checking payment existence", reference=payment_reference, error=str(e))
            raise

# Core processing
async def process_single_payment(payment: Payment, term: str, organization_id: str,
                                 auth_token: str = None) -> PaymentResult:
    """Process a single payment by calling the rent API endpoint."""
    try:
        # Pad the tenant reference with leading zeros
        padded_reference = await pad_tenant_id(payment.tenant_id)
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
        # Using the http_client from app.state for consistency
        tenant_url = f"{settings.gateway_url}/api/v2/tenants?reference={padded_reference}"
        logger.debug(f"Looking up tenant with reference {padded_reference} at URL: {tenant_url}")

        tenant_response = await app.state.http_client.get(tenant_url, headers=headers)
        logger.debug(f"Tenant lookup response status: {tenant_response.status_code}")

        if tenant_response.status_code != 200:
            error_msg = f"Failed to find tenant with reference {padded_reference}: {tenant_response.text}"
            logger.error(error_msg)
            await log_pending_payment(
                tenant_id=payment.tenant_id,
                payment_date=payment.payment_date,
                payment_type=payment.payment_type,
                payment_reference=payment.reference,
                amount=payment.amount,
                narration=error_msg
            )
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
                log_pending_payment(
                    tenant_id=payment.tenant_id,
                    payment_date=payment.payment_date,
                    payment_type=payment.payment_type,
                    payment_reference=payment.reference,
                    amount=payment.amount,
                    narration=error_msg
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
                log_pending_payment(
                    tenant_id=payment.tenant_id,
                    payment_date=payment.payment_date,
                    payment_type=payment.payment_type,
                    payment_reference=payment.reference,
                    amount=payment.amount,
                    narration=error_msg
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
                log_pending_payment(
                    tenant_id=payment.tenant_id,
                    payment_date=payment.payment_date,
                    payment_type=payment.payment_type,
                    payment_reference=payment.reference,
                    amount=payment.amount,
                    narration=error_msg
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
            log_pending_payment(
                tenant_id=payment.tenant_id,
                payment_date=payment.payment_date,
                payment_type=payment.payment_type,
                payment_reference=payment.reference,
                amount=payment.amount,
                narration=error_msg
            )
            logger.error(error_msg)
            return PaymentResult(
                success=False,
                tenant_id=payment.tenant_id,
                message=error_msg
            )

        # Check if the tenant has previous payments (by looking at 'hasPayments' field or trying to fetch)
        has_payments = tenant.get("hasPayments", False)
        existing_payments = [] # Initialize as empty

        if has_payments: # Only fetch if 'hasPayments' is True in tenant data
            logger.debug(f"Tenant {tenant_id} has previous payments. Fetching payment history.")

            # Assuming term is in the format 'YYYY.MM'
            year, month = term.split('.')
            # Format to YYYYMMDDHH (e.g., 2025050100) as per your Gateway's expected format
            formatted_term_for_get = f"{year}{month.zfill(2)}0100"

            # Fetch existing payments for the tenant from Gateway
            get_payments_url = f"{settings.gateway_url}/api/v2/rents/tenant/{tenant_id}/{formatted_term_for_get}"

            payments_response = await app.state.http_client.get(get_payments_url, headers=headers)
            logger.debug(f"Payments lookup response status: {payments_response.status_code}")

            if payments_response.status_code != 200:
                # If fetching existing payments fails, log and proceed with new payment only
                # OR return failure if existing payments are mandatory.
                # For this flow, let's allow new payment to proceed, but log warning.
                # The Gateway's PATCH will handle the replacement logic.
                error_msg = f"Failed to fetch existing payments for tenant {tenant_id} and term {formatted_term_for_get}: {payments_response.text}"
                logger.warning(error_msg)
                # We don't return False here immediately as the PATCH might still succeed to create the term.
                # The log_pending_payment is also commented out based on your original snippet where it wasn't called here.
            else:
                existing_payments = payments_response.json().get('payments', [])
                if not existing_payments:
                    logger.info(f"No existing payments found for tenant {tenant_id} and term {term} despite hasPayments=True")
                logger.debug(f"Existing payments for tenant {tenant_id}: {json.dumps(existing_payments, indent=2)}")
        else:
            logger.debug(f"Tenant {tenant_id} has no previous payments. Starting with an empty payment history.")

        formatted_date = await parse_payment_date(payment.payment_date)

        new_payment = {
            "type": payment.payment_type.lower() if payment.payment_type else "cash",
            "date": formatted_date,
            "reference": payment.reference,
            "amount": float(payment.amount)
        }

        # Merge existing payments with the new payment.
        # This merged array will be sent to the Gateway for replacement.
        updated_payments = existing_payments + [new_payment]

        # Build the complete payload for the Gateway's PATCH endpoint
        payment_data_for_gateway = {
            "_id": tenant_id,
            "payments": updated_payments, # Send the entire merged array
            "description": payment.description or "",
            "promo": float(payment.promo_amount or 0),
            "notepromo": payment.promo_note if payment.promo_amount and payment.promo_amount > 0 else "",
            "extracharge": float(payment.extra_charge or 0),
            "noteextracharge": payment.extra_charge_note if payment.extra_charge and payment.extra_charge > 0 else "",
            "term": term # Send the original YYYY.MM term in the body as well
        }
        logger.debug(f"Payment data for Gateway for tenant {tenant_id}: {json.dumps(payment_data_for_gateway, indent=2)}")

        # Construct the URL for the Gateway's PATCH endpoint
        update_payments_url = f"{settings.gateway_url}/api/v2/rents/payment/{tenant_id}/{term}"

        # Send the PATCH request to the Gateway
        payment_response = await app.state.http_client.patch(
            update_payments_url,
            headers=headers,
            json=payment_data_for_gateway
        )
        logger.info(f"Payment response for tenant {tenant_id} - Status: {payment_response.status_code}")
        logger.info(f"Payment response body: {payment_response.text}")

        if payment_response.status_code != 200:
            error_msg = f"Failed to process payment for tenant {tenant_id} via Gateway: {payment_response.text}"
            logger.error(error_msg)
            # Log to pendingPayments if the payment fails
            log_pending_payment(
                tenant_id=payment.tenant_id,
                payment_date=payment.payment_date,
                payment_type=payment.payment_type,
                payment_reference=payment.reference,
                amount=payment.amount,
                narration=error_msg
            )
            return PaymentResult(
                success=False,
                tenant_id=tenant_id,
                message=error_msg
            )

        logger.info(f"Successfully processed payment for tenant {tenant_id} via Gateway.")
        return PaymentResult(
            success=True,
            tenant_id=tenant_id,
            message=f"Successfully processed payment for tenant {tenant_id}"
        )

    except httpx.TimeoutException as e:
        error_msg = f"HTTP Timeout during payment processing for tenant {payment.tenant_id}: {str(e)}"
        logger.error(error_msg, exc_info=True)
        log_pending_payment(
            tenant_id=payment.tenant_id,
            payment_date=payment.payment_date,
            payment_type=payment.payment_type,
            payment_reference=payment.reference,
            amount=payment.amount,
            narration=error_msg
        )
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_id,
            message=error_msg
        )
    except httpx.RequestError as e:
        error_msg = f"HTTP Request Error during payment processing for tenant {payment.tenant_id}: {str(e)}"
        logger.error(error_msg, exc_info=True)
        log_pending_payment(
            tenant_id=payment.tenant_id,
            payment_date=payment.payment_date,
            payment_type=payment.payment_type,
            payment_reference=payment.reference,
            amount=payment.amount,
            narration=error_msg
        )
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_id,
            message=error_msg
        )
    except json.JSONDecodeError as e:
        error_msg = f"JSON Decode Error from Gateway response for tenant {payment.tenant_id}: {str(e)}"
        logger.error(error_msg, exc_info=True)
        log_pending_payment(
            tenant_id=payment.tenant_id,
            payment_date=payment.payment_date,
            payment_type=payment.payment_type,
            payment_reference=payment.reference,
            amount=payment.amount,
            narration=error_msg
        )
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_id,
            message=error_msg
        )
    except Exception as e:
        error_msg = f"Unexpected error processing payment for tenant {payment.tenant_id}: {str(e)}"
        logger.error(error_msg, exc_info=True)
        log_pending_payment(
            tenant_id=payment.tenant_id,
            payment_date=payment.payment_date,
            payment_type=payment.payment_type,
            payment_reference=payment.reference,
            amount=payment.amount,
            narration=error_msg
        )
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_id,
            message=error_msg
        )

async def process_payments_batch(payments: List[Payment], term: str, organization_id: str, auth_token: str) -> List[PaymentResult]:

    return await asyncio.gather(
        *(process_single_payment(p, term, organization_id, auth_token) for p in payments),
        return_exceptions=True
    )


# Routes
@router.post("/process-payments")
async def process_payments(
        request: Request,
        file: UploadFile = File(...),
        term: str = Form(...)
):
    async def generate_events():
        try:
            # Read the entire file content first
            # Removed the incorrect 'async for chunk in file.stream()' loop
            contents = await file.read()
            df = pd.read_csv(StringIO(contents.decode()))

            # # Prepare headers
            # headers = {
            #     "Content-Type": "application/json",
            #     "Accept": "application/json",
            #     "organizationId": request.headers.get('organizationid'),
            #     "Authorization": request.headers.get('authorization', "")
            # }

            # Get organization ID from headers
            organization_id = request.headers.get('organizationid')
            auth_token = request.headers.get('authorization')

            all_payments: List[Payment] = []
            for _, row in df.iterrows():
                try:
                    payment = Payment(
                        tenant_id=str(row['tenant_id']).strip(),
                        payment_date=str(row['payment_date']).strip(),
                        payment_type=str(row['payment_type']).strip(),
                        reference=str(row['payment_reference']).strip(),
                        amount=float(row['amount']),
                        # description=str(row.get('description', '')).strip(),
                        # promo_amount=float(row.get('promo_amount', 0)),
                        # promo_note=str(row.get('promo_note', '')).strip(),
                        # extra_charge=float(row.get('extra_charge', 0)),
                        # extra_charge_note=str(row.get('extra_charge_note', '')).strip()
                    )
                    all_payments.append(payment)
                except Exception as e:
                    logger.warning("Skipping invalid row during parsing", row_data=row.to_dict(), error=str(e))
                    yield json.dumps({
                        "status": "skipped",
                        "message": f"Invalid row skipped: {str(e)}",
                        "details": row.to_dict()
                    }) + "\n\n"

            # Separate duplicates from new payments
            payments_to_process: List[Payment] = []
            skipped_duplicates: List[Dict] = []

            # Perform all duplicate checks concurrently
            duplicate_checks = [check_payment_exists(p.reference) for p in all_payments]
            duplicate_results = await asyncio.gather(*duplicate_checks)

            for i, payment in enumerate(all_payments):
                if duplicate_results[i]:
                    skip_message = f"Payment with reference '{payment.reference}' already exists."

                    skipped_duplicates.append({
                        "status": "skipped",
                        "message": f"Payment with reference '{payment.reference}' already exists.",
                        "tenant_id": payment.tenant_id
                    })

                    # Log to pendingPayments for duplicates
                    await log_pending_payment(
                        payment.tenant_id, payment.payment_date, payment.payment_type,
                        payment.reference, payment.amount, skip_message
                    )

                else:
                    payments_to_process.append(payment)

            # Yield skipped duplicates first
            for skipped in skipped_duplicates:
                yield json.dumps(skipped) + "\n\n"

            # Process new payments in batches
            total_to_process = len(payments_to_process)
            processed_count = 0
            batch_size = settings.payment_batch_size

            for i in range(0, total_to_process, batch_size):
                batch = payments_to_process[i:i + batch_size]

                results = await process_payments_batch(batch, term, organization_id, auth_token)
                processed_count += len(batch)

                # Collect successful results and errors for the current batch
                batch_successes = []
                batch_errors = []
                for r in results:
                    if isinstance(r, Exception):
                        batch_errors.append(str(r))
                    else:
                        batch_successes.append(r.dict())

                progress = min(100, int(processed_count / total_to_process * 100))
                yield json.dumps({
                    "status": "processing",
                    "progress": progress,
                    "results": batch_successes,
                    "errors": batch_errors
                }) + "\n\n"

            yield json.dumps({
                "status": "complete",
                "progress": 100,
                "message": "Processing completed"
            }) + "\n\n"

        except Exception as e:
            logger.error("Bulk processing failed", error=str(e))
            yield json.dumps({
                "status": "error",
                "message": str(e)
            }) + "\n\n"

    return StreamingResponse(generate_events(), media_type="text/event-stream")


# App lifecycle
@app.on_event("startup")
async def startup():
    app.state.http_client = httpx.AsyncClient(timeout=settings.http_timeout)
    logger.info("Service starting", config=settings.dict())


@app.on_event("shutdown")
async def shutdown():
    await app.state.http_client.aclose()
    logger.info("Service stopping")


# Mount router
app.include_router(router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)