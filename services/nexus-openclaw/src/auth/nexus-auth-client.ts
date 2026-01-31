/**
 * Nexus Authentication Client
 *
 * This module provides JWT token validation and user authentication
 * by integrating with the Nexus Auth service. All incoming requests
 * (both HTTP and WebSocket) are authenticated through this client.
 *
 * Features:
 * - JWT token validation via Nexus Auth HTTP API
 * - Token caching with Redis to reduce auth service load
 * - Automatic token refresh
 * - User info extraction (userId, organizationId, tier)
 *
 * @author Adverant AI
 * @version 1.0.0
 */

import axios, { AxiosInstance } from 'axios';
import * as jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';

/**
 * Authenticated user information
 */
export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  email: string;
  name?: string;
  tier: 'open_source' | 'teams' | 'government';
  permissions: string[];
  exp: number;  // Token expiration timestamp
  iat: number;  // Token issued at timestamp
}

/**
 * Token validation response from Nexus Auth
 */
interface TokenValidationResponse {
  valid: boolean;
  user?: {
    id: string;
    organization_id: string;
    email: string;
    name?: string;
    tier: string;
    permissions: string[];
  };
  error?: string;
}

/**
 * API key validation response
 */
interface ApiKeyValidationResponse {
  valid: boolean;
  user?: {
    id: string;
    organization_id: string;
    email: string;
    name?: string;
    tier: string;
    permissions: string[];
  };
  error?: string;
}

/**
 * Nexus Auth Client
 * Validates JWT tokens and retrieves user information
 */
export class NexusAuthClient {
  private authUrl: string;
  private apiKey: string;
  private httpClient: AxiosInstance;
  private redis: Redis | null = null;
  private cacheTTL: number = 300;  // 5 minutes

  constructor() {
    this.authUrl = process.env.NEXUS_AUTH_URL || 'http://nexus-auth.nexus.svc.cluster.local:9100';
    this.apiKey = process.env.NEXUS_API_KEY || '';

    // Create HTTP client for auth service
    this.httpClient = axios.create({
      baseURL: this.authUrl,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      }
    });

    // Add request/response interceptors for logging
    this.httpClient.interceptors.request.use(
      (config) => {
        return config;
      },
      (error) => {
        console.error('Auth client request error:', error);
        return Promise.reject(error);
      }
    );

