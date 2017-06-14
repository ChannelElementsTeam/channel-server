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
  identity: any;
}

export interface ProviderServiceList {
  providerUrl: string;
  serviceHomeUrl: string;
  registrationUrl: string;
  accountUrl: string;
  createChannelUrl: string;
  channelListUrl: string;
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
  type: string; // see https://github.com/ChannelElementsTeam/channel-server/wiki/Control-Channel-Messages
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

export interface PingRequestDetails {
  interval?: number;
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

export interface ChannelOptions {
  history?: boolean;
  maxHistoryCount?: number;
  maxHistorySeconds?: number;
  priority?: boolean;
  maxParticipants?: number;
  maxPayloadSize?: number;
  maxMessageRate?: number;
  maxDataRate?: number;
  mode?: string; // many-to-many, one-to-many, many-to-one
}

export class ChannelMessageUtils {
  static MESSAGE_HEADER_LENGTH = 32;

  static serializeControlMessage(requestId: string, type: string, details: any, binaryPortion?: Uint8Array): Uint8Array {
    const controlMessage: ControlChannelMessage = {
      type: type,
      details: details
    };
    if (requestId) {
      controlMessage.requestId = requestId;
    }
    const controlPayload: ControlMessagePayload = {
      jsonMessage: controlMessage,
      binaryPortion: binaryPortion
    };
    const messageInfo: MessageInfo = {
      controlMessagePayload: controlPayload
    };
    return this.serializeChannelMessage(messageInfo, 0, 0);
  }

  static serializeChannelMessage(messageInfo: MessageInfo, lastTimestampSent: number, clockSkew: number): Uint8Array {
    // Allocate the proper length...
    let jsonPayloadBuffer: Uint8Array;
    let length = this.MESSAGE_HEADER_LENGTH;
    if (messageInfo.controlMessagePayload) {
      length += 4;
      if (messageInfo.controlMessagePayload.jsonMessage) {
        jsonPayloadBuffer = new TextEncoder().encode(JSON.stringify(messageInfo.controlMessagePayload.jsonMessage));
        length += jsonPayloadBuffer.byteLength;
      }
      if (messageInfo.controlMessagePayload.binaryPortion) {
        length += messageInfo.controlMessagePayload.binaryPortion.byteLength;
      }
    }
    if (messageInfo.rawPayload) {
      length += messageInfo.rawPayload.byteLength;
    }
    const result = new Uint8Array(length);
    const view = new DataView(result.buffer);

    // Populate the header...

    let timestamp: number = Date.now() + clockSkew;
    if (timestamp <= lastTimestampSent) {
      timestamp = lastTimestampSent + 1;
    }
    const topTime = Math.floor(timestamp / (Math.pow(2, 32)));
    view.setUint16(0, topTime);
    const remainder = timestamp - (topTime * Math.pow(2, 32));
    view.setUint32(2, remainder);
    view.setUint32(6, messageInfo.channelCode ? messageInfo.channelCode : 0);
    view.setUint32(10, messageInfo.senderCode ? messageInfo.senderCode : 0);
    let behavior = 0;
    if (messageInfo.priority) {
      behavior |= 0x01;
    }
    if (messageInfo.history) {
      behavior |= 0x02;
    }
    view.setUint8(14, behavior);
    result.fill(0, 15, this.MESSAGE_HEADER_LENGTH);

    // Now the payload...

    let offset = this.MESSAGE_HEADER_LENGTH;
    if (messageInfo.controlMessagePayload) {
      if (jsonPayloadBuffer) {
        view.setUint32(offset, jsonPayloadBuffer.byteLength);
        offset += 4;
        result.set(jsonPayloadBuffer, offset);
        offset += jsonPayloadBuffer.byteLength;
      } else {
        view.setUint32(offset, 0);
        offset += 4;
      }
      if (messageInfo.controlMessagePayload.binaryPortion) {
        result.set(messageInfo.controlMessagePayload.binaryPortion, offset);
        offset += messageInfo.controlMessagePayload.binaryPortion.byteLength;
      }
    }
    if (messageInfo.rawPayload) {
      result.set(messageInfo.rawPayload, offset);
    }
    return result;
  }

  static parseChannelMessage(message: Uint8Array): ParsedMessageInfo {
    const result: ParsedMessageInfo = {
      rawMessage: message,
      valid: false
    };
    if (message.length < this.MESSAGE_HEADER_LENGTH) {
      result.errorMessage = 'Message is too short';
      return result;
    }
    result.valid = true;
    result.info = {};
    const view = new DataView(message.buffer, message.byteOffset);
    const topBytes = view.getUint16(0);
    const bottomBytes = view.getUint32(2);
    result.info.timestamp = topBytes * Math.pow(2, 32) + bottomBytes;
    const delta = Date.now() - result.info.timestamp;
    if (Math.abs(delta) > 15000) {
      result.valid = false;
      result.errorMessage = "Clocks are too far out of sync, or message timestamp is invalid";
      return result;
    }
    result.info.channelCode = view.getUint32(6);
    result.info.senderCode = view.getUint32(10);
    const behavior = view.getUint8(14);
    result.info.priority = (behavior & 0x01) ? true : false;
    result.info.history = (behavior & 0x02) ? true : false;
    result.info.rawPayload = new Uint8Array(message.buffer, message.byteOffset + this.MESSAGE_HEADER_LENGTH, message.byteLength - this.MESSAGE_HEADER_LENGTH);
    if (result.info.channelCode === 0 && result.info.senderCode === 0) {
      const jsonLength = view.getUint32(this.MESSAGE_HEADER_LENGTH);
      try {
        const jsonString = new TextDecoder("utf-8").decode(message.subarray(this.MESSAGE_HEADER_LENGTH + 4, this.MESSAGE_HEADER_LENGTH + 4 + jsonLength));
        result.info.controlMessagePayload = {
          jsonMessage: JSON.parse(jsonString)
        };
        if (message.byteLength > this.MESSAGE_HEADER_LENGTH + 4 + jsonLength) {
          result.info.controlMessagePayload.binaryPortion = new Uint8Array(message.buffer, message.byteOffset + this.MESSAGE_HEADER_LENGTH + 4 + jsonLength);
        }
      } catch (err) {
        result.valid = false;
        result.errorMessage = "Invalid control message payload";
      }
    }
    return result;
  }

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
