
import { ChannelContractDetails, MemberContractDetails, FullIdentity, SignedKeyIdentity, NotificationSettings, KeyIdentity } from "channels-common";

export interface RegistrationRecord {
  address: string;
  signedIdentity: SignedKeyIdentity;
  identity: KeyIdentity;
  lastActive: number;
  created: number;
  status: string;
  timezone?: string;  // such as 'America/Los_Angeles'
  notifications?: NotificationSettings;
  lastSmsNotification: number;
  lastNotification: number;
}

export interface SmsBlockRecord {
  smsNumber: string;
  blocked: boolean;
  at: number;
}

export interface ChannelRecord {
  channelAddress: string;
  name?: string;
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
  signedIdentity: SignedKeyIdentity;
  identity: FullIdentity;
  memberServices: MemberContractDetails;
  added: number;
  status: string;
  lastActive: number;
  lastNotificationConsidered: number;
  lastNotificationSent: number;
}

export interface ChannelInvitation {
  id: string;
  sharedByAddress: string;
  channelAddress: string;
  extensions?: any;
  created: number;
}

export interface MessageRecord {
  channelAddress: string;
  senderAddress: string;
  timestamp: number;
  size: number;
  contents: string;
}
