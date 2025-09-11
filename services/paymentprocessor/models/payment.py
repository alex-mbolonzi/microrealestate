from pydantic import BaseModel, validator
from typing import Dict
from dateutil import parser


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
        except (ValueError, TypeError):
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