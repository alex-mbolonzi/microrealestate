from fastapi import FastAPI, UploadFile, HTTPException, Form, File, Request
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
from io import StringIO
from typing import List, Dict
from pydantic import BaseModel
from datetime import datetime
import logging
import httpx
import os
import asyncio
import json

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# API configuration
API_BASE_URL = os.getenv('API_BASE_URL', 'http://api:8200')

app = FastAPI(title="Payment Processor Service")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, this should be configured via environment variable
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"]
)

# Add logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    logger.info(f"Incoming request: {request.method} {request.url}")
    logger.info(f"Headers: {dict(request.headers)}")
    response = await call_next(request)
    logger.info(f"Response status: {response.status_code}")
    return response

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

def pad_tenant_id(tenant_id: str) -> str:
    """Pad tenant_id with leading zeros to ensure it's six digits"""
    return str(tenant_id).strip().zfill(6)

# Constants for frequency
PAYMENT_FREQUENCY = 'months'  # Monthly payments are standard for rental contracts

async def process_single_payment(payment: Payment, term: str, organization_id: str, auth_token: str = None) -> PaymentResult:
    """Process a single payment by calling the rent API endpoint"""
    try:
        # First, look up the tenant by reference number
        async with httpx.AsyncClient(timeout=30.0) as client:  # 30 second timeout for each request
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "organizationId": organization_id
            }
            
            # Add authorization header if token is provided
            if auth_token:
                headers["Authorization"] = auth_token

            # Pad the tenant reference with leading zeros
            padded_reference = pad_tenant_id(payment.tenant_reference)
            
            # Get tenant by reference number
            tenant_url = f"{API_BASE_URL}/api/v2/tenants?reference={padded_reference}"
            logger.info(f"Looking up tenant with URL: {tenant_url}")
            response = await client.get(
                tenant_url,
                headers=headers
            )
            
            logger.info(f"Tenant lookup response status: {response.status_code}")
            logger.info(f"Tenant lookup response: {response.text}")
            
            if response.status_code != 200:
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_reference,
                    message=f"Failed to fetch tenants: {response.text}",
                    details={"status_code": response.status_code}
                )
                
            tenants = response.json()
            matching_tenant = next(
                (tenant for tenant in tenants 
                 if str(tenant.get("reference", "")).strip() == str(payment.tenant_reference).strip()),
                None
            )
            
            if not matching_tenant:
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_reference,
                    message=f"No tenant found with reference number {payment.tenant_reference}",
                    details={"status_code": 404}
                )

            # Validate contract dates - handle MongoDB ISODate objects
            begin_date = matching_tenant.get('beginDate', {}).get('$date', {}).get('$numberLong') if isinstance(matching_tenant.get('beginDate'), dict) else matching_tenant.get('beginDate')
            end_date = matching_tenant.get('endDate', {}).get('$date', {}).get('$numberLong') if isinstance(matching_tenant.get('endDate'), dict) else matching_tenant.get('endDate')

            if not begin_date or not end_date:
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_reference,
                    message=f"Tenant {payment.tenant_reference} is missing required contract dates",
                    details={"status_code": 400}
                )

            # Always use monthly frequency for rent payments
            tenant_frequency = PAYMENT_FREQUENCY
            logger.info(f"Using monthly frequency for tenant {payment.tenant_reference}")

            # Now construct the payment request with frequency
            payment_data = {
                "_id": matching_tenant["_id"],  # Add tenant ID to payment data
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
                },
                "frequency": tenant_frequency  # Add frequency to payment data
            }

            logger.info(f"Making API request with headers: {headers}")
            logger.info(f"Payment data: {payment_data}")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                payment_url = f"{API_BASE_URL}/api/v2/rents/payment/{matching_tenant['_id']}/{term}"
                logger.info(f"Making payment request to: {payment_url}")
                
                try:
                    response = await client.patch(
                        payment_url,
                        json=payment_data,
                        headers=headers
                    )
                    
                    logger.info(f"Payment response status: {response.status_code}")
                    logger.info(f"Payment response: {response.text}")
                    
                    if response.status_code == 200:
                        return PaymentResult(
                            success=True,
                            tenant_id=payment.tenant_reference,
                            message="Payment processed successfully"
                        )
                    else:
                        error_msg = response.text
                        try:
                            if response.text and response.text.strip():
                                error_data = response.json()
                                error_msg = error_data.get('error', error_msg)
                        except json.JSONDecodeError as je:
                            logger.error(f"Failed to parse error response: {str(je)}")
                            error_msg = response.text or str(je)
                        except Exception as e:
                            logger.error(f"Error handling response: {str(e)}")
                            error_msg = str(e)
                        
                        logger.error(f"API Error: {error_msg}")
                        return PaymentResult(
                            success=False,
                            tenant_id=payment.tenant_reference,
                            message=f"Failed to process payment: {error_msg}",
                            details={"status_code": response.status_code}
                        )
                except Exception as e:
                    logger.error(f"Request error: {str(e)}")
                    return PaymentResult(
                        success=False,
                        tenant_id=payment.tenant_reference,
                        message=f"Request failed: {str(e)}",
                        details={"error": str(e)}
                    )

    except Exception as e:
        logger.error(f"Error processing payment for tenant {payment.tenant_reference}: {str(e)}")
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_reference,
            message=f"Error processing payment: {str(e)}"
        )

