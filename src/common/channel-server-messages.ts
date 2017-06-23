import { TextDecoder, TextEncoder } from 'text-encoding';

// See https://github.com/ChannelElementsTeam/channel-server/wiki
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
  services: ProviderServiceList;
  implementationDetails: any; // for implementor to provide additional information
}

export interface RegistrationRequest {
  identity: any;
}

// Response from registration
export interface RegistrationResponse {
  id: string;
  token: string;
  services: ProviderServiceList;
}

export interface AccountResponse {
  id: string;
  services: ProviderServiceList;
}

export interface ProviderServiceList {
  providerUrl: string;
  serviceHomeUrl: string;
  registrationUrl: string;
  accountUrl: string;
  createChannelUrl: string;
  channelListUrl: string;
  shareChannelUrl: string;
  acceptChannelUrl: string;
}

export interface AccountUpdateRequest {
  identity: any;
}

export interface ShareRequest {
  channelAddress: string;
  details: any;
}

export interface ShareResponse {
  shareCodeUrl: string;
}

export interface ShareCodeResponse {
  providerUrl: string;
  registrationUrl: string;
  acceptChannelUrl: string;
  invitationId: string;
  details: any;
}

export interface ChannelAcceptRequest {
  invitationId: string;
  identity: SignedChannelMemberIdentity;
  memberServicesContract: MemberServicesContractDetails; // between me and service provider only
}

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

export interface ChannelMemberIdentity {
  address: string;
  publicKey: string;
  signedAt: number;
  name?: string;
  imageUrl?: string;
  contactMeShareCode?: string;
  details?: any;
}

export interface SignedChannelMemberIdentity {
  identity: ChannelMemberIdentity;
  signature: string;
}

export interface MemberServicesContractSmsDetails {
  smsNumber: string;  // E.164 format, e.g., +16505551212
  reference: string; // something to be appeneded to message -- typically client URL
}

export interface MemberServicesContractDetails {
  notificationType: string; // none, sms, web-push
  details?: MemberServicesContractSmsDetails; // | others depending on type
}

export interface ChannelCreateRequest {
  channelAddress: string;
  creatorIdentity: SignedChannelMemberIdentity;
  jwsSignature: any;  // see https://www.npmjs.com/package/node-jose#signing-content
  channelContract: ChannelContractDetails; // shared with everyone
  memberServicesContract: MemberServicesContractDetails; // between me and service provider only
}

export interface ChannelMemberInfo {
  identity: SignedChannelMemberIdentity;
  isCreator: boolean;
  memberSince: number;
  lastActive: number;
}

export interface GetChannelResponse {
  channelAddress: string;
  transportUrl: string;
  registerUrl: string;
  channelUrl: string;
  contract: ChannelContractDetails;
  isCreator: boolean;
  memberCount: number;
  recentlyActiveMembers: ChannelMemberInfo[];
  created: number;
  lastUpdated: number;
}

export interface ChannelDeleteResponseDetails {
  channelAddress: string;
}

export interface ChannelListResponse {
  total: number;
  channels: GetChannelResponse[];
}

export interface ChannelParticipantIdentity {
  memberIdentity: SignedChannelMemberIdentity;
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
  PingRequestDetails | ErrorDetails | RateLimitDetails |
  ChannelDeleteResponseDetails | ChannelDeletedNotificationDetails; // depends on type
}

export interface JoinRequestDetails {
  channelAddress: string;
  memberAddress: string;
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
  memberIdentity: SignedChannelMemberIdentity;

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

export class ChannelMessageUtils {
  static MESSAGE_HEADER_LENGTH = 32;
  static CHANNEL_ELEMENTS_VERSION_V1 = 0xCEB1;

  static serializeControlMessage(requestId: string, type: string, details: any, binaryPortion?: Uint8Array): Uint8Array {
    const controlMessage: ControlChannelMessage = {
      type: type,
      details: details
    };
    if (requestId) {
      controlMessage.requestId = requestId;
    }
    const messageInfo: MessageToSerialize = {
      channelCode: 0,
      senderCode: 0,
      history: false,
      priority: false,
      jsonMessage: controlMessage,
      binaryPayload: binaryPortion
    };
    return this.serializeChannelMessage(messageInfo, 0, 0);
  }

