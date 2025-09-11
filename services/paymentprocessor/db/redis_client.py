import redis.asyncio as redis
from redis.asyncio.connection import ConnectionPool

# This will be initialized in main.py startup
redis_pool: ConnectionPool = None


async def get_redis() -> redis.Redis:
    """Get a Redis connection from the pool"""
    return redis.Redis(connection_pool=redis_pool)