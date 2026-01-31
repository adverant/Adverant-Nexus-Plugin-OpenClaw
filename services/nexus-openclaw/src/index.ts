/**
 * OpenClaw Assistant - Main HTTP Server Entry Point
 *
 * This is the production entry point for the OpenClaw marketplace plugin.
 * It initializes the Express HTTP server, WebSocket gateway, database connections,
 * and all middleware required for multi-tenant operation.
 *
 * Architecture:
 * - Express HTTP server for REST API and health checks
 * - Socket.IO WebSocket gateway with Redis adapter for multi-pod scaling
 * - PostgreSQL connection pool for session and skill execution data
 * - Redis connection for WebSocket adapter and rate limiting
 * - Prometheus metrics endpoint
 * - Graceful shutdown handling
 *
 * @author Adverant AI
 * @version 1.0.0
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { register as metricsRegister } from 'prom-client';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Internal imports
import { OpenClawGateway } from './gateway/websocket-gateway';
import { ChannelManager } from './channels/channel-manager';
import { createLogger, Logger } from './utils/logger';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { RateLimiterFactory, rateLimiter } from './middleware/rate-limiter';
import { requireAuth } from './middleware/auth';
import { NexusAuthClient } from './auth/nexus-auth-client';
import { Pool } from 'pg';
import Redis from 'ioredis';

// API Routes
import { sessionsRoutes } from './api/sessions';
import { skillsRoutes } from './api/skills';
import { channelsRoutes } from './api/channels';
import { cronRoutes } from './api/cron';
import { analyticsRoutes } from './api/analytics';

// Configuration
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const PLUGIN_ID = process.env.NEXUS_PLUGIN_ID || 'nexus-openclaw';
const PLUGIN_VERSION = process.env.NEXUS_PLUGIN_VERSION || '1.0.0';

// Build metadata (injected at build time)
const BUILD_ID = process.env.NEXUS_BUILD_ID || 'dev';
const BUILD_TIMESTAMP = process.env.NEXUS_BUILD_TIMESTAMP || new Date().toISOString();
const GIT_COMMIT = process.env.NEXUS_GIT_COMMIT || 'unknown';

// Initialize logger
const logger = createLogger({
  service: PLUGIN_ID,
  version: PLUGIN_VERSION,
  environment: NODE_ENV,
  buildId: BUILD_ID
});

/**
 * Main application class
 * Encapsulates all server initialization and lifecycle management
 */
