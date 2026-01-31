/**
 * Telegram Channel Adapter
 *
 * This adapter integrates with Telegram Bot API using the Grammy library.
 * It handles bot token authentication, command handling, inline keyboards,
 * and media messaging with full support for Telegram Bot API features.
 *
 * Features:
 * - Bot token authentication
 * - Command handling (/start, /help, custom commands)
 * - Inline keyboard support
 * - Media handling (photos, videos, documents, audio)
 * - Webhook and long-polling support
 * - Message editing and deletion
 * - Callback query handling
 *
 * @author Adverant AI
 * @version 1.0.0
 */

import { Bot, Context, session, InlineKeyboard, webhookCallback, InputFile } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import { EventEmitter } from 'events';

import {
  ChannelAdapter,
  ChannelAdapterOptions,
  ConnectionStatus,
  InternalMessage,
  OutgoingMessage,
  MessageType,
  ChannelType,
  ChannelStats,
  TelegramConfig
} from '../types/channel.types';

/**
 * Telegram adapter using Grammy library
 */
export class TelegramAdapter extends EventEmitter implements ChannelAdapter {
  private bot: Bot | null = null;
  private config!: TelegramConfig;
  private options!: ChannelAdapterOptions;
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private stats: ChannelStats = {
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0,
    uptime: 0
  };

  private runner: any = null;
  private isShuttingDown: boolean = false;
  private startTime: Date = new Date();

  /**
   * Initialize the Telegram adapter
   */
  async initialize(options: ChannelAdapterOptions): Promise<void> {
    this.options = options;
    this.config = options.config.config as TelegramConfig;

    this.options.logger.info('Telegram adapter initialized', {
      botUsername: this.config.botUsername
    });
  }

  /**
   * Connect to Telegram
   */
  async connect(): Promise<void> {
    if (this.status === ConnectionStatus.CONNECTED) {
      this.options.logger.warn('Telegram already connected');
      return;
    }

    try {
      this.status = ConnectionStatus.CONNECTING;
      await this.options.onStatusChange(ConnectionStatus.CONNECTING);

      this.options.logger.info('Connecting to Telegram...');

      // Create bot instance
      this.bot = new Bot(this.config.botToken);

      // Setup middleware
      this.setupMiddleware();

      // Setup handlers
      this.setupHandlers();

      // Start bot
      await this.startBot();

      this.status = ConnectionStatus.CONNECTED;
      await this.options.onStatusChange(ConnectionStatus.CONNECTED);

      this.options.logger.info('Telegram bot connected successfully', {
        username: this.config.botUsername
      });

    } catch (error) {
      this.options.logger.error('Failed to connect to Telegram', { error });
      this.status = ConnectionStatus.ERROR;
      await this.options.onStatusChange(
        ConnectionStatus.ERROR,
        error instanceof Error ? error.message : 'Connection failed'
      );
      throw error;
    }
  }

  /**
   * Setup Grammy middleware
   */
  private setupMiddleware(): void {
    if (!this.bot) return;

    // Session middleware (for conversation state)
    this.bot.use(session({
      initial: () => ({})
    }));

    // Sequentialize updates by chat to avoid race conditions
    this.bot.use(sequentialize((ctx) => {
      const chat = ctx.chat?.id.toString();
      const user = ctx.from?.id.toString();
      return [chat, user].filter((v): v is string => v !== undefined);
    }));

    // Error handling middleware
    this.bot.catch((err) => {
      this.stats.errors++;
      this.options.logger.error('Telegram bot error', {
        error: err.error,
        ctx: err.ctx
      });
    });
  }

