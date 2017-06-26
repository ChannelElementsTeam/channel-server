
import { FullIdentity, AddressIdentity, SignedAddressIdentity, SignedKeyIdentity } from "./channel-service-identity";

// ----------------------------------------------------------------------------
// This defines the content of the messages carried on the control channel
// on the websocket
// ----------------------------------------------------------------------------

export interface ControlChannelMessage {
  requestId?: string;
  type: string;
  details: JoinRequestDetails | JoinResponseDetails | JoinNotificationDetails |
  LeaveRequestDetails | LeaveNotificationDetails |
  HistoryRequestDetails | HistoryResponseDetails | HistoryMessageDetails |
  PingRequestDetails | ErrorDetails | RateLimitDetails | ChannelDeletedNotificationDetails;
}

// type = 'join'
export interface JoinRequestDetails {
  channelAddress: string;
  memberIdentity: SignedAddressIdentity;
  participantIdentityDetails: any;
}

// type = 'join-response'
export interface JoinResponseDetails {
  channelAddress: string;
  channelCode: number;
  participantCode: number;
  participants: ChannelParticipantInfo[];
}

// type = 'leave'
export interface LeaveRequestDetails {
  channelAddress: string;
  permanently?: boolean;
}

// type = 'send-wakeup'

// type = 'history'
export interface HistoryRequestDetails {
  channelAddress: string;
  before: number;
  after?: number;
  maxCount: number;
}

// type = 'history-response'
export interface HistoryResponseDetails {
  count: number;
  total: number;
}

// type = 'history-message'
export interface HistoryMessageDetails {
  timestamp: number;
  channelAddress: string;
  senderAddress: string;
}

// type = 'ping'
export interface PingRequestDetails {
  interval?: number;
}

// type = 'error'
export interface ErrorDetails {
  statusCode: number;
  errorMessage: string;
  channelAddress?: string;
}

// type = 'rate-limit'
export interface RateLimitDetails {
  channelAddress: string;
  options: string[];
}

// type = 'notify-join'
export interface JoinNotificationDetails {
  channelAddress: string;
  memberIdentity: SignedKeyIdentity;

  participantCode: number;
  participantDetails: any;
}

// type = 'notify-leave'
export interface LeaveNotificationDetails {
  channelAddress: string;
  participantAddress: string;
  participantCode: number;
  permanently: boolean;
}

// type = 'notify-channel-delete'
export interface ChannelDeletedNotificationDetails {
  channelAddress: string;
}

// ----------------------------------------------------------------------------
// Miscellaneous interfaces
// ----------------------------------------------------------------------------

export interface ControlMessagePayload {
  jsonMessage: ControlChannelMessage;
  binaryPortion?: Uint8Array;
}

export interface ChannelParticipantIdentity {
  signedIdentity: SignedKeyIdentity;
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
