/**
 * Channel Repository
 *
 * This repository handles all database operations for message channels.
 * It provides CRUD operations with multi-tenant isolation and encryption
 * for sensitive channel credentials.
 *
 * @author Adverant AI
 * @version 1.0.0
 */

import { Pool, PoolClient } from 'pg';
import { ChannelConfig, ChannelType, ConnectionStatus } from '../../types/channel.types';
import crypto, { CipherGCM, DecipherGCM } from 'crypto';

/**
 * Encryption helper for channel credentials
 */
class ChannelEncryption {
  private algorithm = 'aes-256-gcm';
  private key: Buffer;

  constructor() {
    // In production, this should be loaded from environment variable or secrets manager
    const encryptionKey = process.env.CHANNEL_ENCRYPTION_KEY || 'default-dev-key-32-chars-long!';
    this.key = crypto.scryptSync(encryptionKey, 'salt', 32);
  }

  /**
   * Encrypt sensitive channel configuration
   */
  encrypt(data: Record<string, any>): string {
    const iv = crypto.randomBytes(16);
    // Cast to CipherGCM since we're using aes-256-gcm algorithm
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv) as CipherGCM;

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    return JSON.stringify({
      iv: iv.toString('hex'),
      data: encrypted.toString('hex'),
      authTag: authTag.toString('hex')
    });
  }

  /**
   * Decrypt channel configuration
   */
  decrypt(encrypted: string): Record<string, any> {
    const { iv, data, authTag } = JSON.parse(encrypted);

    // Cast to DecipherGCM since we're using aes-256-gcm algorithm
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.key,
      Buffer.from(iv, 'hex')
    ) as DecipherGCM;

    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, 'hex')),
      decipher.final()
    ]);

    return JSON.parse(decrypted.toString('utf8'));
  }
}

/**
 * Channel repository for database operations
 */
export class ChannelRepository {
  private pool: Pool;
  private encryption: ChannelEncryption;

  constructor(pool: Pool) {
    this.pool = pool;
    this.encryption = new ChannelEncryption();
  }

