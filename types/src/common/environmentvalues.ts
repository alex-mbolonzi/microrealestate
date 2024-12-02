export type EnvironmentValues = {
  LOGGER_LEVEL?: string;
  PRODUCTION?: boolean;
  PORT?: number;
  MONGO_URL?: string;
  REDIS_URL?: string;
  REDIS_PASSWORD?: string;
  ACCESS_TOKEN_SECRET?: string;
  REFRESH_TOKEN_SECRET?: string;
  RESET_TOKEN_SECRET?: string;
  CIPHER_KEY?: string;
  CIPHER_IV_KEY?: string;
  DEMO_MODE?: boolean;
  EXPOSE_FRONTENDS?: boolean;
  AUTHENTICATOR_URL?: string;
  API_URL?: string;
  PDFGENERATOR_URL?: string;
  RESETSERVICE_URL?: string;
  LANDLORD_FRONTEND_URL?: string;
  LANDLORD_BASE_PATH?: string;
  TENANT_FRONTEND_URL?: string;
  TENANT_BASE_PATH?: string;
  DOMAIN_URL?: string; // deprecated use APP_DOMAIN + APP_PROTOCOL instead
  APP_DOMAIN?: string;
  APP_PROTOCOL?: string;
  CORS_ENABLED?: boolean;
  TENANTAPI_URL?: string;
  EMAILER_URL?: string;
  PAYMENTPROCESSOR_URL?: string; // Added payment processor URL
  DATA_DIRECTORY?: string;
  TEMPLATES_DIRECTORY?: string;
  TEMPORARY_DIRECTORY?: string;
  PDF_DIRECTORY?: string;
  UPLOADS_DIRECTORY?: string;
  UPLOAD_MAX_SIZE?: number;
  ALLOW_SENDING_EMAILS?: boolean;
  APP_NAME?: string;
  LANDLORD_APP_URL?: string;
  TENANT_APP_URL?: string;
  CHROMIUM_BIN?: string;
  GMAIL?: {
    email: string;
    appPassword: string;
    fromEmail: string;
    replyToEmail: string;
    bccEmails: string;
  };
  SMTP?: {
    server: string;
    port: number;
    secure: boolean;
    authentication: boolean;
    username: string;
    password: string;
    fromEmail: string;
    replyToEmail: string;
    bccEmails: string;
  };
  MAILGUN?: {
    apiKey: string;
    domain: string;
    fromEmail: string;
    replyToEmail: string;
    bccEmails: string;
  };
};
