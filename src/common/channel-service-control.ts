
import { SignedIdentity, FullIdentity, AddressIdentity } from "./channel-service-identity";

export interface ChannelParticipantIdentity {
  memberIdentity: SignedIdentity<FullIdentity>;
  participantDetails: any;
}

export interface ChannelParticipantInfo {
  code: number;
  participantIdentity: ChannelParticipantIdentity;
  isCreator: boolean;
  isYou: boolean;
  memberSince: number;
  lastActive: number;
}

export interface ControlChannelMessage {
  requestId?: string;
  type: string; // see https://github.com/ChannelElementsTeam/channel-server/wiki/Control-Channel-Messages
  details: JoinRequestDetails | JoinResponseDetails | JoinNotificationDetails |
  LeaveRequestDetails | LeaveNotificationDetails |
  HistoryRequestDetails | HistoryResponseDetails | HistoryMessageDetails |
  PingRequestDetails | ErrorDetails | RateLimitDetails | ChannelDeletedNotificationDetails; // depends on type
}

export interface JoinRequestDetails {
  channelAddress: string;
  memberIdentity: SignedIdentity<AddressIdentity>;
  participantIdentityDetails: any;
}

export interface JoinResponseDetails {
  channelAddress: string;
  channelCode: number;
  participantAddress: string;
  participantCode: number;
  participants: ChannelParticipantInfo[];
}

export interface LeaveRequestDetails {
  channelAddress: string;
  memberAddress: string;
  permanently?: boolean;
}

export interface HistoryRequestDetails {
  channelAddress: string;
  before: number;
  after?: number;
  maxCount: number;
}

export interface HistoryResponseDetails {
  count: number;
  total: number;
}

export interface HistoryMessageDetails {
  timestamp: number;
  channelAddress: string;
  senderAddress: string;
}

export interface PingRequestDetails {
  interval?: number;
}

export interface ErrorDetails {
  statusCode: number;
  errorMessage: string;
  channelAddress?: string;
}

export interface RateLimitDetails {
  channelAddress: string;
  options: string[];
}

export interface JoinNotificationDetails {
  channelAddress: string;
  memberIdentity: SignedIdentity<FullIdentity>;

  participantCode: number;
  participantDetails: any;
}

export interface LeaveNotificationDetails {
  channelAddress: string;
  participantAddress: string;
  participantCode: number;
  permanently: boolean;
}

export interface ChannelDeletedNotificationDetails {
  channelAddress: string;
}

export interface ControlMessagePayload {
  jsonMessage: ControlChannelMessage;
  binaryPortion?: Uint8Array;
}
