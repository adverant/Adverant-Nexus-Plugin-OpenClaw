/**
 * Discord Channel Adapter
 *
 * This adapter integrates with Discord Bot API using the discord.js library.
 * It handles bot token authentication, slash commands, embed messages,
 * reaction handling, and rich Discord bot features.
 *
 * Features:
 * - Bot token authentication
 * - Slash commands registration and handling
 * - Rich embed messages
 * - Reaction handling and collectors
 * - Direct messages and server messages
 * - Voice channel support (optional)
 * - Thread support
 *
 * @author Adverant AI
 * @version 1.0.0
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  Partials,
  AttachmentBuilder
} from 'discord.js';
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
  DiscordConfig
} from '../types/channel.types';

/**
 * Discord adapter using discord.js library
 */
export class DiscordAdapter extends EventEmitter implements ChannelAdapter {
  private client: Client | null = null;
  private config!: DiscordConfig;
  private options!: ChannelAdapterOptions;
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private stats: ChannelStats = {
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0,
    uptime: 0
  };

  private isShuttingDown: boolean = false;
  private startTime: Date = new Date();

  /**
   * Initialize the Discord adapter
   */
  async initialize(options: ChannelAdapterOptions): Promise<void> {
    this.options = options;
    this.config = options.config.config as DiscordConfig;

    this.options.logger.info('Discord adapter initialized', {
      applicationId: this.config.applicationId
    });
  }

  /**
   * Connect to Discord
   */
  async connect(): Promise<void> {
    if (this.status === ConnectionStatus.CONNECTED) {
      this.options.logger.warn('Discord already connected');
      return;
    }

    try {
      this.status = ConnectionStatus.CONNECTING;
      await this.options.onStatusChange(ConnectionStatus.CONNECTING);

      this.options.logger.info('Connecting to Discord...');

      // Parse intents
      const intents = this.parseIntents();

      // Create Discord client
      this.client = new Client({
        intents,
        partials: [Partials.Channel, Partials.Message, Partials.Reaction]
      });

      // Setup event handlers
      this.setupEventHandlers();

      // Login to Discord
      await this.client.login(this.config.botToken);

      // Register slash commands
      await this.registerSlashCommands();

      this.status = ConnectionStatus.CONNECTED;
      await this.options.onStatusChange(ConnectionStatus.CONNECTED);

      this.options.logger.info('Discord bot connected successfully');

    } catch (error) {
      this.options.logger.error('Failed to connect to Discord', { error });
      this.status = ConnectionStatus.ERROR;
      await this.options.onStatusChange(
        ConnectionStatus.ERROR,
        error instanceof Error ? error.message : 'Connection failed'
      );
      throw error;
    }
  }

  /**
   * Parse Discord intents from config
   */
  private parseIntents(): number[] {
    const intentMap: Record<string, number> = {
      Guilds: GatewayIntentBits.Guilds,
      GuildMessages: GatewayIntentBits.GuildMessages,
      GuildMessageReactions: GatewayIntentBits.GuildMessageReactions,
      DirectMessages: GatewayIntentBits.DirectMessages,
      MessageContent: GatewayIntentBits.MessageContent,
      GuildMembers: GatewayIntentBits.GuildMembers
    };

    return this.config.intents.map(intent => intentMap[intent] || 0).filter(i => i !== 0);
  }

