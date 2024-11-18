from fastapi import FastAPI, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
from io import StringIO
from typing import List
from pydantic import BaseModel
from datetime import datetime
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Payment Processor Service")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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

@app.post("/process-payments/", response_model=List[Payment])
async def process_payments(file: UploadFile):
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
        payments = []
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
                payments.append(payment)
                
            except Exception as e:
                logger.error(f"Error processing row {idx + 2}: {str(e)}")
                raise HTTPException(
                    status_code=400,
                    detail=f"Error in row {idx + 2}: {str(e)}"
                )
        
        logger.info(f"Successfully processed {len(payments)} payments")
        return payments
        
    except Exception as e:
        logger.error(f"Error processing CSV: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
