
import { ChannelOptions, ChannelContractDetails, ChannelMemberIdentity } from "../common/channel-server-messages";

export interface UserRecord {
  id: string;
  token: string;
  created: number;
  lastRequest: number;
  status: string;
}

export interface ChannelRecord {
  channelAddress: string;
  creatorUserId: string;
  creatorAddress: string;
  transportUrl: string;
  created: number;
  lastUpdated: number;
  deleted: number;
  contract: ChannelContractDetails;
  status: string;
}

export interface ChannelMemberRecord {
  channelAddress: string;
  userId: string;
  identity: ChannelMemberIdentity;
  added: number;
  status: string;
  lastActive: number;
}

export interface ChannelInvitation {
  id: string;
  sharedByAddress: string;
  channelAddress: string;
  details?: any;
  created: number;
}

export interface MessageRecord {
  channelAddress: string;
  senderAddress: string;
  timestamp: number;
  size: number;
  contents: string;
}