  /**
   * Setup message and command handlers
   */
  private setupHandlers(): void {
    if (!this.bot) return;

    // Command: /start
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        'Welcome to OpenClaw Assistant! 👋\n\n' +
        'I\'m your AI assistant powered by Claude. Send me a message to get started.\n\n' +
        'Use /help to see available commands.',
        {
          reply_markup: new InlineKeyboard()
            .text('Get Started', 'get_started')
            .row()
            .url('Learn More', 'https://adverant.ai/openclaw')
        }
      );
    });

    // Command: /help
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        '*OpenClaw Assistant Commands*\n\n' +
        '/start - Start the bot\n' +
        '/help - Show this help message\n' +
        '/cancel - Cancel current operation\n' +
        '/status - Check bot status\n\n' +
        'Simply send me any message and I\'ll assist you!',
        { parse_mode: 'Markdown' }
      );
    });

    // Command: /status
    this.bot.command('status', async (ctx) => {
      const stats = this.getStats();
      await ctx.reply(
        `*Bot Status*\n\n` +
        `Status: ✅ Connected\n` +
        `Messages Received: ${stats.messagesReceived}\n` +
        `Messages Sent: ${stats.messagesSent}\n` +
        `Uptime: ${Math.floor(stats.uptime / 1000 / 60)} minutes`,
        { parse_mode: 'Markdown' }
      );
    });

    // Command: /cancel
    this.bot.command('cancel', async (ctx) => {
      await ctx.reply('Operation cancelled.');
    });

    // Handle all text messages
    this.bot.on('message:text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });

    // Handle photos
    this.bot.on('message:photo', async (ctx) => {
      await this.handleMediaMessage(ctx, MessageType.IMAGE);
    });

    // Handle videos
    this.bot.on('message:video', async (ctx) => {
      await this.handleMediaMessage(ctx, MessageType.VIDEO);
    });

    // Handle audio
    this.bot.on('message:audio', async (ctx) => {
      await this.handleMediaMessage(ctx, MessageType.AUDIO);
    });

    // Handle voice messages
    this.bot.on('message:voice', async (ctx) => {
      await this.handleMediaMessage(ctx, MessageType.AUDIO);
    });

    // Handle documents
    this.bot.on('message:document', async (ctx) => {
      await this.handleMediaMessage(ctx, MessageType.DOCUMENT);
    });

    // Handle stickers
    this.bot.on('message:sticker', async (ctx) => {
      await this.handleMediaMessage(ctx, MessageType.STICKER);
    });

    // Handle location
    this.bot.on('message:location', async (ctx) => {
      await this.handleLocationMessage(ctx);
    });

    // Handle contact
    this.bot.on('message:contact', async (ctx) => {
      await this.handleContactMessage(ctx);
    });

    // Handle callback queries (inline keyboard buttons)
    this.bot.on('callback_query:data', async (ctx) => {
      await this.handleCallbackQuery(ctx);
    });

    // Handle inline queries
    this.bot.on('inline_query', async (ctx) => {
      this.options.logger.debug('Inline query received', {
        query: ctx.inlineQuery.query,
        from: ctx.from.id
      });
      // Inline query handling can be added here
    });
  }

  /**
   * Handle text messages
   */
  private async handleTextMessage(ctx: Context): Promise<void> {
    try {
      if (!ctx.message || !ctx.message.text) return;

      const internalMessage: InternalMessage = {
        messageId: ctx.message.message_id.toString(),
        channelType: ChannelType.TELEGRAM,
        channelMessageId: ctx.message.message_id.toString(),
        senderId: ctx.from?.id.toString() || '',
        senderName: ctx.from?.first_name || '',
        senderUsername: ctx.from?.username,
        type: MessageType.TEXT,
        content: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
        replyTo: ctx.message.reply_to_message?.message_id.toString(),
        metadata: {
          chatId: ctx.chat?.id,
          chatType: ctx.chat?.type,
          entities: ctx.message.entities
        }
      };

      this.stats.messagesReceived++;
      await this.options.onMessage(internalMessage);

    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to handle Telegram text message', { error });
    }
  }

  /**
   * Handle media messages
   */
  private async handleMediaMessage(ctx: Context, mediaType: MessageType): Promise<void> {
    try {
      if (!ctx.message) return;

      let fileId: string | undefined;
      let caption: string | undefined;
      let mimeType: string | undefined;
      let fileName: string | undefined;

      // Extract media info based on type
      if (mediaType === MessageType.IMAGE && ctx.message.photo) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Largest size
        fileId = photo.file_id;
        caption = ctx.message.caption;
      } else if (mediaType === MessageType.VIDEO && ctx.message.video) {
        fileId = ctx.message.video.file_id;
        caption = ctx.message.caption;
        mimeType = ctx.message.video.mime_type;
        fileName = ctx.message.video.file_name;
      } else if (mediaType === MessageType.AUDIO) {
        if (ctx.message.audio) {
          fileId = ctx.message.audio.file_id;
          mimeType = ctx.message.audio.mime_type;
          fileName = ctx.message.audio.file_name;
        } else if (ctx.message.voice) {
          fileId = ctx.message.voice.file_id;
          mimeType = ctx.message.voice.mime_type;
        }
      } else if (mediaType === MessageType.DOCUMENT && ctx.message.document) {
        fileId = ctx.message.document.file_id;
        caption = ctx.message.caption;
        mimeType = ctx.message.document.mime_type;
        fileName = ctx.message.document.file_name;
      } else if (mediaType === MessageType.STICKER && ctx.message.sticker) {
        fileId = ctx.message.sticker.file_id;
      }

      if (!fileId) {
        this.options.logger.warn('No file ID found in media message');
        return;
      }

      // Get file info and download URL
      const file = await ctx.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

      const internalMessage: InternalMessage = {
        messageId: ctx.message.message_id.toString(),
        channelType: ChannelType.TELEGRAM,
        channelMessageId: ctx.message.message_id.toString(),
        senderId: ctx.from?.id.toString() || '',
        senderName: ctx.from?.first_name || '',
        senderUsername: ctx.from?.username,
        type: mediaType,
        content: caption || '',
        media: {
          url: fileUrl,
          mimeType: mimeType || 'application/octet-stream',
          filename: fileName,
          size: file.file_size
        },
        timestamp: new Date(ctx.message.date * 1000),
        metadata: {
          chatId: ctx.chat?.id,
          fileId,
          filePath: file.file_path
        }
      };

      this.stats.messagesReceived++;
      await this.options.onMessage(internalMessage);

    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to handle Telegram media message', { error });
    }
  }

  /**
   * Handle location messages
   */
  private async handleLocationMessage(ctx: Context): Promise<void> {
    try {
      if (!ctx.message || !ctx.message.location) return;

      const location = ctx.message.location;

      const internalMessage: InternalMessage = {
        messageId: ctx.message.message_id.toString(),
        channelType: ChannelType.TELEGRAM,
        channelMessageId: ctx.message.message_id.toString(),
        senderId: ctx.from?.id.toString() || '',
        senderName: ctx.from?.first_name || '',
        senderUsername: ctx.from?.username,
        type: MessageType.LOCATION,
        content: JSON.stringify({
          latitude: location.latitude,
          longitude: location.longitude,
          horizontalAccuracy: location.horizontal_accuracy
        }),
        timestamp: new Date(ctx.message.date * 1000),
        metadata: {
          chatId: ctx.chat?.id
        }
      };

      this.stats.messagesReceived++;
      await this.options.onMessage(internalMessage);

    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to handle Telegram location message', { error });
    }
  }

  /**
   * Handle contact messages
   */
  private async handleContactMessage(ctx: Context): Promise<void> {
    try {
      if (!ctx.message || !ctx.message.contact) return;

      const internalMessage: InternalMessage = {
        messageId: ctx.message.message_id.toString(),
        channelType: ChannelType.TELEGRAM,
        channelMessageId: ctx.message.message_id.toString(),
        senderId: ctx.from?.id.toString() || '',
        senderName: ctx.from?.first_name || '',
        senderUsername: ctx.from?.username,
        type: MessageType.CONTACT,
        content: JSON.stringify(ctx.message.contact),
        timestamp: new Date(ctx.message.date * 1000),
        metadata: {
          chatId: ctx.chat?.id
        }
      };

      this.stats.messagesReceived++;
      await this.options.onMessage(internalMessage);

    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to handle Telegram contact message', { error });
    }
  }

  /**
   * Handle callback queries from inline keyboards
   */
  private async handleCallbackQuery(ctx: Context): Promise<void> {
    try {
      if (!ctx.callbackQuery || !ctx.callbackQuery.data) return;

      this.options.logger.info('Callback query received', {
        data: ctx.callbackQuery.data,
        from: ctx.from?.id
      });

      // Answer the callback query to remove loading state
      await ctx.answerCallbackQuery();

      // Emit event for skill executor to handle
      this.emit('callback', {
        callbackId: ctx.callbackQuery.id,
        data: ctx.callbackQuery.data,
        userId: ctx.from?.id,
        messageId: ctx.callbackQuery.message?.message_id
      });

    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to handle callback query', { error });
    }
  }

  /**
   * Start the bot (long polling or webhook)
   */
  private async startBot(): Promise<void> {
    if (!this.bot) {
      throw new Error('Bot not initialized');
    }

    if (this.config.webhookUrl) {
      // Use webhook mode
      await this.startWebhook();
    } else {
      // Use long polling mode
      await this.startPolling();
    }
  }

  /**
   * Start bot in long polling mode
   */
  private async startPolling(): Promise<void> {
    if (!this.bot) return;

    this.options.logger.info('Starting Telegram bot in polling mode');

    // Delete webhook if set
    await this.bot.api.deleteWebhook();

    // Start runner for concurrent update processing
    this.runner = run(this.bot, {
      runner: {
        fetch: {
          allowed_updates: (this.config.allowedUpdates || []) as any
        }
      }
    });

    this.options.logger.info('Telegram bot polling started');
  }

  /**
   * Start bot in webhook mode
   */
  private async startWebhook(): Promise<void> {
    if (!this.bot || !this.config.webhookUrl) return;

    this.options.logger.info('Setting up Telegram webhook', {
      url: this.config.webhookUrl
    });

    await this.bot.api.setWebhook(this.config.webhookUrl, {
      secret_token: this.config.webhookSecret,
      allowed_updates: (this.config.allowedUpdates || []) as any
    });

    this.options.logger.info('Telegram webhook configured');
  }

  /**
   * Handle webhook request
   */
  async handleWebhook(body: any, headers: Record<string, string>): Promise<void> {
    if (!this.bot) {
      throw new Error('Bot not initialized');
    }

    // Verify secret token if configured
    if (this.config.webhookSecret) {
      const token = headers['x-telegram-bot-api-secret-token'];
      if (token !== this.config.webhookSecret) {
        throw new Error('Invalid webhook secret token');
      }
    }

    // Process update
    await this.bot.handleUpdate(body);
  }

  /**
   * Send a message through Telegram
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.bot) {
      throw new Error('Telegram bot not connected');
    }

    if (this.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`Telegram not ready: ${this.status}`);
    }

    try {
      const chatId = parseInt(message.recipientId);
      let sentMessage;

      // Build inline keyboard if buttons present
      const replyMarkup = message.keyboard || message.buttons
        ? this.buildInlineKeyboard(message.buttons || [])
        : undefined;

      // Send based on message type
      switch (message.type) {
        case MessageType.TEXT:
          sentMessage = await this.bot.api.sendMessage(chatId, message.content, {
            reply_markup: replyMarkup,
            parse_mode: 'Markdown'
          });
          break;

        case MessageType.IMAGE:
          if (message.media) {
            const photoInput = message.media.url || new InputFile(message.media.buffer!, message.media.filename);
            sentMessage = await this.bot.api.sendPhoto(chatId, photoInput, {
              caption: message.content,
              reply_markup: replyMarkup
            });
          }
          break;

        case MessageType.VIDEO:
          if (message.media) {
            const videoInput = message.media.url || new InputFile(message.media.buffer!, message.media.filename);
            sentMessage = await this.bot.api.sendVideo(chatId, videoInput, {
              caption: message.content,
              reply_markup: replyMarkup
            });
          }
          break;

        case MessageType.AUDIO:
          if (message.media) {
            const audioInput = message.media.url || new InputFile(message.media.buffer!, message.media.filename);
            sentMessage = await this.bot.api.sendAudio(chatId, audioInput, {
              caption: message.content,
              reply_markup: replyMarkup
            });
          }
          break;

        case MessageType.DOCUMENT:
          if (message.media) {
            const docInput = message.media.url || new InputFile(message.media.buffer!, message.media.filename);
            sentMessage = await this.bot.api.sendDocument(chatId, docInput, {
              caption: message.content,
              reply_markup: replyMarkup
            });
          }
          break;

        default:
          throw new Error(`Unsupported message type: ${message.type}`);
      }

      if (!sentMessage) {
        throw new Error('Failed to send message');
      }

      this.stats.messagesSent++;
      this.options.logger.info('Telegram message sent', {
        messageId: sentMessage.message_id,
        chatId,
        type: message.type
      });

      return sentMessage.message_id.toString();

    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to send Telegram message', { error });
      throw error;
    }
  }

  /**
   * Build inline keyboard from buttons
   */
  private buildInlineKeyboard(buttons: any[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];

      if (btn.url) {
        keyboard.url(btn.label, btn.url);
      } else {
        keyboard.text(btn.label, btn.callback || btn.id);
      }

      // Add row break if not last button
      if (i < buttons.length - 1) {
        keyboard.row();
      }
    }

    return keyboard;
  }

  /**
   * Disconnect from Telegram
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;

    this.options.logger.info('Disconnecting from Telegram...');

    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
    }

    if (this.bot && this.config.webhookUrl) {
      await this.bot.api.deleteWebhook();
    }

    this.bot = null;
    this.status = ConnectionStatus.DISCONNECTED;
    await this.options.onStatusChange(ConnectionStatus.DISCONNECTED);

    this.options.logger.info('Telegram bot disconnected');
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Get channel statistics
   */
  getStats(): ChannelStats {
    return {
      ...this.stats,
      uptime: Date.now() - this.startTime.getTime()
    };
  }
}
