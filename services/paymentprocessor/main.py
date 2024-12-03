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
    level=logging.DEBUG,  # Set to DEBUG for more detailed logs
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%S'
)
logger = logging.getLogger(__name__)

# Add console handler to ensure logs are printed to stdout
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.DEBUG)
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)

# Log startup message
logger.info("Payment Processor Service starting up...")

# API configuration
API_BASE_URL = os.getenv('API_BASE_URL', 'http://api:8200')
logger.info(f"API Base URL: {API_BASE_URL}")

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
            padded_reference = pad_tenant_id(payment.tenant_id)
            logger.debug(f"Looking up tenant with reference: {padded_reference}")
            
            # Get tenant by reference number using the reference field
            tenant_url = f"{API_BASE_URL}/api/v2/tenants?reference={padded_reference}"
            logger.debug(f"Tenant lookup URL: {tenant_url}")
            
            tenant_response = await client.get(tenant_url, headers=headers)
            
            if tenant_response.status_code != 200:
                error_msg = f"Failed to find tenant with reference {padded_reference}: {tenant_response.text}"
                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_id,
                    message=error_msg
                )
            
            tenant_data = tenant_response.json()
            if not tenant_data:
                error_msg = f"No tenant found with reference {padded_reference}"
                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_id,
                    message=error_msg
                )
            
            tenant = tenant_data[0] if isinstance(tenant_data, list) else tenant_data
            tenant_id = tenant.get('_id')
            
            if not tenant_id:
                error_msg = "Tenant data missing _id field"
                logger.error(error_msg)
                return PaymentResult(
                    success=False,
                    tenant_id=payment.tenant_id,
                    message=error_msg
                )

            # Now construct the payment request with frequency
            payment_data = {
                "tenantId": tenant_id,  # Changed from 'tenant' to 'tenantId'
                "payments": [{
                    "date": payment.payment_date,
                    "type": payment.payment_type,
                    "reference": payment.reference,
                    "amount": payment.amount
                }],
                "description": payment.description or "",
                "promo": payment.promo_amount or 0,
                "notepromo": payment.promo_note or "",
                "extracharge": payment.extra_charge or 0,
                "noteextracharge": payment.extra_charge_note or "",
                "frequency": PAYMENT_FREQUENCY
            }

            logger.info(f"Making API request with headers: {headers}")
            logger.info(f"Payment data: {payment_data}")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                payment_url = f"{API_BASE_URL}/api/v2/rents/payment/{tenant_id}/{term}"
                logger.info(f"Making payment request to: {payment_url}")
                
                try:
                    response = await client.patch(
                        payment_url,
                        headers=headers,
                        json=payment_data
                    )
                    
                    logger.info(f"Payment response status: {response.status_code}")
                    logger.info(f"Payment response text: {response.text}")
                    
                    if response.status_code >= 400:
                        error_msg = f"API Error: {response.json().get('error', 'Unknown error')}"
                        logger.error(error_msg)
                        return PaymentResult(
                            success=False,
                            tenant_id=payment.tenant_id,
                            message=error_msg,
                            details=response.json()
                        )
                    
                    return PaymentResult(
                        success=True,
                        tenant_id=payment.tenant_id,
                        message="Payment processed successfully"
                    )
                    
                except Exception as e:
                    error_msg = f"Error making payment request: {str(e)}"
                    logger.error(error_msg)
                    return PaymentResult(
                        success=False,
                        tenant_id=payment.tenant_id,
                        message=error_msg
                    )
                
    except Exception as e:
        error_msg = f"Error processing payment: {str(e)}"
        logger.error(error_msg)
        return PaymentResult(
            success=False,
            tenant_id=payment.tenant_id,
            message=error_msg
        )

@app.post("/process-payments")
async def process_payments(
    request: Request,
    file: UploadFile = File(...),
    term: str = Form(...)
):
    """Process bulk payments from a CSV file"""
    try:
        logger.info(f"Starting bulk payment processing for term: {term}")
        
        # Read the CSV file content
        content = await file.read()
        csv_content = content.decode()
        logger.info(f"Reading CSV file: {file.filename}")
        
        # Get organization ID from headers
        organization_id = request.headers.get('organizationid')
        auth_token = request.headers.get('authorization')
        logger.info(f"Processing payments for organization: {organization_id}")
        
        # Log CSV content for debugging
        logger.debug(f"CSV content: {csv_content[:200]}...")
        
        # Read CSV into pandas DataFrame
        df = pd.read_csv(StringIO(csv_content))
        logger.info(f"Successfully parsed CSV with {len(df)} rows")
        logger.debug(f"CSV columns: {list(df.columns)}")
        
        # Initialize results list
        results = []
        successful_payments = 0
        
        # Process each payment
        for index, row in df.iterrows():
            logger.info(f"Processing payment {index + 1}/{len(df)}")
            try:
                # Get tenant reference from tenant_id column and ensure it's a string
                tenant_id = str(row['tenant_id']).strip()
                
                # Ensure all required fields are present and properly formatted
                payment = Payment(
                    tenant_id=tenant_id,
                    payment_date=str(row['payment_date']).strip(),
                    payment_type=str(row['payment_type']).strip(),
                    reference=str(row['payment_reference']).strip(),
                    amount=float(row['amount']),
                    description=str(row.get('description', '')).strip(),
                    promo_amount=float(row.get('promo_amount', 0)),
                    promo_note=str(row.get('promo_note', '')).strip(),
                    extra_charge=float(row.get('extra_charge', 0)),
                    extra_charge_note=str(row.get('extra_charge_note', '')).strip()
                )
                
                # Process the payment
                result = await process_single_payment(payment, term, organization_id, auth_token)
                if result.success:
                    successful_payments += 1
                results.append(result)
                
            except Exception as e:
                logger.error(f"Error processing payment {index + 1}: {str(e)}")
                results.append(PaymentResult(
                    success=False,
                    tenant_id=str(row.get('tenant_id', '')),
                    message=f"Failed to process payment: {str(e)}",
                    details={"error": str(e)}
                ))
        
        logger.info(f"Bulk payment processing complete. {successful_payments}/{len(df)} successful")
        return {
            "success": True,
            "message": f"Processed {len(df)} payments. {successful_payments} successful.",
            "results": [result.dict() for result in results]
        }
        
    except Exception as e:
        logger.error(f"Error in bulk payment processing: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
