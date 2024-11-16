import * as jose from 'jose';

import { action, computed, flow, makeObservable, observable } from 'mobx';
import { apiFetcher, authApiFetcher, setAccessToken } from '../utils/fetch';

import { isServer } from '@microrealestate/commonui/utils';

export const ADMIN_ROLE = 'administrator';
export const RENTER_ROLE = 'renter';
export const ROLES = [ADMIN_ROLE, RENTER_ROLE];
export default class User {
  constructor() {
    this.token = undefined;
    this.tokenExpiry = undefined;
    this.firstName = undefined;
    this.lastName = undefined;
    this.email = undefined;
    this.role = undefined;

    makeObservable(this, {
      token: observable,
      tokenExpiry: observable,
      firstName: observable,
      lastName: observable,
      email: observable,
      role: observable,
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
  }

  *signUp(firstname, lastname, email, password) {
    try {
      yield apiFetcher().post('/authenticator/landlord/signup', {
        firstname,
        lastname,
        email,
        password
      });
      return 200;
    } catch (error) {
      return error.response.status;
    }
  }

  *signIn(email, password) {
    try {
      const response = yield apiFetcher().post(
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

      const { accessToken } = response.data;
      this.setUserFromToken(accessToken);
      return { status: 200 };
    } catch (error) {
      console.error('Sign in error:', error);
      
      // Handle network errors
      if (!error.response) {
        return { 
          status: 500, 
          error: 'Network error. Please check your connection.' 
        };
      }

      // Handle specific error cases
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
      yield apiFetcher().delete('/authenticator/landlord/signout');
    } finally {
      this.firstName = null;
      this.lastName = null;
      this.email = null;
      this.token = null;
      this.tokenExpiry = undefined;
      setAccessToken(null);
    }
  }

  *refreshTokens(context) {
    try {
      let response;
      // request to get the new tokens
      if (isServer()) {
        const authFetchApi = authApiFetcher(context.req.headers.cookie);
        response = yield authFetchApi.post(
          '/authenticator/landlord/refreshtoken',
          {},
          {
            withCredentials: true
          }
        );

        const cookies = response.headers['set-cookie'];
        if (cookies) {
          context.res.setHeader('Set-Cookie', cookies);
        }
      } else {
        response = yield apiFetcher().post(
          '/authenticator/landlord/refreshtoken',
          {},
          {
            withCredentials: true
          }
        );
      }

      // set access token in store
      if (response?.data?.accessToken) {
        const { accessToken } = response.data;
        this.setUserFromToken(accessToken);
        return { status: 200, accessToken };
      }

      // If no token but response is OK, try to sign in again
      if (response?.status === 200) {
        return { status: 401, error: new Error('Session expired. Please sign in again.') };
      }
      
      // Clear user data if no token
      this.firstName = undefined;
      this.lastName = undefined;
      this.email = undefined;
      this.token = undefined;
      this.tokenExpiry = undefined;
      setAccessToken(null);
      return { status: 401, error: new Error('Authentication failed') };
    } catch (error) {
      console.error('Token refresh error:', error);
      
      // Handle specific error cases
      if (error?.response?.status === 403) {
        // Clear user data and redirect to login
        this.firstName = undefined;
        this.lastName = undefined;
        this.email = undefined;
        this.token = undefined;
        this.tokenExpiry = undefined;
        setAccessToken(null);
        
        if (!isServer()) {
          window.location.assign('/');
        }
        
        return { status: 403, error: new Error('Session expired. Please sign in again.') };
      }
      
      // Clear user data on error
      this.firstName = undefined;
      this.lastName = undefined;
      this.email = undefined;
      this.token = undefined;
      this.tokenExpiry = undefined;
      setAccessToken(null);
      
      return { 
        status: error?.response?.status || 500, 
        error: new Error(error?.response?.data?.message || 'Failed to refresh session')
      };
    }
  }

  *forgotPassword(email) {
    try {
      yield apiFetcher().post('/authenticator/landlord/forgotpassword', {
        email
      });
      return 200;
    } catch (error) {
      return error.response.status;
    }
  }

  *resetPassword(resetToken, password) {
    try {
      yield apiFetcher().patch('/authenticator/landlord/resetpassword', {
        resetToken,
        password
      });
      return 200;
    } catch (error) {
      return error.response.status;
    }
  }
}
