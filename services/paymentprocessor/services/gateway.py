# Applying absolute imports to resolve runtime errors
from typing import Optional, Dict
import json
from datetime import timedelta
import httpx

from core.config import settings
from core.logging_config import logger
from db.redis_client import get_redis
from core.clients import http_client


def _get_tenant_cache_key(padded_reference: str, organization_id: str) -> str:
    return f"tenant:{organization_id}:{padded_reference}"


async def get_tenant_by_reference(padded_reference: str, headers: dict) -> Optional[Dict]:
    """Get tenant by reference with Redis caching"""
    organization_id = headers.get('organizationId', 'N/A')
    redis_client = await get_redis()
    cache_key = _get_tenant_cache_key(padded_reference, organization_id)

    try:
        cached_tenant = await redis_client.get(cache_key)
        if cached_tenant:
            logger.debug("Retrieved tenant from cache", reference=padded_reference)
            return json.loads(cached_tenant)
    except Exception as e:
        logger.warning("Redis cache read failed, falling back to API", error=str(e))

    tenant_url = f"{settings.gateway_url}/api/v2/tenants?reference={padded_reference}"
    logger.debug("Attempting to fetch tenant", url=tenant_url, reference=padded_reference)

    try:
        response = await http_client.get(tenant_url, headers=headers)
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
            found_tenant = next((t for t in tenant_data if t and str(t.get('reference', '')).strip() == padded_reference),
                                None)
            if not found_tenant:
                logger.warning("Tenant not found in list response from Gateway",
                               url=tenant_url, reference=padded_reference)
        else:
            if tenant_data and str(tenant_data.get('reference', '')).strip() == padded_reference:
                found_tenant = tenant_data
            else:
                logger.warning("Tenant reference mismatch in single response from Gateway",
                               url=tenant_url, expected_ref=padded_reference)

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
        logger.error("HTTP Timeout fetching tenant", url=tenant_url, reference=padded_reference, error=str(e), exc_info=True)
        return None
    except Exception as e:
        logger.error("Unexpected error fetching tenant", url=tenant_url, reference=padded_reference, error=str(e), exc_info=True)
        return None