import * as express from "express";
import { Express, Request, Response } from 'express';
import { configuration } from '../configuration';
import { client as WebSocketClient, connection, IMessage } from 'websocket';
import { TextDecoder, TextEncoder } from 'text-encoding';
import * as url from "url";
import { ChannelShareCodeResponse, ChannelShareResponse, ChannelsListResponse, ChannelCreateResponse, ChannelAcceptResponse, ChannelGetResponse, ChannelCreateDetails, ChannelShareDetails, ChannelsListDetails, ChannelAcceptDetails, ChannelGetDetails, ChannelDeleteDetails } from "channels-common";
import { JoinResponseDetails, ControlChannelMessage, JoinRequestDetails, HistoryRequestDetails, LeaveRequestDetails } from "channels-common";
import { ChannelMessage, ChannelMessageUtils, MessageToSerialize } from "channels-common";
import { ChannelContractDetails, ChannelInformation, MemberContractDetails } from "channels-common";
import { AddressIdentity, ChannelIdentityUtils, KeyIdentity, SignedAddressIdentity, SignedKeyIdentity, UpdateSwitchRegistrationDetails, UpdateSwitchRegistrationResponse, BankServiceRequest, BankTransferDetails, BankTransferResponse, BankGetAccountDetails, BankGetAccountResponse, BankRegisterUserResponse, BankServiceDescription, SwitchingServiceRequest, BankRegisterUserDetails, SwitchServiceDescription, MemberIdentityInfo, CardRegistryServiceDescription, CardRegistryRegisterUserDetails, CardRegistryServiceRequest, CardRegistryRegisterUserResponse, CardRegistrySearchDetails, CardRegistrySearchResponse } from "channels-common";
import { Utils } from "../utils";
import { ServiceDescription, ServiceEndpoints } from "channels-common/bin/channels-common";
import { channelsRestClient } from "channels-rest-client";
const RestClient = require('node-rest-client').Client;
const basic = require('basic-authorization-header');

const SWITCH_PROTOCOL_VERSION = 1;
const BANK_PROTOCOL_VERSION = 1;
const CARD_REGISTRY_PROTOCOL_VERSION = 1;

interface PostArgs {
  data: any;
  headers: { [name: string]: string };
}
interface RestArgs {
  headers: { [name: string]: string };
}
interface IRestClient {
  get(url: string, callback: (data: any, response: Response) => void): void;

  get(url: string, args: RestArgs, callback: (data: any, response: Response) => void): void;
  post(url: string, args: PostArgs, callback: (data: any, response: Response) => void): void;
  delete(url: string, args: RestArgs, callback: (data: any, response: Response) => void): void;
}

class TestClient {
  id: string;
  signedAddress: SignedAddressIdentity;
  signedIdentity: SignedKeyIdentity;
  socket?: WebSocketClient;
  conn?: connection;
  switchDescription?: SwitchServiceDescription;
  channelResponse?: ChannelInformation;
  channelListResponse?: ChannelsListResponse;
  requestIndex = 1;
  shareResponse?: ChannelShareResponse;
  shareCodeResponse?: ChannelShareCodeResponse;
  joinResponseDetails?: JoinResponseDetails;
  switchRegistration?: UpdateSwitchRegistrationResponse;
  privateKey: Uint8Array;
  bankDescription: BankServiceDescription;
  bankAccountResponse: BankRegisterUserResponse;
  cardRegistryDescription: CardRegistryServiceDescription;
  cardRegistryRegisterUserResponse: CardRegistryRegisterUserResponse;
  cardRegistrySearchResponse: CardRegistrySearchResponse;

