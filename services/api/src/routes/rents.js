import express from 'express';
import * as rentmanager from '../managers/rentmanager.js';
import multer from 'multer';
import csv from 'csv-parse';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new Error('No file uploaded');
    }

    // Parse CSV file
    const csvData = req.file.buffer.toString();
    const parser = csv.parse(csvData, {
      columns: true,
      skip_empty_lines: true
    });

    const records = [];
    for await (const record of parser) {
      records.push({
        tenant_reference: record.tenant_id,
        payment_date: record.payment_date,
        payment_type: record.payment_type,
        reference: record.payment_reference,
        amount: parseFloat(record.amount.replace(/,/g, '')),
      });
    }

    req.body.payments = records;
    await rentmanager.uploadBulkPayments(req, res);
  } catch (error) {
    next(error);
  }
});

export default router;
