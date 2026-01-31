/**
 * OpenClaw WebSocket Gateway
 *
 * Real-time communication layer using Socket.IO with Redis adapter
 * for multi-pod horizontal scaling. Handles:
 * - Session management (create, update, close)
 * - Message streaming (user/assistant)
 * - Skill execution events (started, progress, completed, error)
 * - Cron job notifications
 * - Channel status updates
 *
 * @author Adverant AI
 * @version 1.0.0
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as HTTPServer } from 'http';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { NexusAuthClient, AuthenticatedUser } from '../auth/nexus-auth-client';
import { logger } from '../utils/logger';

/**
 * Socket data attached to each connection
 */
interface SocketData {
  userId: string;
  organizationId: string;
  email: string;
  tier: string;
  sessionId?: string;
  connectedAt: Date;
}

/**
 * Message payload structure
 */
interface MessagePayload {
  sessionId: string;
  content: string;
  attachments?: Array<{
    type: 'image' | 'document' | 'audio';
    url: string;
    name: string;
    size: number;
  }>;
}

/**
 * Skill execution payload
 */
interface SkillExecutionPayload {
  sessionId: string;
  skillName: string;
  params?: Record<string, unknown>;
}

/**
 * Session creation payload
 */
interface SessionCreatePayload {
  channelType: 'web' | 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'signal' | 'teams';
  channelId?: string;
  context?: Record<string, unknown>;
}

/**
 * OpenClaw WebSocket Gateway
 */
export class OpenClawGateway {
  private io: SocketIOServer | null = null;
  private authClient: NexusAuthClient;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;
  private connectionCount: number = 0;

  constructor() {
    this.authClient = new NexusAuthClient();
  }

  /**
   * Initialize the WebSocket gateway
   */
  async initialize(httpServer: HTTPServer, redisUrl?: string): Promise<void> {
    // Create Socket.IO server
    this.io = new SocketIOServer(httpServer, {
      path: '/openclaw/ws',
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // Set up Redis adapter for multi-pod scaling
    if (redisUrl) {
      try {
        this.pubClient = new Redis(redisUrl);
        this.subClient = this.pubClient.duplicate();

        this.io.adapter(createAdapter(this.pubClient, this.subClient));
        logger.info('WebSocket gateway using Redis adapter', { redisUrl });
      } catch (error) {
        logger.warn('Failed to initialize Redis adapter, using in-memory', { error });
      }
    }

    // Authentication middleware
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token ||
          socket.handshake.headers.authorization?.replace('Bearer ', '');

        if (!token) {
          return next(new Error('Authentication required'));
        }

        // Validate token with Nexus Auth
        const user = await this.authClient.validateToken(token);

        // Attach user data to socket
        socket.data = {
          userId: user.userId,
          organizationId: user.organizationId,
          email: user.email,
          tier: user.tier,
          connectedAt: new Date(),
        } as SocketData;

        next();
      } catch (error) {
        logger.warn('WebSocket auth failed', { errorMessage: (error as Error).message });
        next(new Error('Invalid or expired token'));
      }
    });

    // Connection handler
    this.io.on('connection', (socket) => this.handleConnection(socket));