class OpenClawServer {
  private app: Express;
  private server: http.Server;
  private gateway: OpenClawGateway;
  private channelManager: ChannelManager;
  private database: Pool | null = null;
  private redis: Redis | null = null;
  private authClient: NexusAuthClient;
  private rateLimiterFactory: RateLimiterFactory | null = null;
  private isShuttingDown: boolean = false;

  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.gateway = new OpenClawGateway();
    this.channelManager = new ChannelManager();
    this.authClient = new NexusAuthClient();
  }

  /**
   * Initialize all services and middleware
   */
  async initialize(): Promise<void> {
    logger.info('Initializing OpenClaw server', {
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
      buildId: BUILD_ID,
      buildTimestamp: BUILD_TIMESTAMP,
      gitCommit: GIT_COMMIT,
      nodeEnv: NODE_ENV
    });

    try {
      // Connect to databases
      await this.connectDatabases();

      // Configure Express middleware
      this.configureMiddleware();

      // Mount API routes
      this.mountRoutes();

      // Initialize WebSocket gateway
      await this.initializeWebSocket();

      // Initialize channel manager
      await this.initializeChannelManager();

      // Configure error handling
      this.configureErrorHandling();

      logger.info('OpenClaw server initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize OpenClaw server', { error });
      throw error;
    }
  }

  /**
   * Connect to PostgreSQL and Redis
   */
  private async connectDatabases(): Promise<void> {
    logger.info('Connecting to databases...');

    // Connect to PostgreSQL
    this.database = new Pool({
      host: process.env.POSTGRES_HOST || 'postgres.nexus.svc.cluster.local',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DATABASE || 'unified_nexus',
      user: process.env.POSTGRES_USER || 'nexus',
      password: process.env.POSTGRES_PASSWORD || '',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    // Test connection
    const client = await this.database.connect();
    await client.query('SELECT NOW()');
    client.release();

    logger.info('Connected to PostgreSQL', {
      host: process.env.POSTGRES_HOST,
      database: process.env.POSTGRES_DATABASE
    });

    // Connect to Redis
    const redisUrl = process.env.REDIS_URL || 'redis://redis.nexus.svc.cluster.local:6379';
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });

    // Test connection
    await this.redis.ping();

    // Set Redis in auth client for caching
    this.authClient.setRedis(this.redis);

    // Create rate limiter factory with Redis
    this.rateLimiterFactory = new RateLimiterFactory(this.redis);

    logger.info('Connected to Redis', {
      url: redisUrl
    });
  }

  /**
   * Configure Express middleware stack
   */
  private configureMiddleware(): void {
    // Security headers
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'", 'wss:', 'ws:'],
          scriptSrc: ["'self'", "'unsafe-inline'"],  // Allow inline scripts for Next.js
          styleSrc: ["'self'", "'unsafe-inline'"],   // Allow inline styles
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'", 'data:']
        }
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));

    // CORS configuration
    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow all origins in development, restrict in production
        if (NODE_ENV === 'development' || !origin) {
          callback(null, true);
        } else {
          const allowedOrigins = [
            'https://api.adverant.ai',
            'https://dashboard.adverant.ai',
            'https://adverant.ai'
          ];

          if (allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(new Error('CORS policy violation'));
          }
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    // Request parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Response compression
    this.app.use(compression({
      level: 6,
      threshold: 1024,  // Only compress responses larger than 1KB
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        return compression.filter(req, res);
      }
    }));

    // Request logging
    this.app.use(requestLogger);

    // Rate limiting (tiered based on authentication)
    if (this.rateLimiterFactory) {
      this.app.use(rateLimiter(this.rateLimiterFactory));
    }

    // Trust proxy (for K8s)
    this.app.set('trust proxy', true);
  }

  /**
   * Mount API routes
   */
  private mountRoutes(): void {
    const apiRouter = express.Router();

    // Health check routes (no authentication required)
    this.app.get('/health', (req: Request, res: Response) => {
      res.status(200).json({
        status: 'healthy',
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        buildId: BUILD_ID,
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/ready', async (req: Request, res: Response) => {
      try {
        // Check database connectivity
        if (this.database) {
          const client = await this.database.connect();
          await client.query('SELECT 1');
          client.release();
        }

        // Check Redis connectivity
        if (this.redis) {
          await this.redis.ping();
        }

        res.status(200).json({
          status: 'ready',
          checks: {
            database: this.database ? 'ok' : 'not_configured',
            redis: this.redis ? 'ok' : 'not_configured',
            websocket: this.gateway.isReady() ? 'ok' : 'not_ready'
          }
        });
      } catch (error) {
        logger.error('Readiness check failed', { error });
        res.status(503).json({
          status: 'not_ready',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    this.app.get('/live', (req: Request, res: Response) => {
      if (this.isShuttingDown) {
        res.status(503).json({ status: 'shutting_down' });
      } else {
        res.status(200).json({ status: 'alive' });
      }
    });

    // Prometheus metrics endpoint
    this.app.get('/metrics', async (req: Request, res: Response) => {
      res.set('Content-Type', metricsRegister.contentType);
      res.end(await metricsRegister.metrics());
    });

    // Authenticated API routes - use requireAuth middleware with auth client
    const authMiddleware = requireAuth(this.authClient);
    apiRouter.use('/sessions', authMiddleware, sessionsRoutes);
    apiRouter.use('/skills', authMiddleware, skillsRoutes);
    apiRouter.use('/channels', authMiddleware, channelsRoutes);
    apiRouter.use('/cron', authMiddleware, cronRoutes);
    apiRouter.use('/analytics', authMiddleware, analyticsRoutes);

    // Mount API router
    this.app.use('/openclaw/api/v1', apiRouter);

    // Serve Next.js UI (static export)
    const uiPath = process.env.UI_BUILD_PATH || './ui/out';
    this.app.use('/openclaw/ui', express.static(uiPath, {
      maxAge: '1d',
      etag: true,
      lastModified: true
    }));

    // Fallback to index.html for client-side routing
    this.app.get('/openclaw/ui/*', (req: Request, res: Response) => {
      res.sendFile('index.html', { root: uiPath });
    });

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} not found`,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION
      });
    });
  }

  /**
   * Initialize WebSocket gateway
   */
  private async initializeWebSocket(): Promise<void> {
    const redisUrl = process.env.REDIS_URL || 'redis://redis.nexus.svc.cluster.local:6379';
    await this.gateway.initialize(this.server, redisUrl);

    logger.info('WebSocket gateway initialized', {
      path: '/openclaw/ws'
    });
  }

  /**
   * Initialize channel manager
   */
  private async initializeChannelManager(): Promise<void> {
    if (!this.database) {
      throw new Error('Database must be connected before initializing channel manager');
    }

    await this.channelManager.initialize({
      database: this.database,
      logger,
      onMessage: async (channelId, message) => {
        // Forward messages to skill executor through gateway
        logger.info('Message received from channel', {
          channelId,
          messageId: message.messageId,
          type: message.type
        });

        // Broadcast to WebSocket clients
        this.gateway.broadcastToOrg(
          message.metadata.organizationId as string,
          'channel.message',
          {
            channelId,
            message
          }
        );

        // TODO: Forward to skill executor when implemented
      }
    });

    logger.info('Channel manager initialized');
  }

  /**
   * Configure error handling middleware (must be last)
   */
  private configureErrorHandling(): void {
    this.app.use(errorHandler);
  }

  /**
   * Start HTTP server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(PORT, '0.0.0.0', () => {
        logger.info('OpenClaw server started', {
          port: PORT,
          environment: NODE_ENV,
          buildId: BUILD_ID,
          gitCommit: GIT_COMMIT
        });
        resolve();
      });

      this.server.on('error', (error: Error) => {
        logger.error('Server startup error', { error });
        reject(error);
      });
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    logger.info('Initiating graceful shutdown...');

    try {
      // Stop accepting new connections
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => {
          if (err) {
            logger.error('Error closing HTTP server', { error: err });
            reject(err);
          } else {
            logger.info('HTTP server closed');
            resolve();
          }
        });
      });

      // Close WebSocket connections gracefully
      await this.gateway.shutdown();
      logger.info('WebSocket gateway closed');

      // Shutdown channel manager
      await this.channelManager.shutdown();
      logger.info('Channel manager closed');

      // Close database connections
      if (this.database) {
        await this.database.end();
        logger.info('Database disconnected');
      }

      // Close Redis connections
      if (this.redis) {
        await this.redis.quit();
        logger.info('Redis disconnected');
      }

      logger.info('Graceful shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown', { error });
      throw error;
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const server = new OpenClawServer();

  try {
    // Initialize server
    await server.initialize();

    // Start listening
    await server.start();

    // Graceful shutdown handlers
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM signal');
      await server.shutdown();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT signal');
      await server.shutdown();
      process.exit(0);
    });

    // Unhandled rejection handler
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Promise Rejection', {
        reason,
        promise
      });
    });

    // Uncaught exception handler
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception', { error });
      process.exit(1);
    });

  } catch (error) {
    logger.error('Fatal error during startup', { error });
    process.exit(1);
  }
}

// Start the server
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { OpenClawServer };
