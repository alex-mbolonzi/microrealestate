from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import httpx
from redis.asyncio.connection import ConnectionPool
import uvicorn

from core.config import settings
from core.logging_config import logger
from api.routes import router
from db import redis_client
from core import clients

# Application setup
app = FastAPI(title="Payment Processor Service")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# App lifecycle
@app.on_event("startup")
async def startup():
    # Initialize Redis connection pool
    redis_kwargs = {
        "max_connections": 200,
        "decode_responses": True
    }
    if settings.redis_password:
        redis_kwargs["password"] = settings.redis_password

    redis_client.redis_pool = ConnectionPool.from_url(
        settings.redis_url,
        **redis_kwargs
    )

    # Initialize HTTP client
    clients.http_client = httpx.AsyncClient(base_url=settings.gateway_url, timeout=settings.http_timeout)
    logger.info("Service starting", config=settings.dict(exclude={'redis_password'}))


@app.on_event("shutdown")
async def shutdown():
    # Close Redis connection pool
    if redis_client.redis_pool:
        await redis_client.redis_pool.disconnect()

    # Close HTTP client
    if clients.http_client:
        await clients.http_client.aclose()
    logger.info("Service stopping")


# Mount router
app.include_router(router)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