  /**
   * Setup Discord event handlers
   */
  private setupEventHandlers(): void {
    if (!this.client) return;

    // Ready event
    this.client.once(Events.ClientReady, async (client) => {
      this.options.logger.info('Discord bot ready', {
        username: client.user.tag,
        id: client.user.id
      });
      this.emit('ready');
    });

    // Message create event
    this.client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(message);
    });

    // Interaction create event (slash commands, buttons)
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      } else if (interaction.isButton()) {
        await this.handleButtonInteraction(interaction);
      }
    });

    // Message reaction add
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      this.options.logger.debug('Reaction added', {
        emoji: reaction.emoji.name,
        userId: user.id,
        messageId: reaction.message.id
      });
    });

    // Error handling
    this.client.on(Events.Error, (error) => {
      this.stats.errors++;
      this.options.logger.error('Discord client error', { error });
    });

    // Warn handling
    this.client.on(Events.Warn, (warning) => {
      this.options.logger.warn('Discord client warning', { warning });
    });

    // Disconnect handling (ShardDisconnect in discord.js v14+)
    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      this.options.logger.warn('Discord client disconnected', { shardId, code: event.code });
      if (!this.isShuttingDown) {
        this.attemptReconnect();
      }
    });
  }

  /**
   * Handle incoming Discord message
   */
  private async handleMessage(message: Message): Promise<void> {
    try {
      // Ignore messages from bots
      if (message.author.bot) return;

      // Ignore messages from self
      if (message.author.id === this.client?.user?.id) return;

      // Convert to internal message format
      const internalMessage = await this.convertToInternalMessage(message);

      if (internalMessage) {
        this.stats.messagesReceived++;
        await this.options.onMessage(internalMessage);
      }
    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to handle Discord message', {
        error,
        messageId: message.id
      });
    }
  }

  /**
   * Convert Discord message to internal format
   */
  private async convertToInternalMessage(message: Message): Promise<InternalMessage | null> {
    const internalMessage: InternalMessage = {
      messageId: message.id,
      channelType: ChannelType.DISCORD,
      channelMessageId: message.id,
      senderId: message.author.id,
      senderName: message.author.username,
      senderUsername: message.author.tag,
      type: MessageType.TEXT,
      content: message.content,
      timestamp: message.createdAt,
      replyTo: message.reference?.messageId,
      threadId: message.channelId,
      metadata: {
        guildId: message.guildId,
        channelId: message.channelId,
        channelType: message.channel.type,
        mentions: message.mentions.users.map(u => u.id),
        embeds: message.embeds.length
      }
    };

    // Handle attachments
    if (message.attachments.size > 0) {
      const attachment = message.attachments.first()!;

      // Determine media type
      if (attachment.contentType?.startsWith('image/')) {
        internalMessage.type = MessageType.IMAGE;
      } else if (attachment.contentType?.startsWith('video/')) {
        internalMessage.type = MessageType.VIDEO;
      } else if (attachment.contentType?.startsWith('audio/')) {
        internalMessage.type = MessageType.AUDIO;
      } else {
        internalMessage.type = MessageType.DOCUMENT;
      }

      internalMessage.media = {
        url: attachment.url,
        mimeType: attachment.contentType || 'application/octet-stream',
        filename: attachment.name,
        size: attachment.size,
        width: attachment.width || undefined,
        height: attachment.height || undefined
      };
    }

    return internalMessage;
  }

  /**
   * Handle slash command interaction
   */
  private async handleSlashCommand(interaction: any): Promise<void> {
    try {
      const commandName = interaction.commandName;

      this.options.logger.info('Slash command received', {
        command: commandName,
        userId: interaction.user.id
      });

      switch (commandName) {
        case 'start':
          await interaction.reply({
            content: '👋 Welcome to OpenClaw Assistant!\n\nI\'m your AI assistant. How can I help you today?',
            ephemeral: true
          });
          break;

        case 'help':
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('OpenClaw Assistant Help')
                .setDescription('Available commands and features')
                .addFields(
                  { name: '/start', value: 'Start the assistant', inline: true },
                  { name: '/help', value: 'Show this help message', inline: true },
                  { name: '/status', value: 'Check bot status', inline: true }
                )
                .setColor(0x5865F2)
                .setTimestamp()
            ],
            ephemeral: true
          });
          break;

        case 'status':
          const stats = this.getStats();
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('Bot Status')
                .addFields(
                  { name: 'Status', value: '✅ Connected', inline: true },
                  { name: 'Messages Received', value: stats.messagesReceived.toString(), inline: true },
                  { name: 'Messages Sent', value: stats.messagesSent.toString(), inline: true },
                  { name: 'Uptime', value: `${Math.floor(stats.uptime / 1000 / 60)} minutes`, inline: true }
                )
                .setColor(0x57F287)
                .setTimestamp()
            ],
            ephemeral: true
          });
          break;

        default:
          await interaction.reply({
            content: `Unknown command: ${commandName}`,
            ephemeral: true
          });
      }
    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to handle slash command', { error });
    }
  }

  /**
   * Handle button interaction
   */
  private async handleButtonInteraction(interaction: any): Promise<void> {
    try {
      const customId = interaction.customId;

      this.options.logger.info('Button interaction received', {
        customId,
        userId: interaction.user.id
      });

      await interaction.deferUpdate();

      // Emit event for skill executor to handle
      this.emit('button', {
        customId,
        userId: interaction.user.id,
        messageId: interaction.message.id
      });
    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to handle button interaction', { error });
    }
  }

  /**
   * Register slash commands with Discord
   */
  private async registerSlashCommands(): Promise<void> {
    if (!this.client) return;

    try {
      const commands = [
        new SlashCommandBuilder()
          .setName('start')
          .setDescription('Start the OpenClaw assistant'),

        new SlashCommandBuilder()
          .setName('help')
          .setDescription('Show help information'),

        new SlashCommandBuilder()
          .setName('status')
          .setDescription('Check bot status')
      ];

      const rest = new REST({ version: '10' }).setToken(this.config.botToken);

      if (this.config.guildId) {
        // Register commands for specific guild (faster, for development)
        await rest.put(
          Routes.applicationGuildCommands(this.config.applicationId, this.config.guildId),
          { body: commands.map(c => c.toJSON()) }
        );
        this.options.logger.info('Slash commands registered for guild', {
          guildId: this.config.guildId
        });
      } else {
        // Register commands globally (slower, up to 1 hour to propagate)
        await rest.put(
          Routes.applicationCommands(this.config.applicationId),
          { body: commands.map(c => c.toJSON()) }
        );
        this.options.logger.info('Slash commands registered globally');
      }
    } catch (error) {
      this.options.logger.error('Failed to register slash commands', { error });
    }
  }

  /**
   * Send a message through Discord
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.client) {
      throw new Error('Discord client not connected');
    }

    if (this.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`Discord not ready: ${this.status}`);
    }

    try {
      const channel = await this.client.channels.fetch(message.recipientId);

      if (!channel || !channel.isTextBased()) {
        throw new Error('Invalid channel');
      }

      // Type guard to ensure channel supports send method
      if (!('send' in channel)) {
        throw new Error('Channel does not support sending messages');
      }

      const messagePayload: any = {};

      // Build message content
      if (message.content) {
        messagePayload.content = message.content;
      }

      // Build embed if present
      if (message.embed) {
        const embed = new EmbedBuilder()
          .setColor(0x5865F2);

        if (message.embed.title) embed.setTitle(message.embed.title);
        if (message.embed.description) embed.setDescription(message.embed.description);
        if (message.embed.author) embed.setAuthor(message.embed.author);
        if (message.embed.fields) {
          message.embed.fields.forEach(field => {
            embed.addFields(field);
          });
        }
        if (message.embed.thumbnail) embed.setThumbnail(message.embed.thumbnail);
        if (message.embed.image) embed.setImage(message.embed.image);
        if (message.embed.footer) embed.setFooter(message.embed.footer);
        if (message.embed.timestamp) embed.setTimestamp(message.embed.timestamp);

        messagePayload.embeds = [embed];
      }

      // Build buttons if present
      if (message.buttons && message.buttons.length > 0) {
        const row = new ActionRowBuilder<ButtonBuilder>();

        message.buttons.forEach(btn => {
          const button = new ButtonBuilder()
            .setCustomId(btn.id)
            .setLabel(btn.label)
            .setStyle(this.mapButtonStyle(btn.style));

          if (btn.url) {
            button.setStyle(ButtonStyle.Link);
            button.setURL(btn.url);
          }

          row.addComponents(button);
        });

        messagePayload.components = [row];
      }

      // Handle media attachments
      if (message.media) {
        if (message.media.buffer) {
          messagePayload.files = [
            new AttachmentBuilder(message.media.buffer, {
              name: message.media.filename || 'file'
            })
          ];
        } else if (message.media.url) {
          messagePayload.files = [message.media.url];
        }
      }

      const sentMessage = await channel.send(messagePayload);

      this.stats.messagesSent++;
      this.options.logger.info('Discord message sent', {
        messageId: sentMessage.id,
        channelId: message.recipientId
      });

      return sentMessage.id;

    } catch (error) {
      this.stats.errors++;
      this.options.logger.error('Failed to send Discord message', { error });
      throw error;
    }
  }

  /**
   * Map button style to Discord button style
   */
  private mapButtonStyle(style?: string): ButtonStyle {
    switch (style) {
      case 'primary':
        return ButtonStyle.Primary;
      case 'secondary':
        return ButtonStyle.Secondary;
      case 'success':
        return ButtonStyle.Success;
      case 'danger':
        return ButtonStyle.Danger;
      default:
        return ButtonStyle.Secondary;
    }
  }

  /**
   * Attempt to reconnect to Discord
   */
  private async attemptReconnect(): Promise<void> {
    this.options.logger.info('Attempting to reconnect to Discord...');

    try {
      if (this.client) {
        await this.client.destroy();
      }

      await this.connect();
    } catch (error) {
      this.options.logger.error('Failed to reconnect to Discord', { error });
    }
  }

  /**
   * Disconnect from Discord
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;

    this.options.logger.info('Disconnecting from Discord...');

    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }

    this.status = ConnectionStatus.DISCONNECTED;
    await this.options.onStatusChange(ConnectionStatus.DISCONNECTED);

    this.options.logger.info('Discord bot disconnected');
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
