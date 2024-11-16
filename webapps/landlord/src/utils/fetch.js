import axios, { Cancel } from 'axios';
import { isClient, isServer } from '@microrealestate/commonui/utils';

import config from '../config';
import FileDownload from 'js-file-download';
import { getStoreInstance } from '../store';

let apiFetch;
let authApiFetch;
const withCredentials = config.CORS_ENABLED;

const axiosResponseHandlers = [
  (response) => {
    if (response?.config?.method && response?.config?.url && response?.status) {
      console.log(
        `${response.config.method.toUpperCase()} ${response.config.url} ${
          response.status
        }`
      );
    }
    return response;
  },
  (error) => {
    if (
      error?.config?.method &&
      error?.response?.url &&
      error?.response?.status
    ) {
      console.error(
        `${error.config.method.toUpperCase()} ${error.config.url} ${
          error.response.status
        }`
      );
    } else if (
      error?.response?.config?.method &&
      error?.response?.config?.url &&
      error?.response?.status &&
      error?.response?.statusText
    ) {
      console.error(
        `${error.response.config.method.toUpperCase()} ${
          error.response.config.url
        } ${error.response.status} ${error.response.statusText}`
      );
    } else {
      console.error(error.message || error);
    }
    return Promise.reject(error);
  }
];

export const setAccessToken = (accessToken) => {
  apiFetcher();
  if (accessToken) {
    apiFetch.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
  } else if (accessToken === null) {
    delete apiFetch.defaults.headers.common['Authorization'];
  }
};

export const setOrganizationId = (organizationId) => {
  apiFetcher();
  if (organizationId) {
    apiFetch.defaults.headers.organizationId = organizationId;
  } else if (organizationId === null) {
    delete apiFetch.defaults.headers.organizationId;
  }
};

export const setAcceptLanguage = (acceptLanguage) => {
  apiFetcher();
  if (acceptLanguage) {
    apiFetch.defaults.headers['Accept-Language'] = acceptLanguage;
  }
};

let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

const apiFetcher = () => {
  if (!apiFetch) {
    const instance = axios.create({
      baseURL: `${config.BASE_PATH}/api/v2`,
      timeout: 30000,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    instance.interceptors.request.use(
      async (config) => {
        const store = getStoreInstance();
        const accessToken = store?.user?.accessToken;
        if (accessToken) {
          config.headers.Authorization = `Bearer ${accessToken}`;
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    instance.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        // Don't retry if it's not a 401 or it's already been retried
        if (error.response?.status !== 401 || originalRequest._retry) {
          return Promise.reject(error);
        }

        // Don't retry if it's a refresh token request
        if (originalRequest.url.includes('/refreshtoken')) {
          // Clear user data and redirect to login
          const store = getStoreInstance();
          if (store?.user) {
            store.user.signOut();
          }
          if (!isServer()) {
            window.location.assign('/');
          }
          return Promise.reject(error);
        }

        if (isRefreshing) {
          try {
            const token = await new Promise((resolve, reject) => {
              failedQueue.push({ resolve, reject });
            });
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return instance(originalRequest);
          } catch (err) {
            return Promise.reject(err);
          }
        }

        originalRequest._retry = true;
        isRefreshing = true;

        try {
          const store = getStoreInstance();
          const refreshResult = await store.user.refreshTokens();
          
          if (refreshResult.status !== 200 || !refreshResult.accessToken) {
            throw new Error('Token refresh failed');
          }

          processQueue(null, refreshResult.accessToken);
          originalRequest.headers.Authorization = `Bearer ${refreshResult.accessToken}`;
          
          return instance(originalRequest);
        } catch (refreshError) {
          processQueue(refreshError, null);
          
          // Handle 403 specifically
          if (refreshError?.response?.status === 403) {
            const store = getStoreInstance();
            if (store?.user) {
              store.user.signOut();
            }
            if (!isServer()) {
              window.location.assign('/');
            }
          }
          
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      }
    );

    // For logging purposes
    instance.interceptors.response.use(...axiosResponseHandlers);

    apiFetch = instance;
  }
  return apiFetch;
};

export const isTokenValid = (token) => {
  if (!token) return false;
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));

    const { exp } = JSON.parse(jsonPayload);
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Consider token expired if less than 30 seconds remaining
    return exp > (currentTime + 30);
  } catch (e) {
    return false;
  }
};

export const ensureValidToken = async () => {
  const store = getStoreInstance();
  const currentToken = store.user?.accessToken;
  if (!isTokenValid(currentToken)) {
    try {
      const refreshResult = await store.user.refreshTokens();
      if (refreshResult.status !== 200 || !refreshResult.accessToken) {
        throw new Error('Token refresh failed');
      }
      return refreshResult.accessToken;
    } catch (error) {
      window.location.assign(`${config.BASE_PATH}`);
      throw error;
    }
  }
  return currentToken;
};

export const authApiFetcher = (cookie) => {
  if (isClient()) {
    return;
  }

  const axiosConfig = {
    baseURL: `${config.DOCKER_GATEWAY_URL || config.GATEWAY_URL}/api/v2`,
    withCredentials
  };
  if (cookie) {
    axiosConfig.headers = { cookie };
  }
  authApiFetch = axios.create(axiosConfig);

  // For logging purposes
  authApiFetch.interceptors.response.use(...axiosResponseHandlers);

  return authApiFetch;
};

export const buildFetchError = (error) => {
  return {
    error: {
      status: error.response?.status,
      statusText: error.response?.statusText,
      headers: error.response?.headers,
      request: {
        url: error.response?.config?.url,
        method: error.response?.config?.method,
        headers: error.response?.config?.headers,
        baseURL: error.response?.config?.baseURL,
        withCredentials: error.response?.config?.withCredentials
      }
    }
  };
};

export const downloadDocument = async ({ endpoint, documentName }) => {
  const response = await apiFetcher().get(endpoint, {
    responseType: 'blob'
  });
  FileDownload(response.data, documentName);
};

export const uploadDocument = async ({
  endpoint,
  documentName,
  file,
  folder
}) => {
  const formData = new FormData();
  if (folder) {
    formData.append('folder', folder);
  }
  formData.append('fileName', documentName);
  formData.append('file', file);
  return await apiFetcher().post(endpoint, formData, {
    headers: {
      timeout: 30000,
      'Content-Type': 'multipart/form-data'
    }
  });
};
