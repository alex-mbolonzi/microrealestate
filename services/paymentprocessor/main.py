from fastapi import FastAPI, UploadFile, HTTPException, Form, File, Request, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, validator, BaseSettings
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
    api_base_url: str = 'http://api:8200'
    gateway_url: str = 'http://gateway:80'
    mongo_url: str = 'mongodb://localhost:27017'
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
    response = await app.state.http_client.get(tenant_url, headers=headers)

    if response.status_code != 200:
        return None

    tenant_data = response.json()
    if isinstance(tenant_data, list):
        return next((t for t in tenant_data if str(t.get('reference', '')).strip() == padded_reference), None)
    return tenant_data if str(tenant_data.get('reference', '')).strip() == padded_reference else None


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
    try:
        padded_reference = await pad_tenant_id(payment.tenant_id)
        tenant = await get_tenant_by_reference(padded_reference, headers)

        if not tenant:
            error_msg = f"No tenant found with reference {padded_reference}"
            await log_pending_payment(
                payment.tenant_id, payment.payment_date, payment.payment_type,
                payment.reference, payment.amount, error_msg
            )
            return PaymentResult(
                success=False,
                tenant_id=payment.tenant_id,
                message=error_msg
            )

        tenant_id = tenant.get('_id')
        if not tenant_id:
            error_msg = f"Tenant missing ID for reference {padded_reference}"
            await log_pending_payment(
                payment.tenant_id, payment.payment_date, payment.payment_type,
                payment.reference, payment.amount, error_msg
            )
            return PaymentResult(
                success=False,
                tenant_id=payment.tenant_id,
                message=error_msg
            )

        # Process payment (rest of your existing logic)
        # ...

        return PaymentResult(
            success=True,
            tenant_id=tenant_id,
            message=f"Payment processed successfully"
        )

    except Exception as e:
        logger.error("Payment processing error", error=str(e), tenant_id=payment.tenant_id)
        await log_pending_payment(
            payment.tenant_id, payment.payment_date, payment.payment_type,
            payment.reference, payment.amount, str(e)
        )
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_id,
            message=str(e)
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
            # Stream file processing
            contents = []
            async for chunk in file.stream():
                contents.append(chunk)
            df = pd.read_csv(StringIO(b''.join(contents).decode()))

            # Prepare headers
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "organizationId": request.headers.get('organizationid'),
                "Authorization": request.headers.get('authorization', "")
            }

            # Process in batches
            total = len(df)
            processed = 0
            batch_size = settings.payment_batch_size

            for i in range(0, total, batch_size):
                batch = df.iloc[i:i + batch_size]
                payments = [
                    Payment(
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
                    ) for _, row in batch.iterrows()
                ]

                # Check for duplicates first
                for payment in payments:
                    if await check_payment_exists(payment.reference):
                        yield json.dumps({
                            "status": "skipped",
                            "message": f"Payment {payment.reference} exists",
                            "tenant_id": payment.tenant_id
                        }) + "\n\n"
                        continue

                    # Process batch
                    results = await process_payments_batch(payments, term, headers)
                    processed += len(results)

                    progress = min(100, int(processed / total * 100))
                    yield json.dumps({
                        "status": "processing",
                        "progress": progress,
                        "results": [r.dict() for r in results if not isinstance(r, Exception)],
                        "errors": [str(e) for e in results if isinstance(e, Exception)]
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