@app.post("/process-payments")
async def process_payments(
    request: Request,
    file: UploadFile = File(...),
    term: str = Form(...)
):
    """
    Process bulk payments from a CSV file
    """
    logger.info(f"Received payment processing request")
    logger.info(f"Headers: {dict(request.headers)}")
    logger.info(f"File: {file.filename}, Content-Type: {file.content_type}")
    logger.info(f"Term: {term}")
    
    if not file.filename.endswith('.csv'):
        logger.error(f"Invalid file type: {file.filename}")
        raise HTTPException(status_code=400, detail="Only CSV files are allowed")
    
    # Get organization ID and auth token from headers
    organization_id = request.headers.get('organizationid')
    auth_token = request.headers.get('authorization')
    
    if not organization_id:
        logger.error("Missing organization ID in headers")
        raise HTTPException(status_code=400, detail="Organization ID is required in headers")
        
    if not auth_token:
        logger.error("Missing authorization token in headers")
        raise HTTPException(status_code=401, detail="Authorization token is required")
    
    try:
        # Read the file content
        contents = await file.read()
        csv_data = StringIO(contents.decode())
        
        # Log file details
        logger.info(f"Processing CSV file: {file.filename}, size: {len(contents)} bytes")
        
        # Read CSV with pandas
        df = pd.read_csv(csv_data)
        required_columns = ['tenant_id', 'payment_date', 'payment_type', 'payment_reference', 'amount']
        
        # Validate columns
        missing_columns = [col for col in required_columns if col not in df.columns]
        if missing_columns:
            error_msg = f"Missing required columns: {missing_columns}"
            logger.error(error_msg)
            raise HTTPException(status_code=400, detail=error_msg)
        
        # Process payments in chunks to avoid timeouts
        chunk_size = 5  # Process 5 payments at a time
        results = []
        
        for i in range(0, len(df), chunk_size):
            chunk = df[i:i + chunk_size]
            chunk_tasks = []
            
            for idx, row in chunk.iterrows():
                try:
                    # Validate date format
                    payment_date = datetime.strptime(row['payment_date'], '%m/%d/%Y')
                    
                    # Validate amount
                    amount = float(row['amount'])
                    if amount <= 0:
                        raise ValueError(f"Invalid amount {amount} at row {idx + 2}")
                    
                    # Pad the tenant_id with leading zeros
                    tenant_id = pad_tenant_id(row['tenant_id'])
                    
                    payment = Payment(
                        tenant_reference=tenant_id,
                        payment_date=payment_date.strftime('%Y-%m-%d'),
                        payment_type=str(row['payment_type']).strip().lower() if pd.notna(row['payment_type']) else 'cash',
                        reference=str(row['payment_reference']).strip() if pd.notna(row['payment_reference']) else '',
                        amount=amount
                    )
                    
                    # Add task to chunk
                    chunk_tasks.append(process_single_payment(payment, term, organization_id, auth_token))
                    
                except Exception as e:
                    error_msg = f"Error processing row {idx + 2}: {str(e)}"
                    logger.error(error_msg)
                    results.append(PaymentResult(
                        success=False,
                        tenant_id=str(row.get('tenant_id', '')).strip(),
                        message=error_msg
                    ))
            
            # Process chunk of payments concurrently
            if chunk_tasks:
                chunk_results = await asyncio.gather(*chunk_tasks, return_exceptions=True)
                for result in chunk_results:
                    if isinstance(result, Exception):
                        logger.error(f"Payment processing error: {str(result)}")
                        results.append(PaymentResult(
                            success=False,
                            tenant_id="unknown",
                            message=f"Payment processing error: {str(result)}"
                        ))
                    else:
                        results.append(result)
        
        successful = len([r for r in results if r.success])
        failed = len([r for r in results if not r.success])
        logger.info(f"Completed processing {len(results)} payments: {successful} successful, {failed} failed")
        
        return {
            "status": "success",
            "message": f"Processed {len(results)} payments",
            "results": [result.dict() for result in results],
            "summary": {
                "total": len(results),
                "successful": successful,
                "failed": failed
            }
        }
        
    except Exception as e:
        error_msg = f"Error processing CSV: {str(e)}"
        logger.error(error_msg)
        raise HTTPException(status_code=400, detail=error_msg)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
