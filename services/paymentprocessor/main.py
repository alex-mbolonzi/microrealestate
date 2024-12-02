from fastapi import FastAPI, UploadFile, HTTPException, Form, File
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
from io import StringIO
from typing import List, Dict
from pydantic import BaseModel
from datetime import datetime
import logging
import httpx
import os

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# API configuration
API_BASE_URL = os.getenv('API_BASE_URL', 'http://localhost:8080/api')

app = FastAPI(title="Payment Processor Service")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",  # Development frontend
        "http://localhost:3000",  # Alternative development port
        "http://localhost:8081",  # Production frontend
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"]
)

class Payment(BaseModel):
    tenant_reference: str
    payment_date: str
    payment_type: str
    reference: str
    amount: float
    description: str = ""
    promo_amount: float = 0
    promo_note: str = ""
    extra_charge: float = 0
    extra_charge_note: str = ""

class PaymentResult(BaseModel):
    success: bool
    tenant_id: str
    message: str
    details: Dict = {}

async def process_single_payment(payment: Payment, term: str) -> PaymentResult:
    """Process a single payment by calling the rent API endpoint"""
    try:
        payment_data = {
            "_id": payment.tenant_reference,  # tenant ID
            "date": payment.payment_date,
            "type": payment.payment_type,
            "reference": payment.reference,
            "amount": payment.amount,
            "description": payment.description,
            "promo": {
                "amount": payment.promo_amount,
                "description": payment.promo_note
            },
            "extraCharge": {
                "amount": payment.extra_charge,
                "description": payment.extra_charge_note
            }
        }

        async with httpx.AsyncClient() as client:
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json"
            }
            response = await client.patch(
                f"{API_BASE_URL}/rents/payment/{payment.tenant_reference}/{term}",
                json=payment_data,
                headers=headers
            )
            
            if response.status_code == 200:
                return PaymentResult(
                    success=True,
                    tenant_id=payment.tenant_reference,
                    message="Payment processed successfully"
                )
            else:
                error_msg = response.text
                try:
                    error_data = response.json()
                    error_msg = error_data.get('error', error_msg)
                except:
                    pass
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_reference,
                    message=f"Failed to process payment: {error_msg}",
                    details={"status_code": response.status_code}
                )

    except Exception as e:
        logger.error(f"Error processing payment for tenant {payment.tenant_reference}: {str(e)}")
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_reference,
            message=f"Error processing payment: {str(e)}"
        )

@app.post("/process-payments/")
async def process_payments(
    file: UploadFile = File(...),
    term: str = Form(...)
):
    if not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="Only CSV files are allowed")
    
    try:
        # Read the file content
        contents = await file.read()
        csv_data = StringIO(contents.decode())
        
        # Read CSV with pandas
        df = pd.read_csv(csv_data)
        required_columns = ['tenant_id', 'payment_date', 'payment_type', 'payment_reference', 'amount']
        
        # Validate columns
        if not all(col in df.columns for col in required_columns):
            raise HTTPException(
                status_code=400,
                detail=f"Missing required columns. Required: {required_columns}"
            )
        
        # Process and validate each row
        results = []
        for idx, row in df.iterrows():
            try:
                # Validate date format
                payment_date = datetime.strptime(row['payment_date'], '%m/%d/%Y')
                
                # Validate amount
                amount = float(row['amount'])
                if amount <= 0:
                    raise ValueError(f"Invalid amount {amount} at row {idx + 2}")
                
                payment = Payment(
                    tenant_reference=str(row['tenant_id']).strip(),
                    payment_date=payment_date.strftime('%Y-%m-%d'),
                    payment_type=str(row['payment_type']).strip().lower() if pd.notna(row['payment_type']) else 'cash',
                    reference=str(row['payment_reference']).strip() if pd.notna(row['payment_reference']) else '',
                    amount=amount
                )
                
                # Process the payment through the rent API
                result = await process_single_payment(payment, term)
                results.append(result)
                
            except Exception as e:
                logger.error(f"Error processing row {idx + 2}: {str(e)}")
                results.append(PaymentResult(
                    success=False,
                    tenant_id=str(row.get('tenant_id', '')).strip(),
                    message=f"Error in row {idx + 2}: {str(e)}"
                ))
        
        logger.info(f"Processed {len(results)} payments")
        return {"results": results}
        
    except Exception as e:
        logger.error(f"Error processing CSV: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
