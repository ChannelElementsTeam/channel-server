import { Cursor, MongoClient, Db, Collection } from "mongodb";

import { ChannelRecord, ChannelMemberRecord, ChannelInvitation, MessageRecord, RegistrationRecord, SmsBlockRecord } from "./interfaces/db-records";
import { configuration } from "./configuration";
import { ChannelContractDetails, FullIdentity, MemberContractDetails, SignedKeyIdentity, NotificationSettings, KeyIdentity } from "channels-common";

export class Database {
  private db: Db;
  private channels: Collection;
  private channelMembers: Collection;
  private invitations: Collection;
  private messages: Collection;
  private registrations: Collection;
  private smsBlocks: Collection;

  async initialize(): Promise<void> {
    const serverOptions = configuration.get('mongo.serverOptions');
    const options: any = { db: { w: 1 } };
    if (serverOptions) {
      options.server = serverOptions;
    }
    this.db = await MongoClient.connect(configuration.get('mongo.mongoUrl', options));
    await this.initializeChannels();
    await this.initializeChannelMembers();
    await this.initializeInvitations();
    await this.initializeMessages();
    await this.initializeRegistrations();
    await this.initializeSmsBlocks();
  }

  private async initializeChannels(): Promise<void> {
    this.channels = this.db.collection('channels');
    await this.channels.createIndex({ channelAddress: 1 }, { unique: true });
    await this.channels.createIndex({ lastUpdated: -1 });
  }

  private async initializeChannelMembers(): Promise<void> {
    this.channelMembers = this.db.collection('channelMembers');
    await this.channelMembers.createIndex({ channelAddress: 1, "identity.address": 1 }, { unique: true });
    await this.channelMembers.createIndex({ channelAddress: 1, status: 1, lastActive: -1 });
    await this.channelMembers.createIndex({ "identity.address": 1, status: 1, lastActive: -1 });
    await this.channelMembers.createIndex({ channelAddress: 1, status: 1, lastNotificationConsidered: 1 });
  }

  private async initializeInvitations(): Promise<void> {
    this.invitations = this.db.collection('invitations');
    await this.invitations.createIndex({ id: 1 }, { unique: true });
  }

  private async initializeMessages(): Promise<void> {
    this.messages = this.db.collection('messages');
    await this.messages.createIndex({ channelAddress: 1, senderAddress: 1, timestamp: -1 }, { unique: true });
    await this.messages.createIndex({ channelAddress: 1, timestamp: -1 });
  }

  private async initializeRegistrations(): Promise<void> {
    this.registrations = this.db.collection('registrations');
    await this.registrations.createIndex({ address: 1 }, { unique: true });
    await this.registrations.createIndex({ address: 1, status: 1, lastActive: -1 });
  }

  private async initializeSmsBlocks(): Promise<void> {
    this.smsBlocks = this.db.collection('smsBlocks');
    await this.smsBlocks.createIndex({ smsNumber: 1 }, { unique: true });
  }

  async insertChannel(channelAddress: string, name: string, creatorAddress: string, transportUrl: string, contract: ChannelContractDetails, status: string): Promise<ChannelRecord> {
    const now = Date.now();
    const record: ChannelRecord = {
      channelAddress: channelAddress,
      creatorAddress: creatorAddress,
      transportUrl: transportUrl,
      created: now,
      lastUpdated: now,
      deleted: 0,
      contract: contract,
      status: status
    };
    if (name) {
      record.name = name;
    }
    await this.channels.insert(record);
    return record;
  }

  async findChannelByAddress(channelAddress: string): Promise<ChannelRecord> {
    return await this.channels.findOne<ChannelRecord>({ channelAddress: channelAddress });
  }

  async findUpdatedChannels(lastUpdatedSince: number): Promise<ChannelRecord[]> {
    return await this.channels.find<ChannelRecord>({ lastUpdated: { $gt: lastUpdatedSince } }).toArray();
  }

  async updateChannelStatus(channelAddress: string, status: string): Promise<void> {
    await this.channels.update({ channelAddress: channelAddress }, { $set: { status: status, lastUpdated: Date.now() } });
  }

