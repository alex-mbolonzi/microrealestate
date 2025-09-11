from dateutil import parser
from ..core.logging_config import logger


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


async def pad_tenant_id(tenant_id: str) -> str:
    return str(int(float(tenant_id))).strip().zfill(6)