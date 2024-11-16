import * as accountingManager from './managers/accountingmanager.js';
import * as dashboardManager from './managers/dashboardmanager.js';
import * as emailManager from './managers/emailmanager.js';
import * as leaseManager from './managers/leasemanager.js';
import * as occupantManager from './managers/occupantmanager.js';
import * as propertyManager from './managers/propertymanager.js';
import * as realmManager from './managers/realmmanager.js';
import * as rentManager from './managers/rentmanager.js';
import express from 'express';
import { Middlewares, Service, ServiceError } from '@microrealestate/common';
import multer from 'multer';
import csv from 'csv-parser';

export default function routes() {
  const { ACCESS_TOKEN_SECRET } = Service.getInstance().envConfig.getValues();
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage() });
  router.use(
    // protect the api access by checking the access token
    Middlewares.needAccessToken(ACCESS_TOKEN_SECRET),
    // update req with the user organizations
    Middlewares.checkOrganization(),
    // forbid access to tenant
    Middlewares.notRoles(['tenant'])
  );

  const realmsRouter = express.Router();
  realmsRouter.get('/', realmManager.all);
  realmsRouter.get('/:id', realmManager.one);
  realmsRouter.post('/', Middlewares.asyncWrapper(realmManager.add));
  realmsRouter.patch('/:id', Middlewares.asyncWrapper(realmManager.update));
  router.use('/realms', realmsRouter);

  const dashboardRouter = express.Router();
  dashboardRouter.get('/', Middlewares.asyncWrapper(dashboardManager.all));
  router.use('/dashboard', dashboardRouter);

  const leasesRouter = express.Router();
  leasesRouter.get('/', Middlewares.asyncWrapper(leaseManager.all));
  leasesRouter.get('/:id', Middlewares.asyncWrapper(leaseManager.one));
  leasesRouter.post('/', Middlewares.asyncWrapper(leaseManager.add));
  leasesRouter.patch('/:id', Middlewares.asyncWrapper(leaseManager.update));
  leasesRouter.delete('/:ids', Middlewares.asyncWrapper(leaseManager.remove));
  router.use('/leases', leasesRouter);

  const occupantsRouter = express.Router();
  occupantsRouter.get('/', Middlewares.asyncWrapper(occupantManager.all));
  occupantsRouter.get('/:id', Middlewares.asyncWrapper(occupantManager.one));
  occupantsRouter.post('/', Middlewares.asyncWrapper(occupantManager.add));
  occupantsRouter.patch(
    '/:id',
    Middlewares.asyncWrapper(occupantManager.update)
  );
  occupantsRouter.delete(
    '/:ids',
    Middlewares.asyncWrapper(occupantManager.remove)
  );
  router.use('/tenants', occupantsRouter);

  const rentsRouter = express.Router();
  rentsRouter.post('/upload', 
    upload.single('file'), 
    Middlewares.asyncWrapper(async (req, res) => {
      if (!req.file) {
        throw new ServiceError('No file uploaded', 400);
      }

      try {
        // Normalize line endings and remove any trailing empty lines
        const csvData = req.file.buffer
          .toString()
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .trim();

        const records = [];
        let processedRows = 0;
        
        // Count total rows (excluding header)
        const lines = csvData.split('\n');
        const totalDataRows = lines.length - 1; // Exclude header
        console.log(`CSV contains ${lines.length} total rows (${totalDataRows} data rows)`);
        
        // Validate header
        const headerRow = lines[0].trim();
        const expectedHeader = 'tenant_id,payment_date,payment_type,payment_reference,amount';
        if (headerRow !== expectedHeader) {
          console.error('Invalid header row:', headerRow);
          throw new ServiceError(`Invalid CSV format. Expected header: ${expectedHeader}`, 400);
        }
        
        await new Promise((resolve, reject) => {
          csv({ 
            headers: ['tenant_id', 'payment_date', 'payment_type', 'payment_reference', 'amount'],
            skipEmptyLines: 'greedy', // Skip lines that are empty or only contain whitespace
            trim: true,
            skipLines: 1  // Skip header row
          })
            .on('data', (data) => {
              try {
                processedRows++;
                console.log(`Processing row ${processedRows} of ${totalDataRows}:`, data);

                // Validate required fields
                if (!data.tenant_id?.trim() || !data.payment_date?.trim() || !data.amount?.trim()) {
                  const error = `Row ${processedRows}: Missing required fields (tenant_id: ${data.tenant_id || 'missing'}, payment_date: ${data.payment_date || 'missing'}, amount: ${data.amount || 'missing'})`;
                  console.error(error);
                  throw new ServiceError(error, 400);
                }

                // Parse and validate date format (MM/DD/YYYY)
                const [month, day, year] = data.payment_date.split('/');
                const paymentDate = new Date(year, month - 1, day);
                if (isNaN(paymentDate.getTime())) {
                  const error = `Row ${processedRows}: Invalid payment_date format. Expected MM/DD/YYYY, got ${data.payment_date}`;
                  console.error(error);
                  throw new ServiceError(error, 400);
                }

                // Safely parse amount, handling undefined or invalid values
                const amountStr = data.amount.trim();
                const amount = parseFloat(amountStr.replace(/[^0-9.-]+/g, ''));
                if (isNaN(amount) || amount <= 0) {
                  const error = `Row ${processedRows}: Invalid amount format or negative value, got ${data.amount}`;
                  console.error(error);
                  throw new ServiceError(error, 400);
                }

                const record = {
                  tenant_reference: data.tenant_id.trim(),
                  payment_date: paymentDate.toISOString().split('T')[0],
                  payment_type: (data.payment_type || 'cash').trim().toLowerCase(),
                  reference: (data.payment_reference || '').trim(),
                  amount: amount,
                  description: '',
                  promo_amount: 0,
                  promo_note: '',
                  extra_charge: 0,
                  extra_charge_note: ''
                };

                records.push(record);
                console.log(`Successfully processed payment for tenant ${data.tenant_id}: ${amount}`);
              } catch (error) {
                console.error(`Error processing row ${processedRows}:`, error);
                reject(error);
              }
            })
            .on('end', () => {
              console.log(`CSV parsing complete. Processed ${processedRows} rows out of ${totalDataRows} expected rows`);
              
              if (records.length === 0) {
                reject(new ServiceError('No valid records found in CSV', 400));
              }
              
              if (processedRows !== totalDataRows) {
                const error = `Not all rows were processed. Expected ${totalDataRows} rows, but processed ${processedRows}`;
                console.error(error);
                reject(new ServiceError(error, 400));
              }
              
              resolve();
            })
            .on('error', (error) => {
              console.error('CSV parsing error:', error);
              reject(new ServiceError(`CSV parsing error: ${error.message}`, 400));
            })
            .write(csvData);
        });

        if (!req.body) req.body = {};
        req.body.payments = records;

        console.log(`Starting bulk payment upload for ${records.length} records`);
        await rentManager.uploadBulkPayments(req, res);
      } catch (error) {
        console.error('CSV Processing Error:', error);
        const errorMessage = error.message || 'Failed to process CSV file';
        const errorStatus = error.status || 400;
        throw new ServiceError(errorMessage, errorStatus);
      }
    })
  );
  rentsRouter.patch('/payment/:id/:term', Middlewares.asyncWrapper(rentManager.updateByTerm));
  rentsRouter.get('/tenant/:id/:term', Middlewares.asyncWrapper(rentManager.rentOfOccupantByTerm));
  rentsRouter.get('/:year/:month', Middlewares.asyncWrapper(rentManager.all));
  router.use('/rents', rentsRouter);

  const propertiesRouter = express.Router();
  propertiesRouter.get('/', Middlewares.asyncWrapper(propertyManager.all));
  propertiesRouter.get('/:id', Middlewares.asyncWrapper(propertyManager.one));
  propertiesRouter.post('/', Middlewares.asyncWrapper(propertyManager.add));
  propertiesRouter.patch(
    '/:id',
    Middlewares.asyncWrapper(propertyManager.update)
  );
  propertiesRouter.delete(
    '/:ids',
    Middlewares.asyncWrapper(propertyManager.remove)
  );
  router.use('/properties', propertiesRouter);

  router.get(
    '/accounting/:year',
    Middlewares.asyncWrapper(accountingManager.all)
  );
  router.get(
    '/csv/tenants/incoming/:year',
    Middlewares.asyncWrapper(accountingManager.csv.incomingTenants)
  );
  router.get(
    '/csv/tenants/outgoing/:year',
    Middlewares.asyncWrapper(accountingManager.csv.outgoingTenants)
  );
  router.get(
    '/csv/settlements/:year',
    Middlewares.asyncWrapper(accountingManager.csv.settlements)
  );

  const emailRouter = express.Router();
  emailRouter.post('/', Middlewares.asyncWrapper(emailManager.send));
  router.use('/emails', emailRouter);

  const apiRouter = express.Router();
  apiRouter.use('/api/v2', router);

  return apiRouter;
}
