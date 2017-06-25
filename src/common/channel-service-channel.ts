import { ChannelMemberInfo } from "./channel-service-identity";

export interface ServiceContractInfo {
  options: ChannelOptions;
  details: any;
}
export interface ParticipationContract {
  type: string;
  details?: any;
}
export interface ChannelContractDetails {
  package: string;
  serviceContract: ServiceContractInfo;
  participationContract: ParticipationContract;
}

export interface MemberServicesContractSmsDetails {
  smsNumber: string;  // E.164 format, e.g., +16505551212
  reference: string; // something to be appeneded to message -- typically client URL
}

export interface MemberServicesContractDetails {
  notificationType: string; // none, sms, web-push
  details?: MemberServicesContractSmsDetails; // | others depending on type
}

export interface BasicChannelInformation {
  channelAddress: string;
  contract: ChannelContractDetails;
  memberCount: number;
  created: number;
}

export interface ChannelInformation extends BasicChannelInformation {
  transportUrl: string;
  channelUrl: string;
  shareChannelUrl: string;
  deleteChannelUrl?: string;
  isCreator: boolean;
  members: ChannelMemberInfo[]; // in reverse chronological order based on lastActive; list may be truncated (compare against memberCount)
  lastUpdated: number;
}

export interface ChannelOptions {
  history?: boolean;
  maxHistoryCount?: number;
  maxHistorySeconds?: number;
  priority?: boolean;
  maxParticipants?: number;
  maxPayloadSize?: number;
  maxMessageRate?: number;
  maxDataRate?: number;
  topology: string; // many-to-many, one-to-many, many-to-one
}
