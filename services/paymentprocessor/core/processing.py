import asyncio
import json
from typing import List
import httpx

from models.payment import Payment, PaymentResult
from utils.helpers import pad_tenant_id, parse_payment_date
from services.gateway import get_tenant_by_reference
from db.mongo import log_pending_payment, _get_payment_check_cache_key
from db.redis_client import get_redis
from core.config import settings
from core.logging_config import logger
from core.clients import http_client


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

        tenant = await get_tenant_by_reference(padded_reference, headers)
        if not tenant:
            error_msg = f"No tenant found with reference {padded_reference}"
            await log_pending_payment(
                tenant_id=payment.tenant_id, payment_date=payment.payment_date, payment_type=payment.payment_type,
                payment_reference=payment.reference, amount=payment.amount, narration=error_msg
            )
            return PaymentResult(success=False, tenant_id=payment.tenant_id, message=error_msg)

        tenant_id = tenant.get('_id')
        if not tenant_id:
            error_msg = f"Tenant data missing _id field for reference {padded_reference}"
            await log_pending_payment(
                tenant_id=payment.tenant_id, payment_date=payment.payment_date, payment_type=payment.payment_type,
                payment_reference=payment.reference, amount=payment.amount, narration=error_msg
            )
            return PaymentResult(success=False, tenant_id=payment.tenant_id, message=error_msg)

        existing_payments = []

        year, month = term.split('.')
        formatted_term_for_get = f"{year}{month.zfill(2)}0100"
        get_payments_url = f"{settings.gateway_url}/api/v2/rents/tenant/{tenant_id}/{formatted_term_for_get}"
        payments_response = await http_client.get(get_payments_url, headers=headers)
        logger.debug(f"Payments lookup response status: {payments_response.status_code}")

        if payments_response.status_code == 200:
            json_data = payments_response.json()
            if json_data:
                existing_payments = json_data.get('payments', [])
            else:
                existing_payments = []
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

        payment_response = await http_client.patch(
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
                tenant_id=payment.tenant_id, payment_date=payment.payment_date, payment_type=payment.payment_type,
                payment_reference=payment.reference, amount=payment.amount, narration=error_msg
            )
            return PaymentResult(success=False, tenant_id=tenant_id, message=error_msg)

        logger.info(f"Successfully processed payment for tenant {tenant_id} via Gateway.")

        try:
            redis_client = await get_redis()
            cache_key_payment_exists = _get_payment_check_cache_key(payment.reference)
            await redis_client.delete(cache_key_payment_exists)
            logger.debug("Invalidated payment existence cache after successful processing", reference=payment.reference)
        except Exception as e:
            logger.warning("Failed to invalidate payment existence cache", reference=payment.reference, error=str(e))

        return PaymentResult(
            success=True,
            tenant_id=tenant_id,
            message=f"Successfully processed payment for tenant {tenant_id}"
        )

    except httpx.TimeoutException as e:
        error_msg = f"HTTP Timeout during payment processing for tenant {payment.tenant_id}: {str(e)}"
        logger.error(error_msg, exc_info=True)
        await log_pending_payment(
            tenant_id=payment.tenant_id, payment_date=payment.payment_date, payment_type=payment.payment_type,
            payment_reference=payment.reference, amount=payment.amount, narration=error_msg
        )
        return PaymentResult(success=False, tenant_id=payment.tenant_id, message=error_msg)
    except Exception as e:
        error_msg = f"Unexpected error processing payment for tenant {payment.tenant_id}: {str(e)}"
        logger.error(error_msg, exc_info=True)
        await log_pending_payment(
            tenant_id=payment.tenant_id, payment_date=payment.payment_date, payment_type=payment.payment_type,
            payment_reference=payment.reference, amount=payment.amount, narration=error_msg
        )
        return PaymentResult(success=False, tenant_id=payment.tenant_id, message=error_msg)


async def process_payments_batch(payments: List[Payment], term: str, organization_id: str, auth_token: str) -> List[
    PaymentResult]:
    return await asyncio.gather(
        *(process_single_payment(p, term, organization_id, auth_token) for p in payments),
        return_exceptions=True
    )