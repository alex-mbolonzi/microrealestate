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
from datetime import datetime, timedelta
from dateutil import parser
import os
from motor.motor_asyncio import AsyncIOMotorClient
from contextlib import asynccontextmanager
import asyncio
from functools import lru_cache
import redis.asyncio as redis
from redis.asyncio.connection import ConnectionPool


# Configuration
class Settings(BaseSettings):
    api_url: str
    gateway_url: str
    mongo_url: str
    redis_url: str = "redis://localhost:6379"  # Added Redis URL
    redis_password: str = None
    payment_batch_size: int = 10
    http_timeout: float = 30.0
    allow_origins: List[str] = ["*"]
    tenant_cache_ttl: int = 3600  # 1 hour TTL for tenant cache
    payment_check_cache_ttl: int = 86400  # 24 hours TTL for payment existence checks

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

# Redis connection pool
redis_pool: ConnectionPool = None


async def get_redis() -> redis.Redis:
    """Get a Redis connection from the pool"""
    return redis.Redis(connection_pool=redis_pool)


# MongoDB connection pool
@asynccontextmanager
async def get_mongo_client():
    client = AsyncIOMotorClient(settings.mongo_url)
    try:
        yield client
    finally:
        client.close()


# Models (unchanged)
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
        parsed_date = parser.parse(date_str, dayfirst=True)
        return parsed_date.strftime('%d/%m/%Y')
    except (ValueError, TypeError) as e:
        logger.error(f"Error parsing date {date_str}: {str(e)}")
        raise ValueError(f"Invalid date format: {date_str}. Please use DD/MM/YYYY format.")


# Helpers with Redis integration
async def pad_tenant_id(tenant_id: str) -> str:
    return str(int(float(tenant_id))).strip().zfill(6)


def _get_tenant_cache_key(padded_reference: str, organization_id: str) -> str:
    return f"tenant:{organization_id}:{padded_reference}"


