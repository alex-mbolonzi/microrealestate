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

      // Only retry for 403 errors that haven't been retried yet
      if (error.response?.status === 403 && !originalRequest._retry) {
        if (isRefreshing) {
          return new Promise((resolve, reject) => {
            failedQueue.push({ resolve, reject });
          }).then((token) => {
            originalRequest.headers['Authorization'] = `Bearer ${token}`;
            return api(originalRequest);
          }).catch((err) => {
            return Promise.reject(err);
          });
        }

        originalRequest._retry = true;
        isRefreshing = true;

        try {
          // Ensure cookies are sent with the refresh request
          const response = await api.post('/authenticator/landlord/refreshtoken', {}, {
            withCredentials: true,
            headers: {
              ...(cookie ? { Cookie: cookie } : {}),
              'Content-Type': 'application/json'
            },
            _retry: true
          });

          const { accessToken } = response.data;
          if (!accessToken) {
            throw new Error('No access token received');
          }

          // Update authorization header for future requests
          api.defaults.headers['Authorization'] = `Bearer ${accessToken}`;
          originalRequest.headers['Authorization'] = `Bearer ${accessToken}`;

          // Process any queued requests
          processQueue(null, accessToken);

          return api(originalRequest);
        } catch (refreshError) {
          processQueue(refreshError, null);
          
          // Clear auth state and redirect to login on refresh failure
          if (typeof window !== 'undefined') {
            const store = getStoreInstance();
            if (store?.user) {
              store.user.signOut().then(() => {
                window.location.assign('/');
              });
            } else {
              window.location.assign('/');
            }
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

    let isRefreshingToken = false;
    let requestQueue = []; // used when parallel requests
    apiFetch.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        const isLoginRequest =
          originalRequest?.url === '/authenticator/landlord/signin' &&
          originalRequest?.method === 'post';

        // Try to refresh token on 401 or 403 (except for login requests)
        if (
          (error.response?.status === 401 || error.response?.status === 403) &&
          !isLoginRequest &&
          !originalRequest._retry
        ) {
          if (isRefreshingToken) {
            // queued incoming request while refresh token is running
            return new Promise(function (resolve, reject) {
              requestQueue.push({ resolve, reject });
            })
              .then(async () => {
                // use latest authorization token
                originalRequest.headers['Authorization'] =
                  apiFetch.defaults.headers.common['Authorization'];
                return apiFetch(originalRequest);
              })
              .catch((err) => Promise.reject(err));
          }

          originalRequest._retry = true;
          isRefreshingToken = true;

          try {
            const store = getStoreInstance();
            const refreshResult = await store.user.refreshTokens();

            if (refreshResult.status === 200 && refreshResult.accessToken) {
              // run all requests queued
              requestQueue.forEach((request) => {
                request.resolve();
              });

              // use latest authorization token
              originalRequest.headers['Authorization'] =
                apiFetch.defaults.headers.common['Authorization'];

              return apiFetch(originalRequest);
            } else {
              // If refresh failed, redirect to login
              if (isClient()) {
                await store.user.signOut();
                window.location.assign(`${config.BASE_PATH}`);
              }
              throw new Cancel('Operation canceled - refresh token failed');
            }
          } catch (refreshError) {
            // If refresh throws an error, redirect to login
            if (isClient()) {
              const store = getStoreInstance();
              await store.user.signOut();
              window.location.assign(`${config.BASE_PATH}`);
            }
            throw new Cancel('Operation canceled - refresh token error');
          } finally {
            isRefreshingToken = false;
            requestQueue = [];
          }
        }
        return Promise.reject(error);
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
