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
async def process_single_payment(payment: Payment, term: str, headers: dict) -> PaymentResult:
    padded_reference = ""
    try:
        padded_reference = await pad_tenant_id(payment.tenant_id)

        # 1. Get Tenant Information from Gateway
        tenant = await get_tenant_by_reference(padded_reference, headers)

        if not tenant:
            error_msg = f"Tenant not found for reference '{padded_reference}' via Gateway."
            logger.warning("Payment processing logical failure: Tenant not found",
                           tenant_id=payment.tenant_id, reference=payment.reference, message=error_msg)
            await log_pending_payment(
                payment.tenant_id, payment.payment_date, payment.payment_type,
                payment.reference, payment.amount, error_msg
            )
            return PaymentResult(success=False, tenant_id=payment.tenant_id, message=error_msg)

        tenant_id_from_gateway = tenant.get('_id')
        if not tenant_id_from_gateway:
            error_msg = f"Gateway returned tenant with reference '{padded_reference}' but no '_id' field."
            logger.warning("Payment processing logical failure: Tenant missing ID",
                           tenant_id=payment.tenant_id, reference=payment.reference, message=error_msg)
            await log_pending_payment(
                payment.tenant_id, payment.payment_date, payment.payment_type,
                payment.reference, payment.amount, error_msg
            )
            return PaymentResult(success=False, tenant_id=payment.tenant_id, message=error_msg)

        # 2. Record the Successful Payment in MongoDB
        # This is the crucial part that was likely missing or commented out!
        try:
            async with get_mongo_client() as client:
                db = client['bomatech']  # Or your actual database name
                occupants_collection = db['occupants']  # Or your actual collection name for tenants/occupants

                # Prepare the payment data to be inserted
                payment_data = payment.dict(exclude={'tenant_id'})  # Exclude tenant_id as it's the main doc ID

                # MongoDB update query: Find the occupant by _id, then find the specific rent term, and push the payment
                update_result = await occupants_collection.update_one(
                    {"_id": tenant_id_from_gateway, "rents.term": term},
                    {"$push": {"rents.$.payments": payment_data}},
                    upsert=False  # We assume the tenant and rent term already exist
                )

                if update_result.matched_count == 0:
                    # This means either the tenant_id_from_gateway was not found
                    # or the specific 'rents.term' was not found for that tenant.
                    error_msg = (
                        f"Payment {payment.reference} for tenant {padded_reference} (ID: {tenant_id_from_gateway}) "
                        f"could not be recorded. Tenant or rent term '{term}' not found in DB.")
                    logger.warning("Payment recording failed: Tenant or rent term not found",
                                   tenant_id=payment.tenant_id, reference=payment.reference, message=error_msg)
                    await log_pending_payment(
                        payment.tenant_id, payment.payment_date, payment.payment_type,
                        payment.reference, payment.amount, error_msg
                    )
                    return PaymentResult(success=False, tenant_id=payment.tenant_id, message=error_msg)

                if update_result.modified_count == 0:
                    # Matched but not modified could mean the payment already exists in the array
                    # or some other condition prevented modification.
                    warning_msg = (
                        f"Payment {payment.reference} for tenant {padded_reference} (ID: {tenant_id_from_gateway}) "
                        f"matched but was not modified. Possible duplicate or no change needed.")
                    logger.warning("Payment recording warning: Matched but not modified",
                                   tenant_id=payment.tenant_id, reference=payment.reference, message=warning_msg)
                    # For a robust system, you might want to return success=False or specific status here
                    # For now, we'll still consider it a success if matched (assuming it was already there)
                    # If this implies a real error (e.g. payment *must* be added), then return False.
                    # For now, let's treat it as a success if matched, assuming idempotent operation.
                    return PaymentResult(
                        success=True,
                        tenant_id=tenant_id_from_gateway,
                        message=f"Payment {payment.reference} processed successfully for tenant {padded_reference} (ID: {tenant_id_from_gateway}). Matched but not modified (possibly already existed)."
                    )

                logger.info("Payment successfully processed and recorded in MongoDB",
                            tenant_id=tenant_id_from_gateway,
                            reference=payment.reference,
                            matched_count=update_result.matched_count,
                            modified_count=update_result.modified_count)

        except Exception as e:
            # Catch any issues specific to the MongoDB update operation
            error_msg = f"MongoDB update failed for payment {payment.reference}: {str(e)}"
            logger.error("MongoDB payment recording error",
                         error_message=error_msg,
                         error_type=type(e).__name__,
                         error_repr=repr(e),
                         tenant_id=payment.tenant_id,
                         payment_reference=payment.reference,
                         exc_info=True)
            await log_pending_payment(
                payment.tenant_id, payment.payment_date, payment.payment_type,
                payment.reference, payment.amount, error_msg
            )
            return PaymentResult(success=False, tenant_id=payment.tenant_id, message=error_msg)

        # 3. Return Success Result
        return PaymentResult(
            success=True,
            tenant_id=tenant_id_from_gateway,
            message=f"Payment {payment.reference} processed and recorded successfully for tenant {padded_reference} (ID: {tenant_id_from_gateway})"
        )

    except Exception as e:
        # This catches exceptions from get_tenant_by_reference, pad_tenant_id, or other unhandled logic
        actual_error_message = str(e)
        if not actual_error_message:
            actual_error_message = f"Unhandled processing error (Type: {type(e).__name__}, Repr: {repr(e)})"

        logger.error("Payment processing error (caught in process_single_payment)",
                     error_message=actual_error_message,
                     error_type=type(e).__name__,
                     error_repr=repr(e),
                     tenant_id=payment.tenant_id,
                     payment_reference=payment.reference,
                     exc_info=True)

        await log_pending_payment(
            payment.tenant_id, payment.payment_date, payment.payment_type,
            payment.reference, payment.amount, actual_error_message
        )
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_id,
            message=actual_error_message
        )

async def process_payments_batch(payments: List[Payment], term: str, headers: dict):
    return await asyncio.gather(
        *(process_single_payment(p, term, headers) for p in payments),
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

            # Prepare headers
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "organizationId": request.headers.get('organizationid'),
                "Authorization": request.headers.get('authorization', "")
            }

            all_payments: List[Payment] = []
            for _, row in df.iterrows():
                try:
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

                results = await process_payments_batch(batch, term, headers)
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