async def get_tenant_by_reference(padded_reference: str, headers: dict) -> Optional[Dict]:
    """Get tenant by reference with Redis caching"""
    organization_id = headers.get('organizationId', 'N/A')
    redis_client = await get_redis()
    cache_key = _get_tenant_cache_key(padded_reference, organization_id)

    # Try to get from cache first
    try:
        cached_tenant = await redis_client.get(cache_key)
        if cached_tenant:
            logger.debug("Retrieved tenant from cache", reference=padded_reference)
            return json.loads(cached_tenant)
    except Exception as e:
        logger.warning("Redis cache read failed, falling back to API", error=str(e))

    # Cache miss or error - fetch from API
    tenant_url = f"{settings.gateway_url}/api/v2/tenants?reference={padded_reference}"
    logger.debug("Attempting to fetch tenant", url=tenant_url, reference=padded_reference)

    try:
        response = await app.state.http_client.get(tenant_url, headers=headers)
        logger.debug("Tenant fetch response received", url=tenant_url, status_code=response.status_code)

        if response.status_code != 200:
            logger.warning("Tenant API returned non-200 status",
                           url=tenant_url,
                           status_code=response.status_code,
                           response_text=response.text[:500],
                           reference=padded_reference)
            return None

        tenant_data = response.json()
        found_tenant = None

        if isinstance(tenant_data, list):
            found_tenant = next((t for t in tenant_data if str(t.get('reference', '')).strip() == padded_reference),
                                None)
            if not found_tenant:
                logger.warning("Tenant not found in list response from Gateway",
                               url=tenant_url, reference=padded_reference)
        else:
            if str(tenant_data.get('reference', '')).strip() == padded_reference:
                found_tenant = tenant_data
            else:
                logger.warning("Tenant reference mismatch in single response from Gateway",
                               url=tenant_url, expected_ref=padded_reference)

        # Cache the result if found
        if found_tenant:
            try:
                await redis_client.setex(
                    cache_key,
                    timedelta(seconds=settings.tenant_cache_ttl),
                    json.dumps(found_tenant)
                )
                logger.debug("Cached tenant data", reference=padded_reference)
            except Exception as e:
                logger.warning("Failed to cache tenant data", error=str(e))

        return found_tenant

    except httpx.TimeoutException as e:
        logger.error("HTTP Timeout fetching tenant",
                     url=tenant_url, reference=padded_reference,
                     error_type=type(e).__name__,
                     error_message=str(e),
                     exc_info=True)
        raise
    except Exception as e:
        logger.error("Unexpected error fetching tenant",
                     url=tenant_url, reference=padded_reference,
                     error_type=type(e).__name__,
                     error_message=str(e),
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


def _get_payment_check_cache_key(payment_reference: str) -> str:
    return f"payment_exists:{payment_reference}"


async def check_payment_exists(payment_reference: str) -> bool:
    """Check if payment exists with Redis caching"""
    redis_client = await get_redis()
    cache_key = _get_payment_check_cache_key(payment_reference)

    # Try to get from cache first
    try:
        cached_result = await redis_client.get(cache_key)
        if cached_result:
            logger.info("Retrieved payment check from cache", reference=payment_reference)
            return json.loads(cached_result)
    except Exception as e:
        logger.info("Redis cache read failed, falling back to DB", error=str(e))

    # Cache miss or error - check MongoDB
    async with get_mongo_client() as client:
        db = client['bomatech']
        try:
            count = await db['occupants'].count_documents(
                {"rents.payments.reference": payment_reference}
            )
            exists = count > 0

            # Cache the result
            try:
                await redis_client.setex(
                    cache_key,
                    timedelta(seconds=settings.payment_check_cache_ttl),
                    json.dumps(exists)
                )
                logger.info("Cached payment check result", reference=payment_reference)
            except Exception as e:
                logger.info("Failed to cache payment check result", error=str(e))

            return exists

        except Exception as e:
            logger.info("Error checking payment existence", reference=payment_reference, error=str(e))
            raise


# Core processing with Redis optimizations
async def process_single_payment(payment: Payment, term: str, organization_id: str,
                                 auth_token: str = None) -> PaymentResult:
    """Process a single payment with Redis caching optimizations"""
    try:
        padded_reference = await pad_tenant_id(payment.tenant_id)
        logger.debug(f"Looking up tenant with reference: {padded_reference}")

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Language": "en",
            "organizationId": organization_id,
        }

        if auth_token:
            headers["Authorization"] = auth_token

        # Get tenant by reference (uses Redis caching)
        tenant = await get_tenant_by_reference(padded_reference, headers)
        if not tenant:
            error_msg = f"No tenant found with reference {padded_reference}"
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

        tenant_id = tenant.get('_id')
        if not tenant_id:
            error_msg = f"Tenant data missing _id field for reference {padded_reference}"
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

        has_payments = tenant.get("hasPayments", False)
        existing_payments = []

        if has_payments:
            logger.debug(f"Tenant {tenant_id} has previous payments. Fetching payment history.")
            year, month = term.split('.')
            formatted_term_for_get = f"{year}{month.zfill(2)}0100"

            get_payments_url = f"{settings.gateway_url}/api/v2/rents/tenant/{tenant_id}/{formatted_term_for_get}"
            payments_response = await app.state.http_client.get(get_payments_url, headers=headers)
            logger.debug(f"Payments lookup response status: {payments_response.status_code}")

            if payments_response.status_code == 200:
                existing_payments = payments_response.json().get('payments', [])
                logger.debug(f"Existing payments for tenant {tenant_id}: {json.dumps(existing_payments, indent=2)}")

        formatted_date = await parse_payment_date(payment.payment_date)

        new_payment = {
            "type": payment.payment_type.lower() if payment.payment_type else "cash",
            "date": formatted_date,
            "reference": payment.reference,
            "amount": float(payment.amount)
        }

        updated_payments = existing_payments + [new_payment]

        payment_data_for_gateway = {
            "_id": tenant_id,
            "payments": updated_payments,
            "description": payment.description or "",
            "promo": float(payment.promo_amount or 0),
            "notepromo": payment.promo_note if payment.promo_amount and payment.promo_amount > 0 else "",
            "extracharge": float(payment.extra_charge or 0),
            "noteextracharge": payment.extra_charge_note if payment.extra_charge and payment.extra_charge > 0 else "",
            "term": term
        }
        logger.info(
            f"Payment data for Gateway for tenant {tenant_id}: {json.dumps(payment_data_for_gateway, indent=2)}")

        update_payments_url = f"{settings.gateway_url}/api/v2/rents/payment/{tenant_id}/{term}"

        payment_response = await app.state.http_client.patch(
            update_payments_url,
            headers=headers,
            json=payment_data_for_gateway
        )
        logger.info(f"Payment response for tenant {tenant_id} - Status: {payment_response.status_code}")

        successful_status_codes = [200, 202, 204, 201]

        if payment_response.status_code not in successful_status_codes:
            error_msg = f"Failed to process payment for tenant {tenant_id} via Gateway: {payment_response.text}"
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
                tenant_id=tenant_id,
                message=error_msg
            )

        logger.info(f"Successfully processed payment for tenant {tenant_id} via Gateway.")

        # --- ADD THIS BLOCK TO INVALIDATE THE CACHE ---
        try:
            redis_client = await get_redis()
            cache_key_payment_exists = _get_payment_check_cache_key(payment.reference)
            await redis_client.delete(cache_key_payment_exists)
            logger.debug("Invalidated payment existence cache after successful processing", reference=payment.reference)
        except Exception as e:
            logger.warning("Failed to invalidate payment existence cache", reference=payment.reference, error=str(e))
        # --- END ADDITION ---

        return PaymentResult(
            success=True,
            tenant_id=tenant_id,
            message=f"Successfully processed payment for tenant {tenant_id}"
        )

    except httpx.TimeoutException as e:
        error_msg = f"HTTP Timeout during payment processing for tenant {payment.tenant_id}: {str(e)}"
        logger.error(error_msg, exc_info=True)
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
    except Exception as e:
        error_msg = f"Unexpected error processing payment for tenant {payment.tenant_id}: {str(e)}"
        logger.error(error_msg, exc_info=True)
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