  constructor(name: string) {
    this.privateKey = ChannelIdentityUtils.generatePrivateKey();
    const keyInfo = ChannelIdentityUtils.getKeyInfo(this.privateKey);
    this.signedIdentity = ChannelIdentityUtils.createSignedKeyIdentity(keyInfo);
    this.signedAddress = ChannelIdentityUtils.createSignedAddressIdentity(keyInfo);
  }
  private requestHandlersById: { [requestId: string]: (controlMessage: ControlChannelMessage) => Promise<void> } = {};
  async handleMessage(messageInfo: ChannelMessage): Promise<void> {
    let handled = false;
    if (messageInfo.channelCode === 0 && messageInfo.senderCode === 0 && messageInfo.controlMessagePayload) {
      const controlMessage = messageInfo.controlMessagePayload.jsonMessage as ControlChannelMessage;
      if (controlMessage.type === 'ping') {
        const byteArray = ChannelMessageUtils.serializeControlMessage(controlMessage.requestId, 'ping-reply', {});
        console.log("---------------------------------");
        console.log(JSON.stringify(controlMessage, null, 2));
        console.log("---------------------------------");
        console.log(JSON.stringify(ChannelMessageUtils.createControlMessage(controlMessage.requestId, 'ping-reply', {}), null, 2));
        console.log("---------------------------------");
        this.conn.sendBytes(new Buffer(byteArray));
        handled = true;
      } else if (controlMessage.requestId) {
        const handler = this.requestHandlersById[controlMessage.requestId];
        if (handler) {
          await handler(controlMessage);
          handled = true;
        }
      } else if (controlMessage.type === 'history-message') {
        console.log("History-message", JSON.stringify(messageInfo));
        // const decodedHistoryMessage = ChannelMessageUtils.parseChannelMessage(messageInfo.controlMessagePayload.binaryPortion, false);
        // console.log("--------------------------------- History -------");
        // console.log(JSON.stringify(decodedHistoryMessage, null, 2));
        // console.log("---------------------------------");
      }
    }
    if (!handled) {
      if (messageInfo.controlMessagePayload) {
        console.log("TestClient: Control Message Received", this.id, messageInfo.timestamp, JSON.stringify(messageInfo.controlMessagePayload.jsonMessage));
        console.log("---------------------------------");
        console.log(JSON.stringify(messageInfo.controlMessagePayload.jsonMessage, null, 2));
        console.log("---------------------------------");
      } else {
        const payloadString = new TextDecoder('utf-8').decode(messageInfo.fullPayload);
        console.log("TestClient: Channel Message Received", this.id, messageInfo.channelCode, messageInfo.senderCode, messageInfo.timestamp, payloadString);
      }
    }
  }

  registerReplyHandler(requestId: string, callback: (controlMessage: ControlChannelMessage) => Promise<void>): void {
    this.requestHandlersById[requestId] = callback;
  }
}

export class ClientTester {
  private restClient = new RestClient() as IRestClient;

  private clientsById: { [id: string]: TestClient } = {};

  initialize(app: express.Application) {
    app.get('/d/test/createClient', (request: Request, response: Response) => {
      void this.handleCreateClientWithChannel(request, response);
    });
    app.get('/d/test/createClientFromShare', (request: Request, response: Response) => {
      void this.handleCreateClientFromShare(request, response);
    });
    app.get('/d/test/join', (request: Request, response: Response) => {
      void this.handleJoin(request, response);
    });
    app.get('/d/test/send', (request: Request, response: Response) => {
      void this.handleSend(request, response);
    });
    app.get('/d/test/leave', (request: Request, response: Response) => {
      void this.handleLeave(request, response);
    });
    app.get('/d/test/delete', (request: Request, response: Response) => {
      void this.handleDelete(request, response);
    });
    app.get('/d/test/bankTransfer', (request: Request, response: Response) => {
      void this.handleBankTransfer(request, response);
    });
    app.get('/d/test/bankAccount', (request: Request, response: Response) => {
      void this.handleGetBankAccount(request, response);
    });
    app.get('/d/test/cardRegistry', (request: Request, response: Response) => {
      void this.handleCardRegistry(request, response);
    });
  }

  private async handleCreateClientWithChannel(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const name = request.query.name || 'unnamed';
    const channelName = request.query.channel;
    const phone = request.query.phone;
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = new TestClient(name);
    this.clientsById[id] = client;
    await this.getBankProvider(client);
    await this.registerWithBank(client);
    await this.getSwitchProvider(client, configuration.get('baseClientUri'));
    await this.registerWithSwitch(client, phone);
    await this.createChannel(client, name, channelName);
    await this.shareChannel(client, name);
    await this.listChannels(client);
    response.end();
  }

