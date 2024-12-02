import * as Express from 'express';
import {
  EnvironmentConfig,
  logger,
  Middlewares,
  Service,
  ServiceError,
  URLUtils
} from '@microrealestate/common';
import axios from 'axios';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

Main();

async function onStartUp(application: Express.Application) {
  exposeHealthCheck(application);
  exposeFrontends(application);
  configureCORS(application);
  exposeServices(application);
}

async function Main() {
  let service;
  try {
    service = Service.getInstance(
      new EnvironmentConfig({
        PORT: Number(process.env.PORT) || 8080,
        EXPOSE_FRONTENDS: process.env.EXPOSE_FRONTENDS === 'true',
        AUTHENTICATOR_URL: process.env.AUTHENTICATOR_URL,
        API_URL: process.env.API_URL,
        PDFGENERATOR_URL: process.env.PDFGENERATOR_URL,
        EMAILER_URL: process.env.EMAILER_URL,
        RESETSERVICE_URL: process.env.RESETSERVICE_URL,
        LANDLORD_FRONTEND_URL: process.env.LANDLORD_FRONTEND_URL,
        LANDLORD_BASE_PATH: process.env.LANDLORD_BASE_PATH,
        TENANT_FRONTEND_URL: process.env.TENANT_FRONTEND_URL,
        TENANT_BASE_PATH: process.env.TENANT_BASE_PATH,
        DOMAIN_URL: process.env.DOMAIN_URL || 'http://localhost', // deprecated
        APP_DOMAIN: process.env.APP_DOMAIN,
        CORS_ENABLED: process.env.CORS_ENABLED === 'true',
        TENANTAPI_URL: process.env.TENANTAPI_URL,
        PAYMENTPROCESSOR_URL: process.env.PAYMENTPROCESSOR_URL
      })
    );
    await service.init({
      name: 'Gateway',
      useRequestParsers: false,
      exposeHealthCheck: false,
      onStartUp
    });
    await service.startUp();
  } catch (error) {
    logger.error(String(error));
    service?.shutDown(-1);
  }
}

function configureCORS(application: Express.Application) {
  const config = Service.getInstance().envConfig.getValues();
  if (config.CORS_ENABLED && (config.DOMAIN_URL || config.APP_DOMAIN)) {
    let domain = config.APP_DOMAIN;
    if (config.DOMAIN_URL) {
      domain = URLUtils.destructUrl(config.DOMAIN_URL).domain;
    }
    const corsOptions = {
      origin: new RegExp(`^https?://(.*\\.)?${domain}$`),
      methods: 'GET,POST,PUT,PATCH,DELETE',
      allowedHeaders:
        //',If-Modified-Since,Range, DNT',
        'Origin,User-Agent,X-Requested-With,Cache-Control,Content-Type,Accept,Authorization,organizationId,timeout',
      credentials: true
    };

    application.use('/api', cors(corsOptions));
    application.use('/tenantapi', cors(corsOptions));
  }
}

function exposeFrontends(application: Express.Application) {
  const config = Service.getInstance().envConfig.getValues();
  if (config.EXPOSE_FRONTENDS) {
    if (!config.LANDLORD_BASE_PATH) {
      throw new Error('LANDLORD_BASE_PATH is not defined');
    }
    application.use(
      config.LANDLORD_BASE_PATH,
      createProxyMiddleware({
        target: config.LANDLORD_FRONTEND_URL,
        ws: true
      })
    );

    if (!config.TENANT_BASE_PATH) {
      throw new Error('TENANT_BASE_PATH is not defined');
    }
    application.use(
      config.TENANT_BASE_PATH,
      createProxyMiddleware({
        target: config.TENANT_FRONTEND_URL,
        ws: true
      })
    );
  }
}