  /**
   * Create a new message channel
   */
  async create(
    userId: string,
    organizationId: string,
    channelType: ChannelType,
    channelIdentifier: string,
    channelName: string | undefined,
    config: Record<string, any>,
    webhookUrl?: string,
    webhookSecret?: string
  ): Promise<ChannelConfig> {
    const encryptedConfig = this.encryption.encrypt(config);

    const query = `
      INSERT INTO openclaw.message_channels (
        user_id,
        organization_id,
        channel_type,
        channel_identifier,
        channel_name,
        channel_config,
        webhook_url,
        webhook_secret,
        active,
        verified,
        connection_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;

    const values = [
      userId,
      organizationId,
      channelType,
      channelIdentifier,
      channelName,
      encryptedConfig,
      webhookUrl,
      webhookSecret,
      true,  // active
      false,  // verified
      ConnectionStatus.DISCONNECTED
    ];

    const result = await this.pool.query(query, values);
    return this.mapRowToConfig(result.rows[0]);
  }

  /**
   * Find channel by ID
   */
  async findById(channelId: string, organizationId: string): Promise<ChannelConfig | null> {
    const query = `
      SELECT * FROM openclaw.message_channels
      WHERE channel_id = $1 AND organization_id = $2 AND active = TRUE
    `;

    const result = await this.pool.query(query, [channelId, organizationId]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToConfig(result.rows[0]);
  }

  /**
   * Find channel by type and identifier
   */
  async findByTypeAndIdentifier(
    organizationId: string,
    channelType: ChannelType,
    channelIdentifier: string
  ): Promise<ChannelConfig | null> {
    const query = `
      SELECT * FROM openclaw.message_channels
      WHERE organization_id = $1
        AND channel_type = $2
        AND channel_identifier = $3
        AND active = TRUE
    `;

    const result = await this.pool.query(query, [organizationId, channelType, channelIdentifier]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToConfig(result.rows[0]);
  }

  /**
   * List all channels for an organization
   */
  async listByOrganization(
    organizationId: string,
    channelType?: ChannelType
  ): Promise<ChannelConfig[]> {
    let query = `
      SELECT * FROM openclaw.message_channels
      WHERE organization_id = $1 AND active = TRUE
    `;
    const values: any[] = [organizationId];

    if (channelType) {
      query += ` AND channel_type = $2`;
      values.push(channelType);
    }

    query += ` ORDER BY created_at DESC`;

    const result = await this.pool.query(query, values);
    return result.rows.map(row => this.mapRowToConfig(row));
  }

  /**
   * Update channel configuration
   */
  async updateConfig(
    channelId: string,
    organizationId: string,
    config: Record<string, any>
  ): Promise<ChannelConfig> {
    const encryptedConfig = this.encryption.encrypt(config);

    const query = `
      UPDATE openclaw.message_channels
      SET channel_config = $1, updated_at = NOW()
      WHERE channel_id = $2 AND organization_id = $3
      RETURNING *
    `;

    const result = await this.pool.query(query, [encryptedConfig, channelId, organizationId]);

    if (result.rows.length === 0) {
      throw new Error(`Channel ${channelId} not found`);
    }

    return this.mapRowToConfig(result.rows[0]);
  }

  /**
   * Update channel status
   */
  async updateStatus(
    channelId: string,
    organizationId: string,
    status: ConnectionStatus,
    lastError?: string
  ): Promise<void> {
    const query = `
      UPDATE openclaw.message_channels
      SET connection_status = $1,
          last_error = $2,
          updated_at = NOW()
      WHERE channel_id = $3 AND organization_id = $4
    `;

    await this.pool.query(query, [status, lastError || null, channelId, organizationId]);
  }

  /**
   * Increment message count
   */
  async incrementMessageCount(
    channelId: string,
    organizationId: string
  ): Promise<void> {
    const query = `
      UPDATE openclaw.message_channels
      SET message_count = message_count + 1,
          last_message_at = NOW(),
          last_used = NOW()
      WHERE channel_id = $1 AND organization_id = $2
    `;

    await this.pool.query(query, [channelId, organizationId]);
  }

  /**
   * Mark channel as verified
   */
  async markVerified(
    channelId: string,
    organizationId: string
  ): Promise<void> {
    const query = `
      UPDATE openclaw.message_channels
      SET verified = TRUE,
          verified_at = NOW(),
          connection_status = $1,
          updated_at = NOW()
      WHERE channel_id = $2 AND organization_id = $3
    `;

    await this.pool.query(query, [ConnectionStatus.CONNECTED, channelId, organizationId]);
  }

  /**
   * Deactivate channel (soft delete)
   */
  async deactivate(
    channelId: string,
    organizationId: string
  ): Promise<void> {
    const query = `
      UPDATE openclaw.message_channels
      SET active = FALSE,
          connection_status = $1,
          updated_at = NOW()
      WHERE channel_id = $2 AND organization_id = $3
    `;

    await this.pool.query(query, [ConnectionStatus.DISCONNECTED, channelId, organizationId]);
  }

  /**
   * Delete channel permanently
   */
  async delete(
    channelId: string,
    organizationId: string
  ): Promise<void> {
    const query = `
      DELETE FROM openclaw.message_channels
      WHERE channel_id = $1 AND organization_id = $2
    `;

    await this.pool.query(query, [channelId, organizationId]);
  }

  /**
   * Map database row to ChannelConfig object
   */
  private mapRowToConfig(row: any): ChannelConfig {
    return {
      channelId: row.channel_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      channelType: row.channel_type as ChannelType,
      channelIdentifier: row.channel_identifier,
      channelName: row.channel_name,
      config: this.encryption.decrypt(row.channel_config),
      webhookUrl: row.webhook_url,
      webhookSecret: row.webhook_secret,
      active: row.active,
      verified: row.verified,
      connectionStatus: row.connection_status as ConnectionStatus,
      lastError: row.last_error,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsed: row.last_used,
      verifiedAt: row.verified_at
    };
  }
}
