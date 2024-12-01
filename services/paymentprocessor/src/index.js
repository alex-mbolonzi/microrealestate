import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse';
import { Service } from '@microrealestate/common';

const service = Service.getInstance();
const app = express();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const records = [];
    const parser = parse({
      delimiter: ',',
      columns: true,
      skip_empty_lines: true
    });

    // Process the CSV data
    const results = {
      successful: [],
      failed: [],
      failedRecordsCsv: ''
    };

    parser.on('readable', function() {
      let record;
      while ((record = parser.read()) !== null) {
        records.push(record);
      }
    });

    parser.on('error', function(err) {
      console.error('CSV parsing error:', err);
      res.status(400).json({ error: 'Invalid CSV format' });
    });

    parser.on('end', async function() {
      // Process each record
      for (const record of records) {
        try {
          // Validate required fields
          const requiredFields = ['tenant_id', 'payment_date', 'payment_type', 'payment_reference', 'amount'];
          const missingFields = requiredFields.filter(field => !record[field]);
          
          if (missingFields.length > 0) {
            record.error = `Missing required fields: ${missingFields.join(', ')}`;
            results.failed.push(record);
            continue;
          }

          // TODO: Implement actual payment processing logic here
          // For now, just mark it as successful
          results.successful.push(record);
        } catch (error) {
          record.error = error.message;
          results.failed.push(record);
        }
      }

      // Generate CSV for failed records if any
      if (results.failed.length > 0) {
        results.failedRecordsCsv = results.failed
          .map(record => {
            const { error, ...rest } = record;
            return Object.values(rest).join(',') + ',' + error;
          })
          .join('\\n');
      }

      res.json(results);
    });

    // Feed the parser with the uploaded file buffer
    parser.write(req.file.buffer);
    parser.end();
  } catch (error) {
    console.error('Error processing file:', error);
    res.status(500).json({ error: 'Error processing file' });
  }
});

const port = process.env.PORT || 8001;
app.listen(port, () => {
  console.log(`Payment processor service listening on port ${port}`);
});
