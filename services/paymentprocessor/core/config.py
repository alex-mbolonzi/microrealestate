from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    api_url: str
    gateway_url: str
    mongo_url: str
    redis_url: str = "redis://localhost:6379"
    redis_password: str = None
    payment_batch_size: int = 10
    http_timeout: float = 30.0
    allow_origins: List[str] = ["*"]
    tenant_cache_ttl: int = 3600  # 1 hour TTL for tenant cache
    payment_check_cache_ttl: int = 86400  # 24 hours TTL for payment existence checks

    class Config:
        env_file = ".env"


settings = Settings()