  private async handleCreateClientFromShare(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const name = request.query.name || 'unnamed';
    const phone = request.query.phone;
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const from = request.query.from;
    if (!from) {
      response.status(400).send("Missing from param");
      return;
    }
    const client = new TestClient(name);
    this.clientsById[id] = client;
    await this.getBankProvider(client);
    await this.registerWithBank(client);
    await this.getShare(client, from);
    await this.getSwitchProvider(client, client.shareCodeResponse.serviceEndpoints.descriptionUrl);
    await this.registerWithSwitch(client, phone);
    await this.accept(client, name);
    await this.listChannels(client);
    await this.getChannel(client, client.channelResponse.channelAddress);
    response.end();
  }

  private async handleJoin(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    await this.openSocket(client);
    await this.joinChannel(client);
    await this.requestHistory(client);
    await this.send(client, "This is just after channel creation.");
    response.end();
  }

  private async handleSend(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const text = request.query.text || 'default text';
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    await this.send(client, text);
    response.end();
  }

  private async handleLeave(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const permanently = request.query.permanently === 'true' ? true : false;
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    await this.leaveChannel(client, permanently);
    response.end();
  }

  private async handleDelete(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    await this.deleteChannel(client);
    response.end();
  }

  private async getSwitchProvider(client: TestClient, url: string): Promise<void> {
    client.switchDescription = await channelsRestClient.getSwitchDescription(url);
  }

  private async registerWithSwitch(client: TestClient, phoneNumber: string): Promise<void> {
    const details: UpdateSwitchRegistrationDetails = {
      timezone: 'America/Los_Angeles',
      notifications: {
        smsNumber: phoneNumber,
        smsNotificationCallbackUrlTemplate: "http://localhost:31112/channel/{{channel}}",
        timing: {
          noNotificationDays: [],
          notBeforeMinutes: 60 * 8,
          notAfterMinutes: 60 * 21
        }
      }
    };
    client.switchRegistration = await channelsRestClient.registerSwitchUser(client.switchDescription.serviceEndpoints.restServiceUrl, client.signedIdentity, details);
  }

  private async createChannel(client: TestClient, name: string, channelName: string): Promise<void> {
    const contract: ChannelContractDetails = {
      package: "https://github.com/ChannelsTeam/contract-standard",
      serviceContract: {
        options: {
          history: true,
          topology: 'many-to-many'
        },
        channelPricing: {
          perMessageSent: 0,
          perMessageDelivered: 0,
          perMessageStored: 0
        }
      },
      participationContract: {
        type: "https://channelelements.com/contracts/participation/standard",
        cards: {
          "*": { price: 0 }
        }
      }
    };
    const memberContract: MemberContractDetails = {
      subscribe: true
    };
    const memberIdentity: MemberIdentityInfo = {
      name: name
    };
    const details: ChannelCreateDetails = {
      channelContract: contract,
      memberIdentity: memberIdentity,
      memberContract: memberContract
    };
    if (channelName) {
      details.name = channelName;
    }
    client.channelResponse = await channelsRestClient.switchCreateChannel(client.switchDescription.serviceEndpoints.restServiceUrl, client.signedAddress, details);
  }

  private async openSocket(client: TestClient): Promise<void> {
    client.socket = new WebSocketClient();
    return new Promise<void>((resolve, reject) => {
      client.socket.on('connect', (conn: connection) => {
        client.conn = conn;
        conn.on('error', (error: any) => {
          console.log("TestClient: Connection Error: " + error.toString());
        });
        conn.on('close', () => {
          console.log('TestClient: Connection Closed');
        });
        conn.on('message', (message: IMessage) => {
          if (message.type === 'binary') {
            const messageInfo = ChannelMessageUtils.parseChannelMessage(message.binaryData);
            if (messageInfo.valid) {
              void client.handleMessage(messageInfo.contents);
            } else {
              console.error("TestClient: Received invalid message: " + messageInfo.errorMessage);
            }
          } else {
            console.error('TestClient: Unexpected string-type channel message', message);
          }
        });
        resolve();
      });

      const headers: any = {}; // { Authorization: basic(client.registrationResponse.id, client.registrationResponse.token) };
      client.socket.connect(client.channelResponse.transportUrl, null, null, headers);
    });
  }

