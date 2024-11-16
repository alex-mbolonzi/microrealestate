import * as jose from 'jose';
import { action, computed, flow, makeObservable, observable } from 'mobx';
import { apiFetcher, setAccessToken } from '../utils/fetch';
import { isServer } from '@microrealestate/commonui/utils';
import axios from 'axios';
import config from '../config';

export const ADMIN_ROLE = 'administrator';
export const RENTER_ROLE = 'renter';
export const ROLES = [ADMIN_ROLE, RENTER_ROLE];

const createAuthApi = (cookie) => {
  if (!isServer()) {
    return null;
  }

  const baseURL = config.DOCKER_GATEWAY_URL || config.GATEWAY_URL;
  return axios.create({
    baseURL: `${baseURL}/api/v2`,
    headers: {
      Cookie: cookie,
    },
  });
};

export default class User {
  constructor() {
    this.token = undefined;
    this.tokenExpiry = undefined;
    this.firstName = undefined;
    this.lastName = undefined;
    this.email = undefined;
    this.role = undefined;
    this.refreshing = false;

    makeObservable(this, {
      token: observable,
      tokenExpiry: observable,
      firstName: observable,
      lastName: observable,
      email: observable,
      role: observable,
      refreshing: observable,
      signedIn: computed,
      isAdministrator: computed,
      setRole: action,
      setUserFromToken: action,
      signUp: flow,
      signIn: flow,
      signOut: flow,
      refreshTokens: flow,
      forgotPassword: flow,
      resetPassword: flow
    });
  }

  get signedIn() {
    return !!this.token;
  }

  get isAdministrator() {
    return this.role === ADMIN_ROLE;
  }

  setRole(role) {
    this.role = role;
  }

  setUserFromToken(accessToken) {
    if (!accessToken) {
      throw new Error('No access token provided');
    }

    try {
      const {
        account: { firstname, lastname, email },
        exp
      } = jose.decodeJwt(accessToken);
      
      this.firstName = firstname;
      this.lastName = lastname;
      this.email = email;
      this.token = accessToken;
      this.tokenExpiry = exp;
      setAccessToken(accessToken);
    } catch (error) {
      console.error('Error decoding token:', error);
      throw new Error('Invalid token format');
    }
  }

  *signUp(firstname, lastname, email, password) {
    try {
      const api = apiFetcher();
      if (!api) {
        throw new Error('API client not initialized');
      }

      const response = yield api.post('/authenticator/landlord/signup', {
        firstname,
        lastname,
        email,
        password
      });

      return { status: response.status };
    } catch (error) {
      console.error('Sign up error:', error);
      
      if (!error.response) {
        return { 
          status: 500, 
          error: 'Network error. Please check your connection.' 
        };
      }

      switch (error.response.status) {
        case 409:
          return { 
            status: 409, 
            error: 'Email already exists.' 
          };
        case 400:
          return { 
            status: 400, 
            error: 'Invalid input. Please check your information.' 
          };
        default:
          return { 
            status: error.response.status || 500,
            error: error.response.data?.message || 'Failed to sign up. Please try again.'
          };
      }
    }
  }

  *signIn(email, password) {
    try {
      const api = apiFetcher();
      if (!api) {
        throw new Error('API client not initialized');
      }

      const response = yield api.post(
        '/authenticator/landlord/signin',
        {
          email,
          password
        },
        {
          withCredentials: true
        }
      );
      
      if (!response?.data?.accessToken) {
        throw new Error('No access token received');
      }

      this.setUserFromToken(response.data.accessToken);
      return { status: 200 };
    } catch (error) {
      console.error('Sign in error:', error);
      
      if (!error.response) {
        return { 
          status: 500, 
          error: 'Network error. Please check your connection.' 
        };
      }

      switch (error.response.status) {
        case 401:
          return { 
            status: 401, 
            error: 'Invalid email or password.' 
          };
        case 403:
          return { 
            status: 403, 
            error: 'Account is locked. Please contact support.' 
          };
        case 404:
          return { 
            status: 404, 
            error: 'Account not found.' 
          };
        default:
          return { 
            status: error.response.status || 500,
            error: error.response.data?.message || 'Failed to sign in. Please try again.'
          };
      }
    }
  }

  *signOut() {
    try {
      const api = apiFetcher();
      if (!api) {
        throw new Error('API client not initialized');
      }

      yield api.delete('/authenticator/landlord/signout', {
        withCredentials: true
      });
    } finally {
      this.firstName = null;
      this.lastName = null;
      this.email = null;
      this.token = null;
      this.tokenExpiry = null;
      this.role = null;
      setAccessToken(null);
    }
  }

  *refreshTokens(context) {
    // Prevent multiple simultaneous refresh attempts
    if (this.refreshing) {
      return { status: 409, error: 'Token refresh already in progress' };
    }

    try {
      this.refreshing = true;
      let response;

      if (isServer()) {
        const authApi = createAuthApi(context?.req?.headers?.cookie);
        if (!authApi) {
          throw new Error('Auth API client not initialized');
        }

        response = yield authApi.post(
          '/authenticator/landlord/refreshtoken',
          {},
          {
            withCredentials: true,
            headers: {
              Cookie: context?.req?.headers?.cookie
            }
          }
        );

        // Set cookies in response if available
        const cookies = response.headers['set-cookie'];
        if (cookies && context?.res) {
          context.res.setHeader('Set-Cookie', cookies);
        }
      } else {
        const api = apiFetcher();
        if (!api) {
          throw new Error('API client not initialized');
        }

        response = yield api.post(
          '/authenticator/landlord/refreshtoken',
          {},
          {
            withCredentials: true
          }
        );
      }

      if (!response?.data?.accessToken) {
        throw new Error('No access token received from refresh');
      }

      this.setUserFromToken(response.data.accessToken);
      return { 
        status: 200,
        accessToken: response.data.accessToken
      };
    } catch (error) {
      console.error('Token refresh error:', error);

      // Handle specific error cases
      if (error?.response?.status === 403) {
        yield this.signOut();
        if (!isServer() && window) {
          window.location.assign('/');
        }
        return {
          status: 403,
          error: 'Session expired. Please sign in again.'
        };
      }

      return {
        status: error.response?.status || 500,
        error: error.response?.data?.message || 'Failed to refresh token'
      };
    } finally {
      this.refreshing = false;
    }
  }

  *forgotPassword(email) {
    try {
      const api = apiFetcher();
      if (!api) {
        throw new Error('API client not initialized');
      }

      const response = yield api.post('/authenticator/landlord/forgotpassword', {
        email
      });
      return { status: response.status };
    } catch (error) {
      console.error('Forgot password error:', error);
      return {
        status: error.response?.status || 500,
        error: error.response?.data?.message || 'Failed to process forgot password request'
      };
    }
  }

  *resetPassword(resetToken, password) {
    try {
      const api = apiFetcher();
      if (!api) {
        throw new Error('API client not initialized');
      }

      const response = yield api.patch('/authenticator/landlord/resetpassword', {
        resetToken,
        password
      });
      return { status: response.status };
    } catch (error) {
      console.error('Reset password error:', error);
      return {
        status: error.response?.status || 500,
        error: error.response?.data?.message || 'Failed to reset password'
      };
    }
  }
}
