import { ChannelOptions } from "./db-records";

export interface ProviderServiceList {
  providerUrl: string;
  serviceHomeUrl: string;
  registrationUrl: string;
  accountUrl: string;
  createChannelUrl: string;
  channelListUrl: string;
}
export interface BraidResponse {
  version: number;
  services: ProviderServiceList;
}

export interface RegistrationRequest {
  identity: any;
}

export interface RegistrationResponse {
  id: string;
  token: string;
  services: ProviderServiceList;
}

export interface AccountResponse {
  id: string;
  services: ProviderServiceList;
  identity: any;
}

export interface AccountUpdateRequest {
  identity: any;
}

export interface ShareRequest {
  details: any;
}

export interface ShareResponse {
  shareCodeUrl: string;
}

export interface ShareCodeResponse {
  providerUrl: string;
  registrationUrl: string;
  channelId: string;
  channelUrl: string;
  details: any;
}

export interface ChannelCreateRequest {
  options?: ChannelOptions;
  details?: any;
}

export interface ChannelMemberInfo {
  participantId: string;
  details: any;
  isCreator: boolean;
  memberSince: number;
  lastActive: number;
}

export interface GetChannelResponse {
  channelId: string;
  transportUrl: string;
  registerUrl: string;
  channelUrl: string;
  sharingUrl: string;
  options: ChannelOptions;
  details: any;
  members: ChannelMemberInfo[];
  created: number;
  lastUpdated: number;
}

export interface ChannelSummary {
  channelId: string;
  channelUrl: string;
  isCreator: boolean;
  lastActive: number;
  details?: any;
}

export interface ChannelListResponse {
  total: number;
  channels: ChannelSummary[];
}

export interface ChannelParticipantInfo {
  participantId: string;
  code: number;
  details: any;
  isCreator: boolean;
  isYou: boolean;
  memberSince: number;
  lastActive: number;
}

export interface ControlChannelMessage {
  requestId?: string;
  type: string; // join, join-reply, leave, leave-reply, joined, left
  details: any; // depends on type
}

export interface JoinRequestDetails {
  channelId: string;
  participantDetails?: any;
}

export interface JoinResponseDetails {
  channelId: string;
  channelCode: number;
  participantId: string;
  participantCode: number;
  participants: ChannelParticipantInfo[];
}

export interface LeaveRequestDetails {
  channelId: string;
  permanently?: boolean;
}

export interface HistoryRequestDetails {
  channelId: string;
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
  channelId: string;
  participantId: string;
}

export interface ErrorDetails {
  statusCode: number;
  errorMessage: string;
}

export interface JoinNotificationDetails {
  channelId: string;
  participantId: string;
  participantCode: number;
  participantDetails: any;
}

export interface LeaveNotificationDetails {
  channelId: string;
  participantId: string;
  participantCode: number;
  permanently: boolean;
}

export interface ControlMessagePayload {
  jsonMessage: ControlChannelMessage;
  binaryPortion?: Uint8Array;
}

export interface MessageInfo {
  timestamp?: number;
  channelCode?: number;
  senderCode?: number;
  priority?: boolean;
  history?: boolean;
  controlMessagePayload?: ControlMessagePayload;
  rawPayload?: Uint8Array;
}

export interface ParsedMessageInfo {
  valid: boolean;
  errorMessage?: string;
  rawMessage?: Uint8Array;
  info?: MessageInfo;
}
