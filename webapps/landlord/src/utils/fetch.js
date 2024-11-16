import axios from 'axios';
import config from '../config';
import { getStoreInstance } from '../store';
import { isClient, isServer } from '@microrealestate/commonui/utils';

let apiFetch = null;
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

export const setAccessToken = (accessToken) => {
  if (apiFetch && accessToken) {
    apiFetch.defaults.headers.Authorization = `Bearer ${accessToken}`;
  } else if (apiFetch) {
    delete apiFetch.defaults.headers.Authorization;
  }
};

export const setOrganizationId = (organizationId) => {
  if (apiFetch && organizationId) {
    apiFetch.defaults.headers['organization-id'] = organizationId;
  } else if (apiFetch) {
    delete apiFetch.defaults.headers['organization-id'];
  }
};

export const apiFetcher = () => {
  if (!apiFetch) {
    const baseURL = isServer() 
      ? config.DOCKER_GATEWAY_URL || config.GATEWAY_URL 
      : config.BASE_PATH || '';

    apiFetch = axios.create({
      baseURL: `${baseURL}/api/v2`,
      timeout: 30000,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    apiFetch.interceptors.request.use(
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

    apiFetch.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        if (!error.response) {
          return Promise.reject(new Error('Network error. Please check your connection.'));
        }

        // Don't retry if it's not 401 or it's already been retried
        if (error.response?.status !== 401 || originalRequest._retry) {
          return Promise.reject(error);
        }

        // Don't retry if it's a refresh token request
        if (originalRequest.url.includes('/refreshtoken')) {
          const store = getStoreInstance();
          if (store?.user) {
            store.user.signOut();
          }
          if (!isServer() && window) {
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
            return apiFetch(originalRequest);
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
          
          return apiFetch(originalRequest);
        } catch (refreshError) {
          processQueue(refreshError, null);
          
          // Handle 403 specifically
          if (refreshError?.response?.status === 403) {
            const store = getStoreInstance();
            if (store?.user) {
              store.user.signOut();
            }
            if (!isServer() && window) {
              window.location.assign('/');
            }
          }
          
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      }
    );
  }

  return apiFetch;
};

export const authApiFetcher = (cookie) => {
  if (isClient()) {
    return;
  }

  const baseURL = config.DOCKER_GATEWAY_URL || config.GATEWAY_URL;
  
  return axios.create({
    baseURL: `${baseURL}/api/v2`,
    headers: {
      Cookie: cookie,
    },
  });
};