    this.httpClient.interceptors.response.use(
      (response) => {
        return response;
      },
      (error) => {
        console.error('Auth client response error:', error);
        return Promise.reject(error);
      }
    );
  }

  /**
   * Initialize with Redis for token caching
   */
  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  /**
   * Validate JWT token and return user information
   *
   * This method first checks the cache, then validates with the auth service.
   * Successful validations are cached to reduce load on the auth service.
   *
   * @param token - JWT token to validate
   * @returns Authenticated user information
   * @throws Error if token is invalid or expired
   */
  async validateToken(token: string): Promise<AuthenticatedUser> {
    // Check cache first
    if (this.redis) {
      const cached = await this.getCachedToken(token);
      if (cached) {
        return cached;
      }
    }

    try {
      // Decode token to check expiration before making HTTP call
      const decoded = this.decodeToken(token);

      // Check if token is expired
      if (decoded.exp && decoded.exp < Date.now() / 1000) {
        throw new Error('Token expired');
      }

      // Validate with auth service
      const response = await this.httpClient.post<TokenValidationResponse>(
        '/v1/auth/validate',
        { token }
      );

      if (!response.data.valid || !response.data.user) {
        throw new Error(response.data.error || 'Invalid token');
      }

      // Map response to AuthenticatedUser
      const tierValue = response.data.user.tier || 'open_source';
      const user: AuthenticatedUser = {
        userId: response.data.user.id,
        organizationId: response.data.user.organization_id,
        email: response.data.user.email,
        name: response.data.user.name,
        tier: (tierValue === 'teams' || tierValue === 'government') ? tierValue : 'open_source',
        permissions: response.data.user.permissions || [],
        exp: decoded.exp || 0,
        iat: decoded.iat || 0
      };

      // Cache the validated token
      if (this.redis) {
        await this.cacheToken(token, user);
      }

      return user;

    } catch (error) {
      // Handle axios errors
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid or expired token');
        }
        if (error.response?.status === 403) {
          throw new Error('Insufficient permissions');
        }
        throw new Error(`Auth service error: ${error.message}`);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Validate API key and return user information
   *
   * @param apiKey - API key to validate
   * @returns Authenticated user information
   * @throws Error if API key is invalid
   */
  async validateApiKey(apiKey: string): Promise<AuthenticatedUser> {
    // Check cache first
    if (this.redis) {
      const cached = await this.getCachedApiKey(apiKey);
      if (cached) {
        return cached;
      }
    }

    try {
      // Validate with auth service
      const response = await this.httpClient.post<ApiKeyValidationResponse>(
        '/v1/auth/validate-api-key',
        { apiKey }
      );

      if (!response.data.valid || !response.data.user) {
        throw new Error(response.data.error || 'Invalid API key');
      }

      // Map response to AuthenticatedUser
      const tierValue = response.data.user.tier || 'open_source';
      const user: AuthenticatedUser = {
        userId: response.data.user.id,
        organizationId: response.data.user.organization_id,
        email: response.data.user.email,
        name: response.data.user.name,
        tier: (tierValue === 'teams' || tierValue === 'government') ? tierValue : 'open_source',
        permissions: response.data.user.permissions || [],
        exp: Math.floor(Date.now() / 1000) + 3600, // API keys don't expire, but cache for 1 hour
        iat: Math.floor(Date.now() / 1000)
      };

      // Cache the validated API key
      if (this.redis) {
        await this.cacheApiKey(apiKey, user);
      }

      return user;

    } catch (error) {
      // Handle axios errors
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid API key');
        }
        if (error.response?.status === 403) {
          throw new Error('Insufficient permissions');
        }
        throw new Error(`Auth service error: ${error.message}`);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Get cached API key validation result
   */
  private async getCachedApiKey(apiKey: string): Promise<AuthenticatedUser | null> {
    if (!this.redis) {
      return null;
    }

    try {
      const cacheKey = `auth:apikey:${apiKey.slice(-16)}`;
      const cached = await this.redis.get(cacheKey);

      if (!cached) {
        return null;
      }

      return JSON.parse(cached) as AuthenticatedUser;

    } catch (error) {
      console.error('Failed to get cached API key:', error);
      return null;
    }
  }

  /**
   * Cache API key validation result
   */
  private async cacheApiKey(apiKey: string, user: AuthenticatedUser): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      const cacheKey = `auth:apikey:${apiKey.slice(-16)}`;
      // Cache API keys for 1 hour
      await this.redis.setex(cacheKey, 3600, JSON.stringify(user));

    } catch (error) {
      console.error('Failed to cache API key:', error);
      // Non-fatal error, continue without caching
    }
  }

  /**
   * Decode JWT token without validation
   * Used for pre-flight checks and extracting claims
   */
  private decodeToken(token: string): any {
    try {
      const decoded = jwt.decode(token);

      if (!decoded || typeof decoded === 'string') {
        throw new Error('Invalid token format');
      }

      return decoded;

    } catch (error) {
      throw new Error('Failed to decode token');
    }
  }

  /**
   * Get cached token validation result
   */
  private async getCachedToken(token: string): Promise<AuthenticatedUser | null> {
    if (!this.redis) {
      return null;
    }

    try {
      // Use token hash as cache key to avoid storing full JWT
      const cacheKey = this.getCacheKey(token);
      const cached = await this.redis.get(cacheKey);

      if (!cached) {
        return null;
      }

      const user = JSON.parse(cached) as AuthenticatedUser;

      // Check if cached token is still valid
      if (user.exp && user.exp < Date.now() / 1000) {
        // Token expired, remove from cache
        await this.redis.del(cacheKey);
        return null;
      }

      return user;

    } catch (error) {
      console.error('Failed to get cached token:', error);
      return null;
    }
  }

  /**
   * Cache token validation result
   */
  private async cacheToken(token: string, user: AuthenticatedUser): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      const cacheKey = this.getCacheKey(token);

      // Calculate TTL based on token expiration
      let ttl = this.cacheTTL;
      if (user.exp) {
        const expiresIn = user.exp - Date.now() / 1000;
        ttl = Math.min(expiresIn, this.cacheTTL);
      }

      await this.redis.setex(cacheKey, Math.floor(ttl), JSON.stringify(user));

    } catch (error) {
      console.error('Failed to cache token:', error);
      // Non-fatal error, continue without caching
    }
  }

  /**
   * Generate cache key from token
   * Uses last 16 characters of token as key (avoids storing full JWT)
   */
  private getCacheKey(token: string): string {
    const suffix = token.slice(-16);
    return `auth:token:${suffix}`;
  }

  /**
   * Invalidate cached token
   */
  async invalidateToken(token: string): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      const cacheKey = this.getCacheKey(token);
      await this.redis.del(cacheKey);
    } catch (error) {
      console.error('Failed to invalidate token:', error);
    }
  }

  /**
   * Check if user has required permission
   */
  hasPermission(user: AuthenticatedUser, permission: string): boolean {
    return user.permissions.includes(permission) || user.permissions.includes('*');
  }

  /**
   * Check if user belongs to organization
   */
  belongsToOrganization(user: AuthenticatedUser, organizationId: string): boolean {
    return user.organizationId === organizationId;
  }

  /**
   * Get user tier quota limits
   */
  getTierQuotas(tier: string): {
    maxSessions: number;
    maxSkillsPerMinute: number;
    maxChannels: number;
    maxCronJobs: number;
    maxMessageHistory: number;
    maxConcurrentSkills: number;
    maxStorageMb: number;
  } {
    const quotas = {
      open_source: {
        maxSessions: 10,
        maxSkillsPerMinute: 10,
        maxChannels: 2,
        maxCronJobs: 5,
        maxMessageHistory: 100,
        maxConcurrentSkills: 3,
        maxStorageMb: 100
      },
      teams: {
        maxSessions: 100,
        maxSkillsPerMinute: 60,
        maxChannels: 5,
        maxCronJobs: 50,
        maxMessageHistory: 1000,
        maxConcurrentSkills: 10,
        maxStorageMb: 1000
      },
      government: {
        maxSessions: -1,  // Unlimited
        maxSkillsPerMinute: -1,
        maxChannels: -1,
        maxCronJobs: -1,
        maxMessageHistory: -1,
        maxConcurrentSkills: -1,
        maxStorageMb: -1
      }
    };

    return quotas[tier as keyof typeof quotas] || quotas.open_source;
  }

  /**
   * Refresh token (if refresh tokens are supported)
   */
  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    try {
      const response = await this.httpClient.post('/v1/auth/refresh', {
        refreshToken
      });

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token
      };

    } catch (error) {
      throw new Error('Failed to refresh token');
    }
  }

  /**
   * Logout user (invalidate all tokens)
   */
  async logout(token: string): Promise<void> {
    try {
      await this.httpClient.post('/v1/auth/logout', { token });

      // Invalidate cache
      await this.invalidateToken(token);

    } catch (error) {
      throw new Error('Failed to logout');
    }
  }

  /**
   * Health check for auth service connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.httpClient.get('/health');
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }
}