  async insertChannelMember(channelAddress: string, signedIdentity: SignedKeyIdentity, identity: FullIdentity, memberServicesContract: MemberContractDetails, status: string): Promise<ChannelMemberRecord> {
    const now = Date.now();
    const record: ChannelMemberRecord = {
      channelAddress: channelAddress,
      signedIdentity: signedIdentity,
      identity: identity,
      memberServices: memberServicesContract,
      added: now,
      status: status,
      lastActive: now,
      lastNotificationConsidered: 0,
      lastNotificationSent: 0
    };
    await this.channelMembers.insert(record);
    return record;
  }

  async findChannelMember(channelAddress: string, memberAddress: string): Promise<ChannelMemberRecord> {
    return await this.channelMembers.findOne<ChannelMemberRecord>({ channelAddress: channelAddress, "identity.address": memberAddress });
  }

  async updateChannelMemberActive(channelAddress: string, memberAddress: string, status: string, lastActive: number, identity?: any): Promise<void> {
    const update: any = {};
    if (status) {
      update.status = status;
    }
    if (lastActive) {
      update.lastActive = lastActive;
    }
    if (identity) {
      update.identity = identity;
    }
    await this.channelMembers.update({ channelAddress: channelAddress, "identity.address": memberAddress }, { $set: update });
  }

  async countChannelMembers(channelAddress: string, status: string): Promise<number> {
    return await this.channelMembers.count({ channelAddress: channelAddress, status: status });
  }

  async findChannelMembers(channelAddress: string, status: string, limit = 50): Promise<ChannelMemberRecord[]> {
    return await this.channelMembers.find<ChannelMemberRecord>({ channelAddress: channelAddress, status: status }).sort({ lastActive: -1 }).limit(limit).toArray();
  }

  async countChannelMembersByAddress(address: string, status: string, lastActiveBefore = 0): Promise<number> {
    const query: any = {
      "identity.address": address,
      status: status,
    };
    if (lastActiveBefore) {
      query.lastActive = { $lte: lastActiveBefore };
    }
    return await this.channelMembers.count(query);
  }

  async findChannelMemberByChannelAndAddress(channelAddress: string, memberAddress: string, status: string): Promise<ChannelMemberRecord> {
    const query: any = {
      channelAddress: channelAddress,
      "identity.address": memberAddress,
      status: status,
    };
    return await this.channelMembers.findOne<ChannelMemberRecord>(query);
  }

  async findChannelMembersByAddress(address: string, status: string, lastActiveBefore = 0, limit = 50): Promise<ChannelMemberRecord[]> {
    const query: any = {
      "identity.address": address,
      status: status,
    };
    if (lastActiveBefore) {
      query.lastActive = { $lte: lastActiveBefore };
    }
    return await this.channelMembers.find<ChannelMemberRecord>(query).sort({ lastActive: -1 }).limit(limit).toArray();
  }
  async getLatestChannelMemberRecord(address: string, status: string): Promise<ChannelMemberRecord> {
    const query: any = {
      "identity.address": address,
      status: status,
    };
    const items = await this.channelMembers.find<ChannelMemberRecord>(query).sort({ lastActive: -1 }).limit(1).toArray();
    if (items.length > 0) {
      return items[0];
    } else {
      return null;
    }
  }

  async findChannelMembersBeforeLastConsideredAndUpdate(channelAddress: string, status: string, lastNotificationConsideredBefore: number): Promise<ChannelMemberRecord[]> {
    const result = await this.channelMembers.find<ChannelMemberRecord>({
      channelAddress: channelAddress,
      status: status,
      lastNotificationConsidered: { $lte: lastNotificationConsideredBefore }
    }).toArray();
    if (result.length > 0) {
      await this.channelMembers.update({
        channelAddress: channelAddress,
        status: status,
        lastNotificationConsidered: { $lte: lastNotificationConsideredBefore }
      }, { $set: { lastNotificationConsideredBefore: Date.now() } });
    }
    return result;
  }

  async updateChannelMemberLastNotification(channelAddress: string, memberAddress: string): Promise<void> {
    await this.channelMembers.update({
      channelAddress: channelAddress,
      "identity.address": memberAddress
    }, { $set: { lastNotificationSent: Date.now() } });
  }

