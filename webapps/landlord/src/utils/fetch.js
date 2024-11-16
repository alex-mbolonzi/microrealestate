import axios from 'axios';
import config from '../config';
import { getStoreInstance } from '../store';
import { isClient, isServer } from '@microrealestate/commonui/utils';

const createAuthApi = (cookie = '') => {
  const api = axios.create({
    baseURL: config.BASE_PATH,
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    }
  });

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

  api.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;

      if (error.response?.status === 403 && !originalRequest._retry) {
        if (isRefreshing) {
          try {
            const token = await new Promise((resolve, reject) => {
              failedQueue.push({ resolve, reject });
            });
            originalRequest.headers['Authorization'] = `Bearer ${token}`;
            return api(originalRequest);
          } catch (err) {
            return Promise.reject(err);
          }
        }

        originalRequest._retry = true;
        isRefreshing = true;

        try {
          const response = await api.post('/authenticator/landlord/refreshtoken', {}, {
            withCredentials: true,
            _retry: true
          });

          const { accessToken } = response.data;
          if (accessToken) {
            originalRequest.headers['Authorization'] = `Bearer ${accessToken}`;
            processQueue(null, accessToken);
            return api(originalRequest);
          }
        } catch (refreshError) {
          processQueue(refreshError, null);
          if (typeof window !== 'undefined') {
            window.location.assign('/');
          }
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      }

      return Promise.reject(error);
    }
  );

  return api;
};

let apiFetch = null;

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
        const accessToken = store?.user?.token;
        if (accessToken) {
          config.headers.Authorization = `Bearer ${accessToken}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    apiFetch.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        if (!error.response) {
          return Promise.reject(new Error('Network error'));
        }

        if (error.response.status !== 401 || originalRequest._retry) {
          return Promise.reject(error);
        }

        if (originalRequest.url.includes('/refreshtoken')) {
          const store = getStoreInstance();
          if (store?.user) {
            await store.user.signOut();
          }
          if (isClient() && window) {
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

        isRefreshing = true;
        originalRequest._retry = true;

        try {
          const store = getStoreInstance();
          const result = await store.user.refreshTokens();

          if (result.status === 200 && result.accessToken) {
            processQueue(null, result.accessToken);
            originalRequest.headers.Authorization = `Bearer ${result.accessToken}`;
            return apiFetch(originalRequest);
          }
          
          processQueue(new Error('Failed to refresh token'));
          if (isClient() && window) {
            window.location.assign('/');
          }
          return Promise.reject(error);
        } catch (err) {
          processQueue(err);
          return Promise.reject(err);
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
