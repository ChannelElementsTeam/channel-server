
import { ChannelOptions } from "./channel-server-interfaces";

export interface UserRecord {
  id: string;
  token: string;
  identity: any;
  created: number;
  lastRequest: number;
  status: string;
}

export interface ChannelRecord {
  channelId: string;
  creatorId: string;
  transportUrl: string;
  created: number;
  lastUpdated: number;
  deleted: number;
  options: ChannelOptions;
  details: any;
  status: string;
}

export interface ChannelMemberRecord {
  channelId: string;
  participantId: string;
  userId: string;
  participantDetails: any;
  added: number;
  status: string;
  lastActive: number;
}

export interface ChannelInvitation {
  id: string;
  sharedByUserId: string;
  channelId: string;
  details?: any;
  created: number;
}

export interface MessageRecord {
  channelId: string;
  participantId: string;
  timestamp: number;
  size: number;
  contents: string;
}
