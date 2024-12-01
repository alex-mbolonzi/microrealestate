import { env } from '@microrealestate/commonui/utils';

const config = {
  APP_NAME: env('APP_NAME'),
  BASE_PATH: process.env.BASE_PATH || '',
  CORS_ENABLED: env('CORS_ENABLED') === 'true',
  DEMO_MODE: env('DEMO_MODE') === 'true',
  DOCKER_GATEWAY_URL: env('DOCKER_GATEWAY_URL'),
  GATEWAY_URL: env('GATEWAY_URL'),
  NODE_ENV: env('NODE_ENV'),
  SIGNUP: env('SIGNUP') === 'true',
  // Allow HTTP in development/testing
  ALLOW_HTTP: process.env.NODE_ENV !== 'production'
};

export default config;
