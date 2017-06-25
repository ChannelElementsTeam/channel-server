import { SignedFullIdentity, SignedAddress, SignedBasicIdentity } from "./channel-service-identity";
import { MemberServicesContractDetails, ChannelContractDetails, ChannelInformation, BasicChannelInformation } from "./channel-service-channel";

export interface ChannelServerResponse {
  protocolVersion: string;  // e.g., "1.0.0":  conforms to which version of the specification
  provider: {
    name: string;
    logo: string;
    homepage: string;
    details: any;
  };
  implementation: {
    name: string;
    logo: string;
    homepage: string;
    version: string;
    details: any;
  };
  services: ProviderServicesListResponse;
  implementationDetails: any; // for implementor to provide additional information
}

export interface ProviderServicesListResponse {
  providerUrl: string;
  serviceHomeUrl: string;
  accountUrl: string;
  createChannelUrl: string;
  channelListUrl: string;
}

// POST /d/channels/create
export interface ChannelCreateRequest extends ChannelServiceRequest<SignedFullIdentity> {
  channelContract: ChannelContractDetails; // shared with everyone
  memberServicesContract: MemberServicesContractDetails; // between me and service provider only
}
export interface ChannelCreateResponse extends ChannelInformation { }

// POST /d/channels/:channel/share
export interface ChannelShareRequest extends ChannelServiceRequest<SignedAddress> {
  details: any;
}

export interface ChannelGetRequest extends ChannelServiceRequest<SignedAddress> { }

export interface ChannelGetResponse extends ChannelInformation { }
export interface ChannelShareResponse {
  shareCodeUrl: string;
}

// POST /d/channels/:channel/accept
export interface ChannelAcceptRequest extends ChannelServiceRequest<SignedFullIdentity> {
  invitationId: string;
  memberServicesContract: MemberServicesContractDetails; // between me and service provider only
}

export interface ChannelAcceptResponse extends ChannelInformation { }

// POST /d/channels/:channel/delete
export interface ChannelDeleteRequest extends ChannelServiceRequest<SignedAddress> { }

export interface ChannelDeleteResponse { }

// POST /d/channels/list
export interface ChannelsListRequest extends ChannelServiceRequest<SignedBasicIdentity> {
  lastActiveBefore?: number;
  limit?: number;
}

export interface ChannelsListResponse {
  total: number;
  channels: ChannelInformation[];
}

// In response to GET on a share code URL:
export interface ChannelShareCodeResponse {
  providerUrl: string;
  acceptChannelUrl: string;
  invitationId: string;
  channelInfo: BasicChannelInformation;
  invitationDetails: any;
}

// Supporting interfaces

export interface ChannelServiceRequest<T> {
  identity: T;
}
