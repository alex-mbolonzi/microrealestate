import * as accountingManager from './managers/accountingmanager.js';
import * as dashboardManager from './managers/dashboardmanager.js';
import * as emailManager from './managers/emailmanager.js';
import * as leaseManager from './managers/leasemanager.js';
import * as occupantManager from './managers/occupantmanager.js';
import * as propertyManager from './managers/propertymanager.js';
import * as realmManager from './managers/realmmanager.js';
import * as rentManager from './managers/rentmanager.js';
import { Middlewares, Service } from '@microrealestate/common';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import multer from 'multer';
import FormData from 'form-data';

export default function routes() {
  const { ACCESS_TOKEN_SECRET } = Service.getInstance().envConfig.getValues();
  const router = express.Router();
  
  // Configure multer for file uploads
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024 // 5MB limit
    }
  });

  router.use(
    // protect the api access by checking the access token
    Middlewares.needAccessToken(ACCESS_TOKEN_SECRET),
    // update req with the user organizations
    Middlewares.checkOrganization(),
    // forbid access to tenant
    Middlewares.notRoles(['tenant'])
  );
  
  // Add proxy for payment processor service
  const paymentProcessorUrl = process.env.PAYMENTPROCESSOR_URL || 'http://paymentprocessor:8001';
  router.post('/paymentprocessor/upload', 
    upload.single('file'),
    (req, res, next) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      next();
    },
    createProxyMiddleware({
      target: paymentProcessorUrl,
      pathRewrite: {
        '^/api/paymentprocessor/upload': '/process-payments'
      },
      changeOrigin: true,
      onProxyReq: (proxyReq, req, res) => {
        try {
          // Handle the file buffer
          if (req.file) {
            const formData = new FormData();
            formData.append('file', req.file.buffer, {
              filename: req.file.originalname,
              contentType: 'text/csv'
            });
            
            // Set the correct headers for multipart/form-data
            const contentType = `multipart/form-data; boundary=${formData.getBoundary()}`;
            proxyReq.setHeader('Content-Type', contentType);
            
            // Get the content length synchronously
            const contentLength = formData.getLengthSync();
            proxyReq.setHeader('Content-Length', contentLength);
            
            // Pipe the form data to the proxy request
            formData.pipe(proxyReq);
          }
        } catch (error) {
          console.error('Error in onProxyReq:', error);
          res.status(500).json({ error: 'Error processing file upload' });
        }
      },
      onProxyRes: (proxyRes, req, res) => {
        // Log the response status and headers for debugging
        console.log('Payment processor response:', {
          status: proxyRes.statusCode,
          headers: proxyRes.headers
        });
      },
      onError: (err, req, res) => {
        console.error('Payment processor proxy error:', err);
        res.status(502).json({ 
          error: 'Payment processor service unavailable',
          details: err.message 
        });
      }
    })
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
  rentsRouter.patch(
    '/payment/:id/:term',
    Middlewares.asyncWrapper(rentManager.updateByTerm)
  );
  rentsRouter.get(
    '/tenant/:id',
    Middlewares.asyncWrapper(rentManager.rentsOfOccupant)
  );
  rentsRouter.get(
    '/tenant/:id/:term',
    Middlewares.asyncWrapper(rentManager.rentOfOccupantByTerm)
  );
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