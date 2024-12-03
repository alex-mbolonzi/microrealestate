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
                "payments": [{
                    "date": payment.payment_date,
                    "type": payment.payment_type,
                    "reference": payment.reference,
                    "amount": payment.amount
                }],
                "description": payment.description,
                "promo": payment.promo_amount,
                "notepromo": payment.promo_note if payment.promo_amount > 0 else None,
                "extracharge": payment.extra_charge,
                "noteextracharge": payment.extra_charge_note if payment.extra_charge > 0 else None,
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
                    logger.info(f"Payment response text: {response.text}")
                    
                    if response.status_code == 200:
                        try:
                            response_data = response.json() if response.text else {}
                            return PaymentResult(
                                success=True,
                                tenant_id=payment.tenant_reference,
                                message="Payment processed successfully",
                                details=response_data
                            )
                        except json.JSONDecodeError as je:
                            logger.error(f"Failed to parse success response: {str(je)}")
                            return PaymentResult(
                                success=True,
                                tenant_id=payment.tenant_reference,
                                message="Payment processed successfully but response parsing failed",
                                details={"response_text": response.text}
                            )
                    else:
                        error_msg = "Unknown error"
                        try:
                            if response.text and response.text.strip():
                                error_data = response.json()
                                error_msg = error_data.get('error', error_data.get('message', response.text))
                            else:
                                error_msg = f"Empty response with status {response.status_code}"
                        except json.JSONDecodeError as je:
                            error_msg = response.text or str(je)
                        except Exception as e:
                            error_msg = str(e)
                        
                        logger.error(f"API Error: {error_msg}")
                        return PaymentResult(
                            success=False,
                            tenant_id=payment.tenant_reference,
                            message=f"Failed to process payment: {error_msg}",
                            details={"status_code": response.status_code, "response_text": response.text}
                        )
                except httpx.RequestError as e:
                    logger.error(f"Request failed: {str(e)}")
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
    """Process bulk payments from a CSV file"""
    try:
        logger.info(f"Starting bulk payment processing for term: {term}")
        logger.info(f"Reading CSV file: {file.filename}")
        
        # Get organization ID from headers
        organization_id = request.headers.get('organizationid')
        if not organization_id:
            logger.error("No organization ID found in headers")
            raise HTTPException(status_code=400, detail="Organization ID is required")
        
        logger.info(f"Processing payments for organization: {organization_id}")
        
        # Read CSV content
        content = await file.read()
        try:
            text_content = content.decode('utf-8')
        except UnicodeDecodeError:
            logger.error("Failed to decode CSV file as UTF-8")
            raise HTTPException(status_code=400, detail="Invalid CSV file encoding")
        
        logger.debug(f"CSV content: {text_content[:200]}...")  # Log first 200 chars
        
        # Parse CSV
        try:
            df = pd.read_csv(StringIO(text_content))
            logger.info(f"Successfully parsed CSV with {len(df)} rows")
            logger.debug(f"CSV columns: {df.columns.tolist()}")
        except Exception as e:
            logger.error(f"Failed to parse CSV: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid CSV format: {str(e)}")
        
        # Process each payment
        results = []
        for index, row in df.iterrows():
            logger.info(f"Processing payment {index + 1}/{len(df)}")
            try:
                # Parse and format the date
                try:
                    # Try different date formats
                    date_formats = ['%Y-%m-%d', '%d/%m/%Y', '%m/%d/%Y', '%d-%m-%Y']
                    payment_date = None
                    date_str = str(row['payment_date']).strip()
                    
                    for fmt in date_formats:
                        try:
                            payment_date = datetime.strptime(date_str, fmt)
                            break
                        except ValueError:
                            continue
                    
                    if payment_date is None:
                        raise ValueError(f"Could not parse date: {date_str}")
                    
                    # Format date as DD/MM/YYYY for the API
                    formatted_date = payment_date.strftime('%d/%m/%Y')
                    logger.debug(f"Parsed date {date_str} as {formatted_date}")
                except Exception as e:
                    logger.error(f"Date parsing error for row {index + 1}: {str(e)}")
                    raise ValueError(f"Invalid date format in row {index + 1}: {date_str}. Expected format: DD/MM/YYYY")
                
                payment = Payment(
                    tenant_reference=str(row['tenant_reference']),
                    payment_date=formatted_date,  # Use the formatted date
                    payment_type=row['payment_type'],
                    reference=str(row['reference']),
                    amount=float(row['amount']),
                    description=str(row.get('description', '')),
                    promo_amount=float(row.get('promo_amount', 0)),
                    promo_note=str(row.get('promo_note', '')),
                    extra_charge=float(row.get('extra_charge', 0)),
                    extra_charge_note=str(row.get('extra_charge_note', ''))
                )
                logger.debug(f"Created payment object: {payment}")
                
                result = await process_single_payment(
                    payment=payment,
                    term=term,
                    organization_id=organization_id,
                    auth_token=request.headers.get('authorization')
                )
                results.append(result)
                logger.info(f"Payment {index + 1} result: {result}")
            except Exception as e:
                logger.error(f"Error processing payment {index + 1}: {str(e)}")
                results.append(PaymentResult(
                    success=False,
                    tenant_id=str(row.get('tenant_reference', 'unknown')),
                    message=f"Failed to process payment: {str(e)}"
                ))
        
        # Summarize results
        success_count = sum(1 for r in results if r.success)
        logger.info(f"Bulk payment processing complete. {success_count}/{len(results)} successful")
        
        return results
        
    except Exception as e:
        logger.error(f"Error in bulk payment processing: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