async def process_payments_batch(payments: List[Payment], term: str, organization_id: str, auth_token: str) -> List[
    PaymentResult]:
    return await asyncio.gather(
        *(process_single_payment(p, term, organization_id, auth_token) for p in payments),
        return_exceptions=True
    )


# Routes (unchanged)
@router.post("/process-payments")
async def process_payments(
        request: Request,
        file: UploadFile = File(...),
        term: str = Form(...)
):
    async def generate_events():
        try:
            contents = await file.read()
            df = pd.read_csv(StringIO(contents.decode()))

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
                    )
                    all_payments.append(payment)
                except Exception as e:
                    logger.warning("Skipping invalid row during parsing", row_data=row.to_dict(), error=str(e))
                    yield json.dumps({
                        "status": "skipped",
                        "message": f"Invalid row skipped: {str(e)}",
                        "details": row.to_dict()
                    }) + "\n\n"

            payments_to_process: List[Payment] = []
            skipped_duplicates: List[Dict] = []

            duplicate_checks = [check_payment_exists(p.reference) for p in all_payments]
            duplicate_results = await asyncio.gather(*duplicate_checks)

            for i, payment in enumerate(all_payments):
                if duplicate_results[i]:
                    skip_message = f"Payment with reference '{payment.reference}' already exists."
                    skipped_duplicates.append({
                        "status": "skipped",
                        "message": skip_message,
                        "tenant_id": payment.tenant_id
                    })
                    await log_pending_payment(
                        payment.tenant_id, payment.payment_date, payment.payment_type,
                        payment.reference, payment.amount, skip_message
                    )
                else:
                    payments_to_process.append(payment)

            for skipped in skipped_duplicates:
                yield json.dumps(skipped) + "\n\n"

            # Group payments by tenant_id for sequential processing per tenant
            payments_by_tenant: Dict[str, List[Payment]] = {}
            for payment in payments_to_process:
                if payment.tenant_id not in payments_by_tenant:
                    payments_by_tenant[payment.tenant_id] = []
                payments_by_tenant[payment.tenant_id].append(payment)

            total_payments_for_progress = len(payments_to_process) # Total individual payments to track progress against
            processed_payments_count = 0 # Accumulate processed payments across all batches
            
            tenant_ids_to_process = list(payments_by_tenant.keys())
            total_unique_tenants = len(tenant_ids_to_process)

            # This helper function will process all payments for a single tenant sequentially.
            async def process_single_tenant_payments(tenant_id: str):
                results_for_tenant = []
                payments_list = payments_by_tenant[tenant_id]
                for p in payments_list:
                    result = await process_single_payment(p, term, organization_id, auth_token)
                    results_for_tenant.append(result)
                return { "tenant_id": tenant_id, "results": results_for_tenant }


            # Iterate through unique tenants in batches, controlled by settings.payment_batch_size
            for i in range(0, total_unique_tenants, settings.payment_batch_size):
                tenant_id_batch = tenant_ids_to_process[i:i + settings.payment_batch_size]
                
                # Create a list of coroutines, one for each tenant in the current batch.
                # These tasks will run concurrently.
                tasks = [process_single_tenant_payments(tid) for tid in tenant_id_batch]
                
                # Execute the current batch of tenant processing tasks concurrently.
                # `return_exceptions=True` ensures that if any task (processing a single tenant's payments)
                # raises an unhandled exception, it's returned as an exception object instead of stopping `gather`.
                batch_tenant_results = await asyncio.gather(*tasks, return_exceptions=True)

                # Initialize lists to store results for the current streaming yield.
                batch_successes_for_yield = []
                batch_errors_for_yield = []
                
                # Process the results from the concurrent tenant batches.
                for tenant_batch_result in batch_tenant_results:
                    if isinstance(tenant_batch_result, Exception):
                        # If an entire tenant group's processing failed unexpectedly (e.g., a critical unhandled error)
                        error_msg = f"Fatal error processing a tenant group: {str(tenant_batch_result)}"
                        batch_errors_for_yield.append({"message": error_msg})
                        # Note: For accurate progress tracking in this rare case,
                        # you might want to estimate how many payments were affected for this tenant.
                    else:
                        # tenant_batch_result is a dictionary: {"tenant_id": ..., "results": [...]}
                        # Iterate through the individual payment results for this tenant.
                        for single_payment_result in tenant_batch_result["results"]:
                            # Increment the overall counter for processed payments.
                            processed_payments_count += 1
                            # Separate successful and failed payment results.
                            if single_payment_result.success:
                                batch_successes_for_yield.append(single_payment_result.dict())
                            else:
                                batch_errors_for_yield.append(single_payment_result.dict())

                # Calculate progress based on the total number of individual payments processed so far.
                progress = min(100, int(processed_payments_count / total_payments_for_progress * 100))
                
                # Yield the results for the current batch of tenants to the client.
                yield json.dumps({
                    "status": "processing",
                    "progress": progress,
                    "results": batch_successes_for_yield,
                    "errors": batch_errors_for_yield
                }) + "\n\n"

            # After all tenants have been processed, send a final completion status.
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


# App lifecycle with Redis integration
@app.on_event("startup")
async def startup():
    global redis_pool

    # Initialize Redis connection pool with password if provided
    redis_kwargs = {
        "max_connections": 200,
        "decode_responses": True
    }

    if settings.redis_password:
        # If password is provided, add it to connection kwargs
        redis_kwargs["password"] = settings.redis_password

    redis_pool = ConnectionPool.from_url(
        settings.redis_url,
        **redis_kwargs
    )

    # Initialize HTTP client
    app.state.http_client = httpx.AsyncClient(timeout=settings.http_timeout)
    logger.info("Service starting", config=settings.dict())


@app.on_event("shutdown")
async def shutdown():
    # Close Redis connection pool
    global redis_pool
    if redis_pool:
        await redis_pool.disconnect()

    # Close HTTP client
    await app.state.http_client.aclose()
    logger.info("Service stopping")


# Mount router
app.include_router(router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)