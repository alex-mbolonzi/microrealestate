import axios, { Cancel } from 'axios';
import config from '../config';
import { getStoreInstance } from '../store';
import { isClient, isServer } from '@microrealestate/commonui/utils';

// Basic response logging
const axiosResponseHandlers = [
  response => response,
  error => Promise.reject(error)
];

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
let isRefreshingToken = false;
let requestQueue = [];

export const setAccessToken = (accessToken) => {
  if (apiFetch && accessToken) {
    apiFetch.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
  } else if (apiFetch) {
    delete apiFetch.defaults.headers.common['Authorization'];
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

    // Add request interceptor for auth token
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

        // Handle network errors
        if (!error.response) {
          console.error('Network error:', error);
          return Promise.reject(new Error('Network error. Please check your connection.'));
        }

        const isAuthRequest = [
          '/authenticator/landlord/signin',
          '/authenticator/landlord/refreshtoken',
          '/authenticator/landlord/signout'
        ].includes(originalRequest?.url);

        // Try to refresh token on 401 or 403 (except for auth requests)
        if (
          (error.response?.status === 401 || error.response?.status === 403) &&
          !isAuthRequest &&
          !originalRequest._retry
        ) {
          if (isRefreshingToken) {
            try {
              await new Promise((resolve, reject) => {
                requestQueue.push({ resolve, reject });
              });
              return apiFetch(originalRequest);
            } catch (err) {
              return Promise.reject(err);
            }
          }

          originalRequest._retry = true;
          isRefreshingToken = true;

          try {
            const store = getStoreInstance();
            const refreshResult = await store.user.refreshTokens();

            if (refreshResult.status === 200 && refreshResult.accessToken) {
              // Update auth headers with new token
              setAccessToken(refreshResult.accessToken);

              // Process queued requests
              requestQueue.forEach(request => request.resolve());
              requestQueue = [];

              // Retry original request with new token
              originalRequest.headers.Authorization = `Bearer ${refreshResult.accessToken}`;
              return apiFetch(originalRequest);
            }

            // Handle refresh failure
            requestQueue.forEach(request => 
              request.reject(new Error('Token refresh failed'))
            );
            requestQueue = [];

            if (isClient()) {
              await store.user.signOut();
              window.location.assign('/signin');
            }
            throw new Error('Token refresh failed');
          } catch (refreshError) {
            requestQueue.forEach(request => request.reject(refreshError));
            requestQueue = [];

            if (isClient()) {
              const store = getStoreInstance();
              await store.user.signOut();
              window.location.assign('/signin');
            }
            throw refreshError;
          } finally {
            isRefreshingToken = false;
          }
        }

        // Handle 403 on auth requests
        if (error.response?.status === 403 && isAuthRequest) {
          if (isClient()) {
            const store = getStoreInstance();
            await store.user.signOut();
            window.location.assign('/signin');
          }
          return Promise.reject(error);
        }

        return Promise.reject(error);
      }
    );

    // Add basic response logging
    apiFetch.interceptors.response.use(...axiosResponseHandlers);
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