  async insertInvitation(id: string, sharedByAddress: string, channelAddress: string, extensions: any): Promise<ChannelInvitation> {
    const now = Date.now();
    const record: ChannelInvitation = {
      id: id,
      sharedByAddress: sharedByAddress,
      channelAddress: channelAddress,
      extensions: extensions,
      created: now
    };
    await this.invitations.insert(record);
    return record;
  }

  async findInvitationById(id: string): Promise<ChannelInvitation> {
    return await this.invitations.findOne<ChannelInvitation>({ id: id });
  }

  async insertMessage(channelAddress: string, senderAddress: string, timestamp: number, size: number, contents: Uint8Array): Promise<MessageRecord> {
    const record: MessageRecord = {
      channelAddress: channelAddress,
      senderAddress: senderAddress,
      timestamp: timestamp,
      size: contents.length,
      contents: contents.join(',')
    };
    await this.messages.update({ channelAddress: channelAddress, senderAddress: senderAddress, timestamp: timestamp }, record, { upsert: true });
    return record;
  }

  findMessages(channelAddress: string, before: number, after: number): Cursor<MessageRecord> {
    const query: any = {
      channelAddress: channelAddress
    };
    if (before || after) {
      const range: any = {};
      if (before) {
        range['$lte'] = before;
      }
      if (after) {
        range['$gt'] = after;
      }
      query.timestamp = range;
    }
    return this.messages.find<MessageRecord>(query).sort({ timestamp: -1 });
  }

  async countMessages(channelAddress: string, before: number, after: number): Promise<number> {
    const query: any = {
      channelAddress: channelAddress
    };
    if (before || after) {
      const range: any = {};
      if (before) {
        range['$lte'] = before;
      }
      if (after) {
        range['$gt'] = after;
      }
      query.timestamp = range;
    }
    return await this.messages.count(query);
  }

  async insertRegistration(address: string, signedIdentity: SignedKeyIdentity, identity: KeyIdentity, lastActive: number, created: number, status: string, timezone?: string, notifications?: NotificationSettings): Promise<RegistrationRecord> {
    const now = Date.now();
    const record: RegistrationRecord = {
      address: address,
      signedIdentity: signedIdentity,
      identity: identity,
      lastActive: lastActive,
      created: created,
      status: status,
      lastNotification: 0,
      lastSmsNotification: 0
    };
    if (timezone) {
      record.timezone = timezone;
    }
    if (notifications) {
      record.notifications = notifications;
    }
    await this.registrations.insert(record);
    return record;
  }

  async findRegistration(address: string): Promise<RegistrationRecord> {
    return await this.registrations.findOne<RegistrationRecord>({ address: address });
  }

  async updateRegistrationSettings(registration: RegistrationRecord, timezone?: string, notifications?: NotificationSettings): Promise<void> {
    if (!timezone && !notifications) {
      return;
    }
    const update: any = {};
    if (timezone) {
      update.timezone = timezone;
      registration.timezone = timezone;
    }
    if (notifications) {
      update.notifications = notifications;
      registration.notifications = notifications;
    }
    await this.registrations.update({ address: registration.address }, { $set: update });
  }

  async updateRegistrationLastActive(address: string): Promise<void> {
    await this.registrations.update({ address: address }, { $set: { lastActive: Date.now() } });
  }

  async updateRegistrationStatus(address: string, status: string): Promise<void> {
    await this.registrations.update({ address: address }, { $set: { status: status } });
  }

  async updateRegistrationLastNotificationSent(address: string): Promise<void> {
    const now = Date.now();
    await this.channelMembers.update({
      address: address
    }, { $set: { lastSmsNotification: now, lastNotification: now } });
  }

  async upsertSmsBlock(smsNumber: string, blocked: boolean, at: number): Promise<SmsBlockRecord> {
    const record: SmsBlockRecord = {
      smsNumber: smsNumber,
      blocked: blocked,
      at: at
    };
    await this.smsBlocks.update({ smsNumber: smsNumber }, record, { upsert: true });
    return record;
  }

  async findSmsBlockByNumber(smsNumber: string): Promise<SmsBlockRecord> {
    return await this.smsBlocks.findOne<SmsBlockRecord>({ smsNumber: smsNumber });
  }
}

const db = new Database();

export { db };