  static serializeChannelMessage(messageInfo: MessageToSerialize, lastTimestampSent: number, clockSkew: number): Uint8Array {
    // Allocate the proper length...
    let jsonPayloadBuffer: Uint8Array;
    let length = this.MESSAGE_HEADER_LENGTH;
    if (messageInfo.jsonMessage) {
      length += 4;
      if (messageInfo.jsonMessage) {
        jsonPayloadBuffer = new TextEncoder().encode(JSON.stringify(messageInfo.jsonMessage));
        length += jsonPayloadBuffer.byteLength;
      }
    }
    if (messageInfo.binaryPayload) {
      length += messageInfo.binaryPayload.byteLength;
    }
    const result = new Uint8Array(length);
    const view = new DataView(result.buffer);

    // Populate the header...

    let timestamp: number = Date.now() + clockSkew;
    if (timestamp <= lastTimestampSent) {
      timestamp = lastTimestampSent + 1;
    }
    view.setUint16(0, this.CHANNEL_ELEMENTS_VERSION_V1);
    const topTime = Math.floor(timestamp / (Math.pow(2, 32)));
    view.setUint16(2, topTime);
    const remainder = timestamp - (topTime * Math.pow(2, 32));
    view.setUint32(4, remainder);
    view.setUint32(8, messageInfo.channelCode ? messageInfo.channelCode : 0);
    view.setUint32(12, messageInfo.senderCode ? messageInfo.senderCode : 0);
    let behavior = 0;
    if (messageInfo.priority) {
      behavior |= 0x01;
    }
    if (messageInfo.history) {
      behavior |= 0x02;
    }
    view.setUint8(16, behavior);
    result.fill(0, 17, this.MESSAGE_HEADER_LENGTH);

    // Now the payload...

    let offset = this.MESSAGE_HEADER_LENGTH;
    if (jsonPayloadBuffer) {
      view.setUint32(offset, jsonPayloadBuffer.byteLength);
      offset += 4;
      result.set(jsonPayloadBuffer, offset);
      offset += jsonPayloadBuffer.byteLength;
    }
    if (messageInfo.binaryPayload) {
      result.set(messageInfo.binaryPayload, offset);
    }
    return result;
  }

  static parseChannelMessage(message: Uint8Array, enforceClockSync = true): DeserializedMessage {
    const result: DeserializedMessage = {
      valid: false,
      rawMessage: message
    };
    if (message.length < this.MESSAGE_HEADER_LENGTH) {
      result.errorMessage = 'Message is too short';
      return result;
    }
    const view = new DataView(message.buffer, message.byteOffset);
    if (view.getUint16(0) !== this.CHANNEL_ELEMENTS_VERSION_V1) {
      result.errorMessage = 'Message prefix is invalid.  Incorrect protocol?';
      return result;
    }
    const topBytes = view.getUint16(2);
    const bottomBytes = view.getUint32(4);
    const timestamp = topBytes * Math.pow(2, 32) + bottomBytes;
    const delta = Date.now() - timestamp;
    if (enforceClockSync && Math.abs(delta) > 15000) {
      result.valid = false;
      result.errorMessage = "Clocks are too far out of sync, or message timestamp is invalid";
      return result;
    }
    const behavior = view.getUint8(16);
    const contents: ChannelMessage = {
      serializedMessage: message,
      timestamp: timestamp,
      channelCode: view.getUint32(8),
      senderCode: view.getUint32(12),
      priority: (behavior & 0x01) ? true : false,
      history: (behavior & 0x02) ? true : false,
      fullPayload: new Uint8Array(message.buffer, message.byteOffset + this.MESSAGE_HEADER_LENGTH, message.byteLength - this.MESSAGE_HEADER_LENGTH)
    };
    result.contents = contents;
    result.valid = true;
    if (contents.channelCode === 0 && contents.senderCode === 0) {
      const jsonLength = view.getUint32(this.MESSAGE_HEADER_LENGTH);
      try {
        const jsonString = new TextDecoder("utf-8").decode(message.subarray(this.MESSAGE_HEADER_LENGTH + 4, this.MESSAGE_HEADER_LENGTH + 4 + jsonLength));
        contents.controlMessagePayload = {
          jsonMessage: JSON.parse(jsonString)
        };
        if (message.byteLength > this.MESSAGE_HEADER_LENGTH + 4 + jsonLength) {
          contents.controlMessagePayload.binaryPortion = new Uint8Array(contents.fullPayload.buffer, contents.fullPayload.byteOffset + 4 + jsonLength, contents.fullPayload.byteLength - 4 - jsonLength);
        }
      } catch (err) {
        result.valid = false;
        result.errorMessage = "Invalid control message payload";
      }
    }
    return result;
  }

}

export interface MessageToSerialize {
  channelCode: number;
  senderCode: number;
  priority: boolean;
  history: boolean;
  jsonMessage?: any;
  binaryPayload?: Uint8Array;
}

export interface ChannelMessage {
  serializedMessage: Uint8Array;
  timestamp: number;
  channelCode: number;
  senderCode: number;
  priority: boolean;
  history: boolean;
  fullPayload?: Uint8Array;
  controlMessagePayload?: {
    jsonMessage: any;
    binaryPortion?: Uint8Array;
  };
}

export interface DeserializedMessage {
  valid: boolean;
  errorMessage?: string;
  rawMessage?: Uint8Array;
  contents?: ChannelMessage;
}