    logger.info('WebSocket gateway initialized', {
      path: '/openclaw/ws',
      transports: ['websocket', 'polling'],
    });
  }

  /**
   * Handle new socket connection
   */
  private handleConnection(socket: Socket): void {
    const data = socket.data as SocketData;
    this.connectionCount++;

    logger.info('Client connected', {
      socketId: socket.id,
      userId: data.userId,
      organizationId: data.organizationId,
    });

    // Join organization room for multi-tenancy
    socket.join(`org:${data.organizationId}`);

    // Join user-specific room
    socket.join(`user:${data.userId}`);

    // Send connection confirmation
    socket.emit('connected', {
      socketId: socket.id,
      userId: data.userId,
      organizationId: data.organizationId,
      tier: data.tier,
      timestamp: new Date().toISOString(),
    });

    // Register event handlers
    socket.on('session.create', (payload) => this.handleSessionCreate(socket, payload));
    socket.on('session.join', (sessionId) => this.handleSessionJoin(socket, sessionId));
    socket.on('session.leave', (sessionId) => this.handleSessionLeave(socket, sessionId));

    socket.on('message.send', (payload) => this.handleMessageSend(socket, payload));
    socket.on('skill.execute', (payload) => this.handleSkillExecute(socket, payload));

    socket.on('ping', (callback) => {
      if (typeof callback === 'function') {
        callback();
      }
    });

    socket.on('disconnect', (reason) => this.handleDisconnect(socket, reason));
    socket.on('error', (error) => this.handleError(socket, error));
  }

  /**
   * Handle session creation
   */
  private async handleSessionCreate(socket: Socket, payload: SessionCreatePayload): Promise<void> {
    const data = socket.data as SocketData;

    try {
      const sessionId = uuidv4();
      const session = {
        sessionId,
        userId: data.userId,
        organizationId: data.organizationId,
        channelType: payload.channelType || 'web',
        channelId: payload.channelId,
        context: payload.context || {},
        active: true,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };

      // Join session room
      socket.join(`session:${sessionId}`);
      socket.data.sessionId = sessionId;

      // Emit session created event
      socket.emit('session.created', session);

      // Notify organization
      this.broadcastToOrg(data.organizationId, 'session.new', {
        sessionId,
        userId: data.userId,
        channelType: payload.channelType,
        createdAt: session.createdAt,
      });

      logger.info('Session created', { sessionId, userId: data.userId });
    } catch (error) {
      socket.emit('error', {
        event: 'session.create',
        error: (error as Error).message,
      });
    }
  }

  /**
   * Handle session join
   */
  private handleSessionJoin(socket: Socket, sessionId: string): void {
    socket.join(`session:${sessionId}`);
    socket.data.sessionId = sessionId;
    socket.emit('session.joined', { sessionId });
  }

  /**
   * Handle session leave
   */
  private handleSessionLeave(socket: Socket, sessionId: string): void {
    socket.leave(`session:${sessionId}`);
    if (socket.data.sessionId === sessionId) {
      socket.data.sessionId = undefined;
    }
    socket.emit('session.left', { sessionId });
  }

  /**
   * Handle message send
   */
  private async handleMessageSend(socket: Socket, payload: MessagePayload): Promise<void> {
    const data = socket.data as SocketData;

    try {
      const message = {
        id: uuidv4(),
        sessionId: payload.sessionId,
        role: 'user' as const,
        content: payload.content,
        attachments: payload.attachments,
        userId: data.userId,
        timestamp: new Date().toISOString(),
        status: 'sent',
      };

      // Broadcast to session room
      this.broadcastToSession(payload.sessionId, 'message.received', message);

      // Acknowledge to sender
      socket.emit('message.sent', {
        id: message.id,
        sessionId: payload.sessionId,
        status: 'delivered',
        timestamp: message.timestamp,
      });

      logger.debug('Message sent', { messageId: message.id, sessionId: payload.sessionId });
    } catch (error) {
      socket.emit('error', {
        event: 'message.send',
        error: (error as Error).message,
      });
    }
  }

  /**
   * Handle skill execution request
   */
  private async handleSkillExecute(socket: Socket, payload: SkillExecutionPayload): Promise<void> {
    const data = socket.data as SocketData;
    const executionId = `exec_${Date.now()}_${uuidv4().slice(0, 8)}`;

    try {
      // Emit skill started event
      this.broadcastToSession(payload.sessionId, 'skill.started', {
        executionId,
        sessionId: payload.sessionId,
        skillName: payload.skillName,
        input: payload.params,
        userId: data.userId,
        startedAt: new Date().toISOString(),
      });

      // Simulate skill execution with progress updates
      // In production, this would call the actual skill executor
      const totalSteps = 5;
      for (let step = 1; step <= totalSteps; step++) {
        await new Promise(resolve => setTimeout(resolve, 200));

        this.broadcastToSession(payload.sessionId, 'skill.progress', {
          executionId,
          sessionId: payload.sessionId,
          skillName: payload.skillName,
          progress: Math.round((step / totalSteps) * 100),
          step,
          totalSteps,
        });
      }

      // Emit skill completed event
      const completedAt = new Date().toISOString();
      this.broadcastToSession(payload.sessionId, 'skill.completed', {
        executionId,
        sessionId: payload.sessionId,
        skillName: payload.skillName,
        output: {
          success: true,
          message: `Skill ${payload.skillName} executed successfully`,
          data: payload.params,
        },
        executionTimeMs: 1000,
        completedAt,
      });

      // Also send as assistant message
      this.broadcastToSession(payload.sessionId, 'message.received', {
        id: uuidv4(),
        sessionId: payload.sessionId,
        role: 'assistant',
        content: `Executed skill: ${payload.skillName}`,
        skillExecution: {
          executionId,
          skillName: payload.skillName,
          status: 'completed',
          output: { success: true },
          executionTimeMs: 1000,
        },
        timestamp: completedAt,
      });

      logger.info('Skill executed', {
        executionId,
        skillName: payload.skillName,
        sessionId: payload.sessionId,
      });
    } catch (error) {
      this.broadcastToSession(payload.sessionId, 'skill.error', {
        executionId,
        sessionId: payload.sessionId,
        skillName: payload.skillName,
        error: (error as Error).message,
        erroredAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Handle disconnect
   */
  private handleDisconnect(socket: Socket, reason: string): void {
    const data = socket.data as SocketData;
    this.connectionCount--;

    logger.info('Client disconnected', {
      socketId: socket.id,
      userId: data?.userId,
      reason,
      connectionCount: this.connectionCount,
    });
  }

  /**
   * Handle socket error
   */
  private handleError(socket: Socket, error: Error): void {
    logger.error('Socket error', {
      socketId: socket.id,
      error: error,
    });
  }

  /**
   * Broadcast event to organization room
   */
  broadcastToOrg(organizationId: string, event: string, data: unknown): void {
    if (this.io) {
      this.io.to(`org:${organizationId}`).emit(event, data);
    }
  }

  /**
   * Broadcast event to session room
   */
  broadcastToSession(sessionId: string, event: string, data: unknown): void {
    if (this.io) {
      this.io.to(`session:${sessionId}`).emit(event, data);
    }
  }

  /**
   * Broadcast event to specific user
   */
  broadcastToUser(userId: string, event: string, data: unknown): void {
    if (this.io) {
      this.io.to(`user:${userId}`).emit(event, data);
    }
  }

  /**
   * Broadcast event to all connected clients
   */
  broadcastAll(event: string, data: unknown): void {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  /**
   * Get current connection count
   */
  getConnectionCount(): number {
    return this.connectionCount;
  }

  /**
   * Get Socket.IO server instance
   */
  getIO(): SocketIOServer | null {
    return this.io;
  }

  /**
   * Check if gateway is ready
   */
  isReady(): boolean {
    return this.io !== null;
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.io) {
      // Notify all clients
      this.io.emit('server.shutdown', {
        message: 'Server is shutting down',
        timestamp: new Date().toISOString(),
      });

      // Close all connections
      this.io.close();
    }

    // Close Redis connections
    if (this.pubClient) {
      await this.pubClient.quit();
    }
    if (this.subClient) {
      await this.subClient.quit();
    }

    logger.info('WebSocket gateway shut down');
  }
}

export default OpenClawGateway;