function exposeServices(application: Express.Application) {
  const config = Service.getInstance().envConfig.getValues();

  // Configure payment processor route first, before other routes
  if (config.PAYMENTPROCESSOR_URL) {
    logger.info(`Configuring payment processor route to ${config.PAYMENTPROCESSOR_URL}`);
    const paymentProcessorProxy = createProxyMiddleware({
      target: config.PAYMENTPROCESSOR_URL,
      changeOrigin: true,
      ws: true, // Enable WebSocket proxying
      secure: false, // Don't verify SSL certificates
      pathRewrite: {
        '^/api/paymentprocessor': ''  // Remove the /api/paymentprocessor prefix
      },
      proxyTimeout: 120000, // 2 minutes timeout
      timeout: 120000, // 2 minutes timeout
      onProxyReq: (proxyReq, req, res) => {
        // Log the original request
        logger.info(`Incoming request: ${req.method} ${req.url}`);
        logger.info(`Headers: ${JSON.stringify(req.headers)}`);
        
        // Log where we're sending it
        const targetUrl = `${config.PAYMENTPROCESSOR_URL}${req.url.replace('/api/paymentprocessor', '')}`;
        logger.info(`Proxying to: ${targetUrl}`);
        
        // Preserve the original headers
        if (req.headers.authorization) {
          proxyReq.setHeader('Authorization', req.headers.authorization);
        }
        if (req.headers.organizationid) {
          proxyReq.setHeader('organizationid', req.headers.organizationid);
        }

        // Don't modify content-type for multipart/form-data
        if (req.headers['content-type']?.includes('multipart/form-data')) {
          // Preserve the original content-type with boundary
          proxyReq.setHeader('content-type', req.headers['content-type']);
        } else {
          proxyReq.setHeader('content-type', 'application/json');
        }
      },
      onProxyRes: (proxyRes, req, res) => {
        logger.info(`Received response from payment processor: ${proxyRes.statusCode}`);
        // Log response headers for debugging
        logger.info(`Response headers: ${JSON.stringify(proxyRes.headers)}`);
      },
      onError: (err, req, res) => {
        logger.error(`Payment processor proxy error: ${err.message}`);
        logger.error(`Error stack: ${err.stack}`);
        res.status(502).json({
          error: 'Payment processor service unavailable',
          details: err.message,
          target: config.PAYMENTPROCESSOR_URL
        });
      }
    });

    // Apply the proxy middleware with error handling
    application.use('/api/paymentprocessor', (req, res, next) => {
      logger.info(`Processing ${req.method} request to ${req.url}`);
      try {
        paymentProcessorProxy(req, res, next);
      } catch (error: any) {
        logger.error(`Error in payment processor middleware: ${error.message || String(error)}`);
        res.status(500).json({
          error: 'Internal server error in payment processor middleware',
          details: error.message || String(error)
        });
      }
    });
    logger.info('Payment processor route configured successfully');
  } else {
    logger.warn('PAYMENTPROCESSOR_URL not configured');
  }

  application.use(
    '/api/v2/authenticator',
    createProxyMiddleware({
      target: config.AUTHENTICATOR_URL,
      pathRewrite: { '^/api/v2/authenticator': '' }
    })
  );

  application.use(
    '/api/v2/documents',
    createProxyMiddleware({
      target: config.PDFGENERATOR_URL,
      pathRewrite: { '^/api/v2': '' }
    })
  );

  application.use(
    '/api/v2/templates',
    createProxyMiddleware({
      target: config.PDFGENERATOR_URL,
      pathRewrite: { '^/api/v2': '' }
    })
  );

  application.use(
    '/api/v2',
    createProxyMiddleware({
      target: config.API_URL,
      pathRewrite: { '^/api/v2': '' }
    })
  );

  application.use(
    '/tenantapi',
    createProxyMiddleware({
      target: config.TENANTAPI_URL,
      pathRewrite: { '^/tenantapi': '' }
    })
  );

  // Do not expose reset api on Prod
  if (!config.PRODUCTION) {
    application.use(
      '/api/reset',
      createProxyMiddleware({
        target: config.RESETSERVICE_URL,
        pathRewrite: { '^/api': '' }
      })
    );
  }
}

function exposeHealthCheck(application: Express.Application) {
  application.get(
    '/health',
    Middlewares.asyncWrapper(async (req, res) => {
      const config = Service.getInstance().envConfig.getValues();

      const serviceEndpoints = [
        config.AUTHENTICATOR_URL,
        config.API_URL,
        config.TENANTAPI_URL,
        config.PDFGENERATOR_URL,
        config.EMAILER_URL
      ];

      if (!config.PRODUCTION) {
        serviceEndpoints.push(config.RESETSERVICE_URL);
      }

      const notDefinedEnpoints = serviceEndpoints.filter(
        (endpoint) => !endpoint
      );
      if (notDefinedEnpoints.length) {
        throw new ServiceError(
          `${notDefinedEnpoints.join(', ')} env ${
            notDefinedEnpoints.length > 1 ? 'are' : 'is'
          } not defined`,
          500
        );
      }

      const endpoints = serviceEndpoints.map((endpoint) => {
        const url = new URL(endpoint as string);
        return `${url.origin}/health`;
      });

      if (config.EXPOSE_FRONTENDS) {
        if (!config.LANDLORD_BASE_PATH || !config.TENANT_BASE_PATH) {
          throw new ServiceError(
            'LANDLORD_BASE_PATH or TENANT_BASE_PATH env is not defined',
            500
          );
        }
        endpoints.push(
          `${config.LANDLORD_FRONTEND_URL}${config.LANDLORD_BASE_PATH}/health`
        );
        endpoints.push(
          `${config.TENANT_FRONTEND_URL}${config.TENANT_BASE_PATH}/health`
        );
      }

      const results = await Promise.all(
        endpoints.map(async (endpoint) => {
          try {
            const response = await axios.get(endpoint);
            return { status: response.status };
          } catch (error) {
            return { status: 500, error };
          }
        })
      );
      results.forEach((result, index) => {
        if (result.status !== 200) {
          logger.error(
            `${result.status} GET ${endpoints[index]}\n\t${result.error}`
          );
        } else {
          logger.info(`${result.status} GET ${endpoints[index]}`);
        }
      });
      if (results.some((result) => result.status !== 200)) {
        throw new ServiceError('Some services are down', 500);
      }

      res.status(200).send('OK');
    })
  );
}
