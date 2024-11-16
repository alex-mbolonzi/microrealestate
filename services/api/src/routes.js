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
        const csvData = req.file.buffer.toString();
        const records = [];
        let processedRows = 0;
        let isFirstRow = true;  // Flag to track the header row
        
        await new Promise((resolve, reject) => {
          csv({ 
            headers: true,
            skipLines: 1,  // Skip the first line (header row)
            skipEmptyLines: true,
            trim: true
          })
            .on('data', (data) => {
              try {
                processedRows++;
                if (processedRows % 100 === 0) {
                  req.setTimeout(300000);
                }

                // Skip empty rows
                if (Object.values(data).every(val => !val)) {
                  return;
                }

                // Validate required fields
                if (!data.tenant_id || !data.payment_date || !data.amount) {
                  throw new ServiceError(`Row ${processedRows + 1}: Missing required fields (tenant_id, payment_date, amount)`, 400);
                }

                // Validate date format
                const paymentDate = new Date(data.payment_date);
                if (isNaN(paymentDate.getTime())) {
                  throw new ServiceError(`Row ${processedRows + 1}: Invalid payment_date format`, 400);
                }

                // Safely parse amount, handling undefined or invalid values
                const amountStr = (data.amount || '').toString();
                const amount = parseFloat(amountStr.replace(/[^0-9.-]+/g, ''));
                if (isNaN(amount)) {
                  throw new ServiceError(`Row ${processedRows + 1}: Invalid amount format`, 400);
                }

                records.push({
                  tenant_reference: data.tenant_id.trim(),
                  payment_date: paymentDate.toISOString().split('T')[0],
                  payment_type: (data.payment_type || 'cash').trim().toLowerCase(),
                  reference: (data.payment_reference || '').trim(),
                  amount: amount,
                  description: (data.description || '').trim(),
                  promo_amount: data.promo_amount ? parseFloat(data.promo_amount.toString().replace(/[^0-9.-]+/g, '')) : 0,
                  promo_note: (data.promo_note || '').trim(),
                  extra_charge: data.extra_charge ? parseFloat(data.extra_charge.toString().replace(/[^0-9.-]+/g, '')) : 0,
                  extra_charge_note: (data.extra_charge_note || '').trim()
                });
              } catch (error) {
                console.error('Error processing CSV row:', error);
                reject(error);
              }
            })
            .on('end', () => {
              if (records.length === 0) {
                reject(new ServiceError('No valid records found in CSV', 400));
              }
              console.log(`Successfully processed ${records.length} records`);
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
