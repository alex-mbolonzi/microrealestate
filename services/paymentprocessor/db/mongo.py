from motor.motor_asyncio import AsyncIOMotorClient
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import json

from core.config import settings
from core.logging_config import logger
from .redis_client import get_redis


@asynccontextmanager
async def get_mongo_client():
    client = AsyncIOMotorClient(settings.mongo_url)
    try:
        yield client
    finally:
        client.close()


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

    try:
        cached_result = await redis_client.get(cache_key)
        if cached_result:
            logger.info("Retrieved payment check from cache", reference=payment_reference)
            return json.loads(cached_result)
    except Exception as e:
        logger.warning("Redis cache read failed, falling back to DB", error=str(e))

    async with get_mongo_client() as client:
        db = client['bomatech']
        try:
            count = await db['occupants'].count_documents(
                {"rents.payments.reference": payment_reference}
            )
            exists = count > 0

            try:
                await redis_client.setex(cache_key, timedelta(seconds=settings.payment_check_cache_ttl), json.dumps(exists))
                logger.info("Cached payment check result", reference=payment_reference)
            except Exception as e:
                logger.warning("Failed to cache payment check result", error=str(e))

            return exists
        except Exception as e:
            logger.error("Error checking payment existence", reference=payment_reference, error=str(e))
            raise