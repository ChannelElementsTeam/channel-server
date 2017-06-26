import { MemberContractDetails, ChannelContractDetails, ChannelInformation, BasicChannelInformation } from "./channel-service-channel";
import { AddressIdentity, Signable, SignedKeyIdentity, SignedAddressIdentity } from "./channel-service-identity";

export const CHANNELS_PROTOCOL = "https://channelelements.com/protocols/client-server/0.2.0";
// ----------------------------------------------------------------------------
// JSON response to /channel-elements.json
// ----------------------------------------------------------------------------
export interface ChannelServiceDescription extends HasProtocolVersion, HasServiceEndpoints, HasExtensions {
  protocol: string;
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
    extensions: any;
  };
  serviceEndpoints: ProviderServiceEndpoints;
}

// ----------------------------------------------------------------------------
// Response to GET share code URL (when request contains header: Accepts: application/json)
// ----------------------------------------------------------------------------

export interface ChannelShareCodeResponse extends HasProtocolVersion, HasServiceEndpoints, HasExtensions {
  invitationId: string;
  channelInfo: BasicChannelInformation;
}

// ----------------------------------------------------------------------------
// REST Requests to serviceURL
// All requests use POST and include signed identity
// All requests and responses are in JSON
// ----------------------------------------------------------------------------

export interface ChannelServiceRequest<I extends SignedKeyIdentity | SignedAddressIdentity, T> {
  type: string;
  identity: I;
  details: T;
}

// type = 'create', identity type:  SignedKeyIdentity
export interface ChannelCreateDetails extends HasMemberContractDetails {
  channelContract: ChannelContractDetails; // shared with everyone
}
export interface ChannelCreateResponse extends ChannelInformation { }

// type = 'share', identity type:  SignedAddressIdentity
export interface ChannelShareDetails extends HasChannel, HasExtensions {
  extensions: any;
}
export interface ChannelShareResponse {
  shareCodeUrl: string;
}

// type = 'get', identity type:  SignedAddressIdentity
export interface ChannelGetDetails extends HasChannel { }
export interface ChannelGetResponse extends ChannelInformation { }

// type = 'accept', identity type:  SignedKeyIdentity
export interface ChannelAcceptDetails extends HasMemberContractDetails {
  invitationId: string;
}
export interface ChannelAcceptResponse extends ChannelInformation { }

// type = 'delete', identity type:  SignedAddressIdentity
export interface ChannelDeleteDetails extends HasChannel { }
export interface ChannelDeleteResponse { }

// type = 'list', identity type:  SignedAddressIdentity
export interface ChannelsListDetails {
  lastActiveBefore?: number;
  limit?: number;
}
export interface ChannelsListResponse {
  total: number;
  channels: ChannelInformation[];
}

// ----------------------------------------------------------------------------
// Miscellaneous interfaces
// ----------------------------------------------------------------------------

export interface ProviderServiceEndpoints {
  descriptionUrl: string; // returns ChannelServiceDescription in JSON
  homeUrl: string;  // human-oriented service description, suitable for browser
  restServiceUrl: string;  // to use the service, always with POST with identity and signature
}

export interface HasExtensions {
  extensions?: any;
}

export interface HasMemberContractDetails {
  memberContract: MemberContractDetails;
}

export interface HasChannel {
  channel: string;
}

export interface HasProtocolVersion {
  protocol: string;  // e.g., "1.0.0":  conforms to which version of the specification
}

export interface HasServiceEndpoints {
  serviceEndpoints: ProviderServiceEndpoints;
}