  private async joinChannel(client: TestClient): Promise<void> {
    const details: JoinRequestDetails = {
      channelAddress: client.channelResponse.channelAddress,
      memberIdentity: client.signedAddress,
      participantIdentityDetails: {}
    };
    const requestId = client.requestIndex.toString();
    client.requestIndex++;
    const byteArray = ChannelMessageUtils.serializeControlMessage(requestId, 'join', details);
    client.conn.sendBytes(new Buffer(byteArray));
    return new Promise<void>((resolve, reject) => {
      client.registerReplyHandler(requestId, (controlMessage: ControlChannelMessage): Promise<void> => {
        return new Promise<void>((innerResolve, innerReject) => {
          client.joinResponseDetails = controlMessage.details as JoinResponseDetails;
          innerResolve();
          // console.log("---------------------------------");
          // console.log(JSON.stringify(ChannelMessageUtils.createControlMessage(requestId, 'join', details), null, 2));
          // console.log("---------------------------------");
          // console.log(JSON.stringify(controlMessage, null, 2));
          // console.log("---------------------------------");
          resolve();
        });
      });
    });
  }

  private async requestHistory(client: TestClient): Promise<void> {
    const details: HistoryRequestDetails = {
      channelAddress: client.channelResponse.channelAddress,
      before: Date.now(),
      maxCount: 10
    };
    const requestId = client.requestIndex.toString();
    client.requestIndex++;
    const byteArray = ChannelMessageUtils.serializeControlMessage(requestId, 'history', details);
    client.conn.sendBytes(new Buffer(byteArray));
    return new Promise<void>((resolve, reject) => {
      client.registerReplyHandler(requestId, (controlMessage: ControlChannelMessage): Promise<void> => {
        return new Promise<void>((innerResolve, innerReject) => {
          console.log("TestClient: history reply", JSON.stringify(controlMessage.details));
          innerResolve();
          // console.log("---------------------------------");
          // console.log(JSON.stringify(ChannelMessageUtils.createControlMessage(requestId, 'history', details), null, 2));
          // console.log("---------------------------------");
          // console.log(JSON.stringify(controlMessage, null, 2));
          // console.log("---------------------------------");
          resolve();
        });
      });
    });
  }

  private async shareChannel(client: TestClient, name: string): Promise<void> {
    const details: ChannelShareDetails = {
      channel: client.channelResponse.channelAddress,
      shareExtensions: { name: name, sharing: true }
    };
    client.shareResponse = await channelsRestClient.switchShareChannel(client.switchDescription.serviceEndpoints.restServiceUrl, client.signedAddress, details);
  }

  private async getShare(client: TestClient, from: string): Promise<void> {
    const shareResponse = this.clientsById[from].shareResponse;
    client.shareCodeResponse = await channelsRestClient.switchGetInvitationFromShareCode(shareResponse.shareCodeUrl);
  }

  private async accept(client: TestClient, name: string): Promise<void> {
    const memberContract: MemberContractDetails = {
      subscribe: true
    };
    const details: ChannelAcceptDetails = {
      invitationId: client.shareCodeResponse.invitationId,
      memberIdentity: { name: name },
      memberContract: memberContract
    };
    client.channelResponse = await channelsRestClient.switchAcceptChannel(client.switchDescription.serviceEndpoints.restServiceUrl, client.signedAddress, details);
  }

  private async getChannel(client: TestClient, channel: string): Promise<void> {
    const details: ChannelGetDetails = {
      channel: channel
    };
    client.channelResponse = await channelsRestClient.switchGetChannel(client.switchDescription.serviceEndpoints.restServiceUrl, client.signedAddress, details);
  }

  private async listChannels(client: TestClient): Promise<void> {
    const details: ChannelsListDetails = {};
    client.channelListResponse = await channelsRestClient.switchListChannels(client.switchDescription.serviceEndpoints.restServiceUrl, client.signedAddress, details);
  }

  private async send(client: TestClient, text: string): Promise<void> {
    const messageInfo: MessageToSerialize = {
      channelCode: client.joinResponseDetails.channelCode,
      senderCode: client.joinResponseDetails.participantCode,
      history: true,
      priority: false,
      binaryPayload: new TextEncoder().encode(JSON.stringify({ text: text }))
    };
    const byteArray = ChannelMessageUtils.serializeChannelMessage(messageInfo, 0, 0);
    client.conn.sendBytes(new Buffer(byteArray));
  }

