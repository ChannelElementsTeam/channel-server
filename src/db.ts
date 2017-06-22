import { Cursor, MongoClient, Db, Collection } from "mongodb";

import { ChannelRecord, ChannelMemberRecord, UserRecord, ChannelInvitation, MessageRecord } from "./interfaces/db-records";
import { configuration } from "./configuration";
import { ChannelOptions, ChannelContractDetails, ChannelMemberIdentity } from "./common/channel-server-messages";

export class Database {
  private db: Db;
  private users: Collection;
  private channels: Collection;
  private channelMembers: Collection;
  private invitations: Collection;
  private messages: Collection;

  async initialize(): Promise<void> {
    const serverOptions = configuration.get('mongo.serverOptions');
    const options: any = { db: { w: 1 } };
    if (serverOptions) {
      options.server = serverOptions;
    }
    this.db = await MongoClient.connect(configuration.get('mongo.mongoUrl', options));
    await this.initializeUsers();
    await this.initializeChannels();
    await this.initializeChannelMembers();
    await this.initializeInvitations();
    await this.initializeMessages();
  }

  private async initializeUsers(): Promise<void> {
    this.users = this.db.collection('users');
    await this.users.createIndex({ id: 1 }, { unique: true });
  }

  private async initializeChannels(): Promise<void> {
    this.channels = this.db.collection('channels');
    await this.channels.createIndex({ channelAddress: 1 }, { unique: true });
    await this.channels.createIndex({ lastUpdated: -1 });
  }

  private async initializeChannelMembers(): Promise<void> {
    this.channelMembers = this.db.collection('channelMembers');
    await this.channelMembers.createIndex({ channelAddress: 1, userId: 1 }, { unique: true });
    await this.channelMembers.createIndex({ channelAddress: 1, status: 1, lastActive: -1 });
    await this.channelMembers.createIndex({ userId: 1, status: 1, lastActive: -1 });
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

  async insertUser(id: string, token: string, identity: any, status: string): Promise<UserRecord> {
    const now = Date.now();
    const record: UserRecord = {
      id: id,
      token: token,
      created: now,
      lastRequest: now,
      status: status
    };
    await this.users.insert(record);
    return record;
  }

  async findUserById(id: string): Promise<UserRecord> {
    return await this.users.findOne<UserRecord>({ id: id });
  }

  async updateUserStatus(id: string, status: string): Promise<void> {
    await this.users.update({ id: id }, { $set: { status: status } });
  }

  async updateUserLastRequest(id: string, at: number): Promise<void> {
    await this.users.update({ id: id }, { $set: { lastRequest: at } });
  }

  async updateUserIdentity(id: string, identity: any): Promise<void> {
    await this.users.update({ id: id }, { $set: { identity: identity } });
  }

  async insertChannel(channelAddress: string, creatorUserId: string, creatorAddress: string, transportUrl: string, contract: ChannelContractDetails, status: string): Promise<ChannelRecord> {
    const now = Date.now();
    const record: ChannelRecord = {
      channelAddress: channelAddress,
      creatorAddress: creatorAddress,
      creatorUserId: creatorUserId,
      transportUrl: transportUrl,
      created: now,
      lastUpdated: now,
      deleted: 0,
      contract: contract,
      status: status
    };
    await this.channels.insert(record);
    return record;
  }

  async findChannelById(channelAddress: string): Promise<ChannelRecord> {
    return await this.channels.findOne<ChannelRecord>({ channelAddress: channelAddress });
  }

  async findUpdatedChannels(lastUpdatedSince: number): Promise<ChannelRecord[]> {
    return await this.channels.find<ChannelRecord>({ lastUpdated: { $gt: lastUpdatedSince } }).toArray();
  }

  async updateChannelStatus(channelAddress: string, status: string): Promise<void> {
    await this.channels.update({ channelAddress: channelAddress }, { $set: { status: status, lastUpdated: Date.now() } });
  }

  async insertChannelMember(channelAddress: string, identity: ChannelMemberIdentity, userId: string, status: string): Promise<ChannelMemberRecord> {
    const now = Date.now();
    const record: ChannelMemberRecord = {
      channelAddress: channelAddress,
      identity: identity,
      userId: userId,
      added: now,
      status: status,
      lastActive: now
    };
    await this.channelMembers.insert(record);
    return record;
  }

  async findChannelMember(channelAddress: string, userId: string): Promise<ChannelMemberRecord> {
    return await this.channelMembers.findOne<ChannelMemberRecord>({ channelAddress: channelAddress, userId: userId });
  }

  async updateChannelMemberActive(channelAddress: string, userId: string, status: string, lastActive: number, identity?: any): Promise<void> {
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
    await this.channelMembers.update({ channelAddress: channelAddress, userId: userId }, { $set: update });
  }

  async countChannelMembers(channelAddress: string, status: string): Promise<number> {
    return await this.channelMembers.count({ channelAddress: channelAddress, status: status });
  }

  async findChannelMembers(channelAddress: string, status: string, limit = 50): Promise<ChannelMemberRecord[]> {
    return await this.channelMembers.find<ChannelMemberRecord>({ channelAddress: channelAddress, status: status }).sort({ lastActive: -1 }).limit(limit).toArray();
  }

  async countChannelMembersByUserId(userId: string, status: string, lastActiveBefore = 0): Promise<number> {
    const query: any = {
      userId: userId,
      status: status,
    };
    if (lastActiveBefore) {
      query.lastActive = { $lte: lastActiveBefore };
    }
    return await this.channelMembers.count(query);
  }

  async findChannelMembersByUserId(userId: string, status: string, lastActiveBefore = 0, limit = 50): Promise<ChannelMemberRecord[]> {
    const query: any = {
      userId: userId,
      status: status,
    };
    if (lastActiveBefore) {
      query.lastActive = { $lte: lastActiveBefore };
    }
    return await this.channelMembers.find<ChannelMemberRecord>(query).sort({ lastActive: -1 }).limit(limit).toArray();
  }

  async insertInvitation(id: string, sharedByAddress: string, channelAddress: string, details: any): Promise<ChannelInvitation> {
    const now = Date.now();
    const record: ChannelInvitation = {
      id: id,
      sharedByAddress: sharedByAddress,
      channelAddress: channelAddress,
      details: details,
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

}

const db = new Database();

export { db };
