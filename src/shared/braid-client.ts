import * as rest from 'rest-js';

import { RegistrationResponse, ControlChannelMessage, ChannelParticipantInfo } from "../interfaces/channel-server-interfaces";

export interface BraidServiceProviderConfiguration {
  registrationUrl: string;
  registrationResponse?: RegistrationResponse;
  createdChannelIds?: string[];
  otherChannelIds?: string[];
}

export interface BraidClientConfiguration {
  userIdentity: any;
  serviceProvidersByUrl: { [url: string]: BraidServiceProviderConfiguration };
}

export interface BraidChannelInfo {
  channelId: string;
  channelCode: number;
  senderCode: number;
  clockOffset: number;
  joinStatusCode?: number;
  joinErrorMessage?: string;
  identity?: any;
  participants: ChannelParticipantInfo[];

}

export interface BraidServiceProvider {
  configuration: BraidServiceProviderConfiguration;
  status: string;
  channels: BraidChannelInfo[];
}

export interface BraidClientEventHandler {

}

interface SocketInfo {

}

export class BraidClient {
  private configuration: BraidClientConfiguration;
  private providersByUrl: { [url: string]: BraidServiceProvider } = {};
  private socketsByChannelId: { [channelId: string]: SocketInfo } = {};

  constructor(configuration: BraidClientConfiguration, eventHandler: BraidClientEventHandler) {
    this.configuration = configuration;
  }

  async start(): Promise<void> {
    // noop
  }

  async register(registrationUrl: string): Promise<RegistrationResponse> {
    const config: BraidServiceProviderConfiguration = {
      registrationUrl: registrationUrl
    };
    const restClient = rest(registrationUrl, { defaultFormat: 'json', defaultDataType: 'json' });
    config.registrationResponse = await restClient.request('get', '', null) as RegistrationResponse;
    const provider: BraidServiceProvider = {
      configuration: config,
      status: 'pending',
      channels: []
    };
    this.configuration.serviceProvidersByUrl[registrationUrl] = config;
    this.providersByUrl[registrationUrl] = provider;
    return config.registrationResponse;
  }

  private async openSocket(registrationUrl: string): Promise<void> {
    // noop
  }

  async createAndJoinChannel(providerRegistrationUrl: string, channelManifest: any): Promise<BraidChannelInfo> {
    return null;
  }

  async joinSharedChannel(sharingUrl: string, identity: any): Promise<BraidChannelInfo> {
    return null;
  }

}