  private leaveChannel(client: TestClient, permanently: boolean): Promise<void> {
    const details: LeaveRequestDetails = {
      channelAddress: client.channelResponse.channelAddress,
      permanently: permanently
    };
    const requestId = client.requestIndex.toString();
    client.requestIndex++;
    const byteArray = ChannelMessageUtils.serializeControlMessage(requestId, 'leave', details);
    client.conn.sendBytes(new Buffer(byteArray));
    return new Promise<void>((resolve, reject) => {
      client.registerReplyHandler(requestId, (controlMessage: ControlChannelMessage): Promise<void> => {
        return new Promise<void>((innerResolve, innerReject) => {
          delete client.joinResponseDetails;
          console.log("TestClient: Leave completed: " + permanently);
          innerResolve();
          // console.log("---------------------------------");
          // console.log(JSON.stringify(ChannelMessageUtils.createControlMessage(requestId, 'leave', details), null, 2));
          // console.log("---------------------------------");
          // console.log(JSON.stringify(controlMessage, null, 2));
          // console.log("---------------------------------");
          resolve();
        });
      });
    });
  }

  private async deleteChannel(client: TestClient): Promise<void> {
    const details: ChannelDeleteDetails = {
      channel: client.channelResponse.channelAddress
    };
    await channelsRestClient.switchDeleteChannel(client.switchDescription.serviceEndpoints.restServiceUrl, client.signedAddress, details);
  }

  private async handleBankOpen(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    await this.getBankProvider(client);
    await this.registerWithBank(client);
    response.end();
  }

  private async handleGetBankAccount(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    await this.getBankAccount(client);
    response.end();
  }

  private async handleBankTransfer(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const toId = request.query.toId;
    if (!id || !toId) {
      response.status(400).send("Missing id and/or toId params");
      return;
    }
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    const toClient = this.clientsById[toId];
    if (!toClient) {
      response.status(404).send("No such to client");
      return;
    }
    const amount = request.query.amount ? Number(request.query.amount) : 1;
    await this.transfer(client, toClient, amount, request.query.reference);
    response.end();
  }

  private async getBankProvider(client: TestClient): Promise<void> {
    client.bankDescription = await channelsRestClient.getBankDescription(configuration.get('baseClientUri'));
  }

  private async registerWithBank(client: TestClient): Promise<void> {
    client.bankAccountResponse = await channelsRestClient.registerBankUser(client.bankDescription.serviceEndpoints.restServiceUrl, client.signedIdentity);
  }

  private async getBankAccount(client: TestClient): Promise<void> {
    client.bankAccountResponse = await channelsRestClient.bankGetAccount(client.bankDescription.serviceEndpoints.restServiceUrl, client.signedAddress);
  }

  private async transfer(client: TestClient, toClient: TestClient, amount: number, reference: string): Promise<void> {
    const details: BankTransferDetails = {
      amount: amount,
      to: {
        bankUrl: toClient.bankDescription.serviceEndpoints.descriptionUrl,
        accountAddress: toClient.signedAddress.address
      },
      requestReference: reference
    };
    await channelsRestClient.bankTransfer(client.bankDescription.serviceEndpoints.restServiceUrl, client.signedAddress, details);
  }

  private async handleCardRegistry(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const search = request.query.search;
    const category = request.query.category;
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    await this.getCardRegistryProvider(client);
    await this.registerWithCardRegistry(client);
    await this.searchCardRegistry(client, search, category);
    response.end();
  }

  private async getCardRegistryProvider(client: TestClient): Promise<void> {
    client.cardRegistryDescription = await channelsRestClient.getCardRegistryDescription(configuration.get('baseClientUri'));
  }

  private async registerWithCardRegistry(client: TestClient): Promise<void> {
    client.cardRegistryRegisterUserResponse = await channelsRestClient.registerCardRegistryUser(client.cardRegistryDescription.serviceEndpoints.restServiceUrl, client.signedIdentity);
  }

  private async searchCardRegistry(client: TestClient, search: string, category: string): Promise<void> {
    const details: CardRegistrySearchDetails = {
      searchString: search,
      categoriesFilter: category
    };
    client.cardRegistrySearchResponse = await channelsRestClient.cardRegistrySearch(client.cardRegistryDescription.serviceEndpoints.restServiceUrl, client.signedAddress, details);
  }

}

const clientTester = new ClientTester();

export { clientTester };
