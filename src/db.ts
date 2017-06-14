import { Cursor, MongoClient, Db, Collection } from "mongodb";

import { ChannelRecord, ChannelMemberRecord, UserRecord, ChannelInvitation, MessageRecord } from "./interfaces/db-records";
import { configuration } from "./configuration";
import { ChannelOptions } from "./interfaces/channel-server-interfaces";

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
    await this.channels.createIndex({ channelId: 1 }, { unique: true });
  }

  private async initializeChannelMembers(): Promise<void> {
    this.channelMembers = this.db.collection('channelMembers');
    await this.channelMembers.createIndex({ channelId: 1, userId: 1 }, { unique: true });
    await this.channelMembers.createIndex({ channelId: 1, participantId: 1 }, { unique: true });
    await this.channelMembers.createIndex({ channelId: 1, status: 1, userId: 1 });
    await this.channelMembers.createIndex({ userId: 1, status: 1, lastActive: -1 }, { unique: true });
  }

  private async initializeInvitations(): Promise<void> {
    this.invitations = this.db.collection('invitations');
    await this.invitations.createIndex({ id: 1 }, { unique: true });
  }

  private async initializeMessages(): Promise<void> {
    this.messages = this.db.collection('messages');
    await this.messages.createIndex({ channelId: 1, participantId: 1, timestamp: -1 }, { unique: true });
    await this.messages.createIndex({ channelId: 1, timestamp: -1 });
  }

  async insertUser(id: string, token: string, identity: any, status: string): Promise<UserRecord> {
    const now = Date.now();
    const record: UserRecord = {
      id: id,
      token: token,
      identity: identity,
      created: now,
      lastRequest: now,
      status: status
    };
    await this.users.insert(record);
    return record;
  }

  async findUserById(id: string): Promise<UserRecord> {
    return await this.users.findOne({ id: id });
  }

  async findUserByToken(token: string): Promise<UserRecord> {
    return await this.users.findOne({ token: token });
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

  async insertChannel(channelId: string, creatorId: string, transportUrl: string, options: ChannelOptions, details: any, status: string): Promise<ChannelRecord> {
    const now = Date.now();
    const record: ChannelRecord = {
      channelId: channelId,
      creatorId: creatorId,
      transportUrl: transportUrl,
      created: now,
      lastUpdated: now,
      deleted: 0,
      options: options,
      details: details,
      status: status
    };
    await this.channels.insert(record);
    return record;
  }

  async findChannelById(channelId: string): Promise<ChannelRecord> {
    return await this.channels.findOne({ channelId: channelId });
  }

  async findChannelByCreatorToken(token: string): Promise<ChannelRecord> {
    return await this.channels.findOne({ creatorToken: token });
  }

  async updateChannelStatus(channelId: string, status: string): Promise<void> {
    await this.channels.update({ channelId: channelId }, { $set: { status: status } });
  }

  async insertChannelMember(channelId: string, participantId: string, userId: string, participantDetails: any, status: string): Promise<ChannelMemberRecord> {
    const now = Date.now();
    const record: ChannelMemberRecord = {
      channelId: channelId,
      participantId: participantId,
      userId: userId,
      participantDetails: participantDetails,
      added: now,
      status: status,
      lastActive: now
    };
    await this.channelMembers.insert(record);
    return record;
  }

  async findChannelMember(channelId: string, userId: string): Promise<ChannelMemberRecord> {
    return await this.channelMembers.findOne({ channelId: channelId, userId: userId });
  }

  async updateChannelMemberActive(channelId: string, userId: string, status: string, lastActive: number, identity?: any): Promise<void> {
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
    await this.channelMembers.update({ channelId: channelId, userId: userId }, { $set: update });
  }

  async findChannelMembers(channelId: string, status: string): Promise<ChannelMemberRecord[]> {
    return await this.channelMembers.find({ channelId: channelId, status: status }).sort({ userId: 1 }).toArray();
  }

  async countChannelMembersByUserId(userId: string, status: string, lastActiveBefore = 0, limit = 100): Promise<number> {
    const query: any = {
      userId: userId,
      status: status,
    };
    if (lastActiveBefore) {
      query.lastActive = { $lte: lastActiveBefore };
    }
    return await this.channelMembers.count(query);
  }

  async findChannelMembersByUserId(userId: string, status: string, lastActiveBefore = 0, limit = 100): Promise<ChannelMemberRecord[]> {
    const query: any = {
      userId: userId,
      status: status,
    };
    if (lastActiveBefore) {
      query.lastActive = { $lte: lastActiveBefore };
    }
    return await this.channelMembers.find(query).sort({ lastActive: -1 }).limit(limit).toArray();
  }

  async insertInvitation(id: string, sharedByUserId: string, channelId: string, details: any): Promise<ChannelInvitation> {
    const now = Date.now();
    const record: ChannelInvitation = {
      id: id,
      sharedByUserId: sharedByUserId,
      channelId: channelId,
      details: details,
      created: now
    };
    await this.invitations.insert(record);
    return record;
  }

  async findInvitationById(id: string): Promise<ChannelInvitation> {
    return await this.invitations.findOne({ id: id });
  }

  async insertMessage(channelId: string, participantId: string, timestamp: number, size: number, contents: Uint8Array): Promise<MessageRecord> {
    const record: MessageRecord = {
      channelId: channelId,
      participantId: participantId,
      timestamp: timestamp,
      size: contents.length,
      contents: contents.join(',')
    };
    await this.messages.update({ channelId: channelId, participantId: participantId, timestamp: timestamp }, record, { upsert: true });
    return record;
  }

  findMessages(channelId: string, before: number, after: number): Cursor<MessageRecord> {
    const query: any = {
      channelId: channelId
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
    return this.messages.find(query).sort({ timestamp: -1 });
  }

  async countMessages(channelId: string, before: number, after: number): Promise<number> {
    const query: any = {
      channelId: channelId
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
