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

  // Essential security middleware
  router.use(Middlewares.needAccessToken(ACCESS_TOKEN_SECRET));
  router.use(Middlewares.notRoles(['tenant']));
  // update req with the user organizations
  router.use(Middlewares.checkOrganization());
  
  // Add proxy for payment processor service
  const paymentProcessorUrl = process.env.PAYMENTPROCESSOR_URL || 'http://paymentprocessor:8001';
  router.post('/paymentprocessor/process-payments', 
    upload.single('file'),
    (req, res, next) => {
      if (!req.file || !req.body.term) {
        return res.status(400).json({ error: 'File and term are required' });
      }
      next();
    },
    createProxyMiddleware({
      target: paymentProcessorUrl,
      pathRewrite: {
        '^/api/paymentprocessor/process-payments': '/process-payments'
      },
      changeOrigin: true,
      onProxyReq: (proxyReq, req, res) => {
        const formData = new FormData();
        formData.append('file', req.file.buffer, {
          filename: req.file.originalname,
          contentType: 'text/csv'
        });
        formData.append('term', req.body.term);
        proxyReq.setHeader('organizationid', req.headers.organizationid);
        proxyReq.setHeader('Content-Type', `multipart/form-data; boundary=${formData.getBoundary()}`);
        proxyReq.setHeader('Content-Length', formData.getLengthSync());
        formData.pipe(proxyReq);
      }
    })
  );

  const realmsRouter = express.Router();
  realmsRouter.get('/', realmManager.all);
  realmsRouter.get('/:id', realmManager.one);
  realmsRouter.post('/', realmManager.add);
  realmsRouter.patch('/:id', realmManager.update);
  router.use('/realms', realmsRouter);

  const dashboardRouter = express.Router();
  dashboardRouter.get('/', dashboardManager.all);
  router.use('/dashboard', dashboardRouter);

  const leasesRouter = express.Router();
  leasesRouter.get('/', leaseManager.all);
  leasesRouter.get('/:id', leaseManager.one);
  leasesRouter.post('/', leaseManager.add);
  leasesRouter.patch('/:id', leaseManager.update);
  leasesRouter.delete('/:ids', leaseManager.remove);
  router.use('/leases', leasesRouter);

  const occupantsRouter = express.Router();
  occupantsRouter.get('/', occupantManager.all);
  occupantsRouter.get('/:id', occupantManager.one);
  occupantsRouter.post('/', occupantManager.add);
  occupantsRouter.patch('/:id', occupantManager.update);
  occupantsRouter.delete('/:ids', occupantManager.remove);
  router.use('/tenants', occupantsRouter);

  const rentsRouter = express.Router();
  rentsRouter.patch('/payment/:id/:term', rentManager.updateByTerm);
  rentsRouter.get('/tenant/:id', rentManager.rentsOfOccupant);
  rentsRouter.get('/tenant/:id/:term', rentManager.rentOfOccupantByTerm);
  rentsRouter.get('/:year/:month', rentManager.all);
  router.use('/rents', rentsRouter);

  const propertiesRouter = express.Router();
  propertiesRouter.get('/', propertyManager.all);
  propertiesRouter.get('/:id', propertyManager.one);
  propertiesRouter.post('/', propertyManager.add);
  propertiesRouter.patch('/:id', propertyManager.update);
  propertiesRouter.delete('/:ids', propertyManager.remove);
  router.use('/properties', propertiesRouter);

  router.get('/accounting/:year', accountingManager.all);
  router.get('/csv/tenants/incoming/:year', accountingManager.csv.incomingTenants);
  router.get('/csv/tenants/outgoing/:year', accountingManager.csv.outgoingTenants);
  router.get('/csv/settlements/:year', accountingManager.csv.settlements);

  const emailRouter = express.Router();
  emailRouter.post('/', emailManager.send);
  router.use('/emails', emailRouter);

  const apiRouter = express.Router();
  apiRouter.use('/api/v2', router);

  return apiRouter;
}