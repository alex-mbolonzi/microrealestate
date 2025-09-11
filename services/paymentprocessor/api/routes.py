from fastapi import APIRouter, Request, UploadFile, Form, File
from fastapi.responses import StreamingResponse
import pandas as pd
from io import StringIO
import json
import asyncio
from typing import List, Dict

from core.logging_config import logger
from core.config import settings
from models.payment import Payment
from db.mongo import check_payment_exists, log_pending_payment
from core.processing import process_single_payment

router = APIRouter(
    prefix="/paymentprocessor",
    tags=["payments"],
    responses={404: {"description": "Not found"}},
)


@router.post("/process-payments")
async def process_payments(
        request: Request,
        file: UploadFile = File(...),
        term: str = Form(...)
):
    async def generate_events():
        try:
            contents = await file.read()
            df = pd.read_csv(StringIO(contents.decode()))

            organization_id = request.headers.get('organizationid')
            auth_token = request.headers.get('authorization')

            all_payments: List[Payment] = []
            for _, row in df.iterrows():
                try:
                    payment = Payment(
                        tenant_id=str(row['tenant_id']).strip(),
                        payment_date=str(row['payment_date']).strip(),
                        payment_type=str(row['payment_type']).strip(),
                        reference=str(row['payment_reference']).strip(),
                        amount=float(row['amount']),
                    )
                    all_payments.append(payment)
                except Exception as e:
                    logger.warning("Skipping invalid row during parsing", row_data=row.to_dict(), error=str(e))
                    yield f"data: {json.dumps({
                        "status": "skipped",
                        "message": f"Invalid row skipped: {str(e)}",
                        "details": row.to_dict()
                    })}\n\n"

            payments_to_process: List[Payment] = []
            skipped_duplicates: List[Dict] = []

            duplicate_checks = [check_payment_exists(p.reference) for p in all_payments]
            duplicate_results = await asyncio.gather(*duplicate_checks)

            for i, payment in enumerate(all_payments):
                if duplicate_results[i]:
                    skip_message = f"Payment with reference '{payment.reference}' already exists."
                    skipped_duplicates.append({
                        "status": "skipped",
                        "message": skip_message,
                        "tenant_id": payment.tenant_id
                    })
                    await log_pending_payment(
                        payment.tenant_id, payment.payment_date, payment.payment_type,
                        payment.reference, payment.amount, skip_message
                    )
                else:
                    payments_to_process.append(payment)

            for skipped in skipped_duplicates:
                yield f"data: {json.dumps(skipped)}\n\n"

            payments_by_tenant: Dict[str, List[Payment]] = {}
            for payment in payments_to_process:
                if payment.tenant_id not in payments_by_tenant:
                    payments_by_tenant[payment.tenant_id] = []
                payments_by_tenant[payment.tenant_id].append(payment)

            total_payments_for_progress = len(payments_to_process)
            processed_payments_count = 0

            tenant_ids_to_process = list(payments_by_tenant.keys())
            total_unique_tenants = len(tenant_ids_to_process)

            async def process_single_tenant_payments(tenant_id: str):
                results_for_tenant = []
                payments_list = payments_by_tenant[tenant_id]
                for p in payments_list:
                    result = await process_single_payment(p, term, organization_id, auth_token)
                    results_for_tenant.append(result)
                return {"tenant_id": tenant_id, "results": results_for_tenant}

            for i in range(0, total_unique_tenants, settings.payment_batch_size):
                tenant_id_batch = tenant_ids_to_process[i:i + settings.payment_batch_size]
                tasks = [process_single_tenant_payments(tid) for tid in tenant_id_batch]
                batch_tenant_results = await asyncio.gather(*tasks, return_exceptions=True)

                batch_successes_for_yield = []
                batch_errors_for_yield = []

                for tenant_batch_result in batch_tenant_results:
                    if isinstance(tenant_batch_result, Exception):
                        error_msg = f"Fatal error processing a tenant group: {str(tenant_batch_result)}"
                        batch_errors_for_yield.append({"message": error_msg})
                    else:
                        for single_payment_result in tenant_batch_result["results"]:
                            processed_payments_count += 1
                            if single_payment_result.success:
                                batch_successes_for_yield.append(single_payment_result.dict())
                            else:
                                batch_errors_for_yield.append(single_payment_result.dict())

                progress = min(100, int(processed_payments_count / total_payments_for_progress * 100)) if total_payments_for_progress > 0 else 100

                yield f"data: {json.dumps({
                    "status": "processing",
                    "progress": progress,
                    "results": batch_successes_for_yield,
                    "errors": batch_errors_for_yield
                })}\n\n"

            yield f"data: {json.dumps({
                "status": "complete",
                "progress": 100,
                "message": "Processing completed"
            })}\n\n"

        except Exception as e:
            logger.error("Bulk processing failed", error=str(e), exc_info=True)
            yield f"data: {json.dumps({
                "status": "error",
                "message": str(e)
            })}\n\n"

    return StreamingResponse(generate_events(), media_type="text/event-stream")
