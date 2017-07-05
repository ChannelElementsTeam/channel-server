import * as express from "express";
import { Express, Request, Response } from 'express';
import { configuration } from '../configuration';
import { client as WebSocketClient, connection, IMessage } from 'websocket';
import { TextDecoder, TextEncoder } from 'text-encoding';
import * as url from "url";
import { ChannelShareCodeResponse, ChannelShareResponse, ChannelsListResponse, ChannelCreateResponse, ChannelServiceDescription, ChannelAcceptResponse, ChannelGetResponse, ChannelCreateDetails, ChannelShareDetails, ChannelServiceRequest, ProviderServiceEndpoints, ChannelsListDetails, ChannelAcceptDetails, ChannelGetDetails, ChannelDeleteDetails } from "channels-common";
import { JoinResponseDetails, ControlChannelMessage, JoinRequestDetails, HistoryRequestDetails, LeaveRequestDetails } from "channels-common";
import { ChannelMessage, ChannelMessageUtils, MessageToSerialize } from "channels-common";
import { ChannelContractDetails, ChannelInformation, MemberContractDetails } from "channels-common";
import { AddressIdentity, FullIdentity, ChannelIdentityUtils, KeyIdentity, SignedAddressIdentity, SignedKeyIdentity, UpdateRegistrationDetails, UpdateRegistrationResponse, ChannelBankDescription, BankServiceRequest, BankOpenAccountDetails, BankOpenAccountResponse, BankTransferDetails, BankTransferResponse, BankGetAccountDetails, BankGetAccountResponse } from "channels-common";
import { Utils } from "../utils";
const RestClient = require('node-rest-client').Client;
const basic = require('basic-authorization-header');

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
  serviceEndpoints: ProviderServiceEndpoints;
  socket?: WebSocketClient;
  conn?: connection;
  providerResponse?: ChannelServiceDescription;
  channelResponse?: ChannelInformation;
  channelListResponse?: ChannelsListResponse;
  requestIndex = 1;
  shareResponse?: ChannelShareResponse;
  shareCodeResponse?: ChannelShareCodeResponse;
  joinResponseDetails?: JoinResponseDetails;
  registration?: UpdateRegistrationResponse;
  privateKey: Uint8Array;
  bankResponse: ChannelBankDescription;
  bankAccountResponse: BankOpenAccountResponse;

  constructor(name: string) {
    this.privateKey = ChannelIdentityUtils.generatePrivateKey();
    const keyInfo = ChannelIdentityUtils.getKeyInfo(this.privateKey);
    this.signedIdentity = ChannelIdentityUtils.createSignedFullIdentity(keyInfo, name, "https://example.org/pictures/" + name + ".png", "https://example.org/i/" + Utils.createToken(6), {});
    this.signedAddress = ChannelIdentityUtils.createSignedAddressIdentity(keyInfo, keyInfo.address);
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
        // console.log("---------------------------------");
        // console.log(JSON.stringify(controlMessage, null, 2));
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
    app.get('/d/test/register', (request: Request, response: Response) => {
      void this.handleRegister(request, response);
    });
    app.get('/d/test/bankOpen', (request: Request, response: Response) => {
      void this.handleBankOpen(request, response);
    });
    app.get('/d/test/bankTransfer', (request: Request, response: Response) => {
      void this.handleBankTransfer(request, response);
    });
    app.get('/d/test/bankAccount', (request: Request, response: Response) => {
      void this.handleGetBankAccount(request, response);
    });
  }

  private async handleCreateClientWithChannel(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const name = request.query.name || 'unnamed';
    const channelName = request.query.channel;
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = new TestClient(name);
    this.clientsById[id] = client;
    await this.getProvider(client);
    await this.createChannel(client, name, channelName);
    await this.shareChannel(client, name);
    await this.listChannels(client);
    response.end();
  }

  private async handleCreateClientFromShare(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const name = request.query.name || 'unnamed';
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
    await this.getShare(client, from);
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

  private async handleRegister(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const phone = request.query.phone;
    if (!id || !phone) {
      response.status(400).send("Missing id and/or phone param");
      return;
    }
    if (!Utils.isPhoneNumber(phone)) {
      response.status(400).send("Phone param doesn't look like a phone number");
      return;
    }
    const client = this.clientsById[id];
    if (!client) {
      response.status(404).send("No such client");
      return;
    }
    await this.register(client, Utils.cleanPhoneNumber(phone));
    response.end();
  }

  private async register(client: TestClient, phoneNumber: string): Promise<void> {
    const details: UpdateRegistrationDetails = {
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
    const request: ChannelServiceRequest<SignedKeyIdentity, UpdateRegistrationDetails> = {
      type: 'update-registration',
      identity: client.signedIdentity,
      details: details
    };
    const args: PostArgs = {
      data: request,
      headers: {
        "Content-Type": "application/json"
      }
    };
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(client.serviceEndpoints.restServiceUrl, args, (data: any, createResponse: Response) => {
        if (createResponse.statusCode === 200) {
          console.log("TestClient: Registration updated", JSON.stringify(data));
          client.registration = data as UpdateRegistrationResponse;
          resolve();
        } else {
          console.log("TestClient: Failed", createResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject(createResponse.statusCode);
        }
      });
    });
  }

  private async getProvider(client: TestClient): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const providerUrl = url.resolve(configuration.get('baseClientUri'), '/channel-elements.json');

      this.restClient.get(providerUrl, (data: any, providerResponse: Response) => {
        if (providerResponse.statusCode === 200) {
          console.log("TestClient: provider information", JSON.stringify(data));
          client.providerResponse = data as ChannelServiceDescription;
          client.serviceEndpoints = client.providerResponse.serviceEndpoints;
          resolve();
        } else {
          console.error("Failed", providerResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Get provider failed");
        }
      });
    });

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
        },
        extensions: {}
      },
      participationContract: {
        type: "https://channelelements.com/contracts/participation/standard",
        cards: {
          "*": { price: 0 }
        },
        extensions: {}
      }
    };
    const memberContract: MemberContractDetails = {
      subscribe: true
    };
    const details: ChannelCreateDetails = {
      channelContract: contract,
      memberContract: memberContract
    };
    if (channelName) {
      details.name = channelName;
    }
    const request: ChannelServiceRequest<SignedKeyIdentity, ChannelCreateDetails> = {
      type: 'create',
      identity: client.signedIdentity,
      details: details
    };
    const args: PostArgs = {
      data: request,
      headers: {
        "Content-Type": "application/json"
      }
    };
    console.log("TestClient: Creating channel...");
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(client.serviceEndpoints.restServiceUrl, args, (data: any, createResponse: Response) => {
        if (createResponse.statusCode === 200) {
          console.log("TestClient: Channel created", JSON.stringify(data));
          client.channelResponse = data as ChannelCreateResponse;
          console.log("TestClient: channel list reply", JSON.stringify(client.channelResponse));
          // console.log("Create Channel Request --------------------------------------------------------------------------");
          // console.log(JSON.stringify(request, null, 2));
          // console.log("Create Channel Response --------------------------------------------------------------------------");
          // console.log(JSON.stringify(data, null, 2));
          // console.log("Create Channel --------------------------------------------------------------------------");
          resolve();
        } else {
          console.log("TestClient: Failed", createResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject(createResponse.statusCode);
        }
      });
    });
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
      extensions: { name: name, sharing: true }
    };
    const shareRequest: ChannelServiceRequest<SignedAddressIdentity, ChannelShareDetails> = {
      type: 'share',
      identity: client.signedAddress,
      details: details
    };
    const args: PostArgs = {
      data: shareRequest,
      headers: {
        "Content-Type": "application/json"
      }
    };
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(client.serviceEndpoints.restServiceUrl, args, (data: any, shareResponse: Response) => {
        if (shareResponse.statusCode === 200) {
          console.log("TestClient: Share code created", JSON.stringify(data));
          client.shareResponse = data as ChannelShareResponse;
          // console.log("______________________");
          // console.log(JSON.stringify(shareRequest, null, 2));
          // console.log("______________________");
          // console.log(JSON.stringify(data, null, 2));
          // console.log("______________________");
          resolve();
        } else {
          console.error("Failed", shareResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Share failed");
        }
      });
    });
  }

  private async getShare(client: TestClient, from: string): Promise<void> {
    const shareResponse = this.clientsById[from].shareResponse;
    return new Promise<void>((resolve, reject) => {
      const args: RestArgs = {
        headers: {
          'Accept': 'application/json'
        }
      };
      this.restClient.get(shareResponse.shareCodeUrl, args, (data: any, shareCodeResponse: Response) => {
        if (shareCodeResponse.statusCode === 200) {
          console.log("TestClient: Share code fetched", JSON.stringify(data));
          client.shareCodeResponse = data as ChannelShareCodeResponse;
          client.serviceEndpoints = client.shareCodeResponse.serviceEndpoints;
          resolve();
        } else {
          console.warn("Failed", shareCodeResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Failed to Get share code");
        }
      });
    });
  }

  private async accept(client: TestClient, name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const memberContract: MemberContractDetails = {
        subscribe: true
      };
      const details: ChannelAcceptDetails = {
        invitationId: client.shareCodeResponse.invitationId,
        memberContract: memberContract
      };
      const request: ChannelServiceRequest<SignedKeyIdentity, ChannelAcceptDetails> = {
        identity: client.signedIdentity,
        type: 'accept',
        details: details
      };
      const args: PostArgs = {
        data: request,
        headers: {
          "Content-Type": "application/json"
        }
      };
      this.restClient.post(client.serviceEndpoints.restServiceUrl, args, (data: any, acceptResponse: Response) => {
        if (acceptResponse.statusCode === 200) {
          console.log("TestClient: Share code fetched", JSON.stringify(data));
          client.channelResponse = data as ChannelAcceptResponse;
          resolve();
        } else {
          console.warn("Failed", acceptResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Failed to accept");
        }
      });
    });
  }

  private async getChannel(client: TestClient, channel: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const details: ChannelGetDetails = {
        channel: channel
      };
      const request: ChannelServiceRequest<SignedAddressIdentity, ChannelGetDetails> = {
        type: 'get',
        identity: client.signedAddress,
        details: details
      };
      const args: PostArgs = {
        data: request,
        headers: {
          "Content-Type": "application/json"
        }
      };
      this.restClient.post(client.serviceEndpoints.restServiceUrl, args, (data: any, channelResponse: Response) => {
        if (channelResponse.statusCode === 200) {
          client.channelResponse = data as ChannelGetResponse;
          console.log("TestClient: Channel fetched", JSON.stringify(data));
          // console.log("______________________");
          // console.log(JSON.stringify(request, null, 2));
          // console.log("______________________");
          // console.log(JSON.stringify(data, null, 2));
          // console.log("______________________");
          resolve();
        } else {
          console.error("Failed", channelResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Get channel failed");
        }
      });
    });
  }

  private async listChannels(client: TestClient): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const details: ChannelsListDetails = {};
      const request: ChannelServiceRequest<SignedAddressIdentity, ChannelsListDetails> = {
        type: 'list',
        identity: client.signedAddress,
        details: details
      };
      const args: PostArgs = {
        data: request,
        headers: {
          "Content-Type": "application/json"
        }
      };
      this.restClient.post(client.serviceEndpoints.restServiceUrl, args, (data: any, channelListResponse: Response) => {
        if (channelListResponse.statusCode === 200) {
          client.channelListResponse = data as ChannelsListResponse;
          console.log("TestClient: Channel list fetched", JSON.stringify(data));
          // console.log("______________________");
          // console.log(JSON.stringify(request, null, 2));
          // console.log("______________________");
          // console.log(JSON.stringify(data, null, 2));
          // console.log("______________________");
          resolve();
        } else {
          console.error("Failed", channelListResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("List channels failed");
        }
      });
    });
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

  private deleteChannel(client: TestClient): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const details: ChannelDeleteDetails = {
        channel: client.channelResponse.channelAddress
      };
      const request: ChannelServiceRequest<SignedAddressIdentity, ChannelDeleteDetails> = {
        type: 'delete',
        identity: client.signedAddress,
        details: details
      };
      const args: PostArgs = {
        data: request,
        headers: {
          "Content-Type": "application/json"
        }
      };
      this.restClient.post(client.serviceEndpoints.restServiceUrl, args, (data: any, deleteResponse: Response) => {
        if (deleteResponse.statusCode === 200) {
          console.log("TestClient: Channel deleted", JSON.stringify(data));
          // console.log("______________________");
          // console.log(JSON.stringify(request, null, 2));
          // console.log("______________________");
          // console.log(JSON.stringify(data, null, 2));
          // console.log("______________________");

          resolve();
        } else {
          console.error("Failed", deleteResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Delete channel failed");
        }
      });
    });
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
    await this.fetchBank(client);
    await this.openBankAccount(client);
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

  private async fetchBank(client: TestClient): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const bankUrl = url.resolve(configuration.get('baseClientUri'), '/channel-bank.json');
      this.restClient.get(bankUrl, (data: any, bankResponse: Response) => {
        if (bankResponse.statusCode === 200) {
          console.log("TestClient: bank information", JSON.stringify(data));
          client.bankResponse = data as ChannelBankDescription;
          console.log("Bank Description Response --------------------------------------------------------------------------");
          console.log(JSON.stringify(client.bankResponse, null, 2));
          console.log("Bank Description Response --------------------------------------------------------------------------");
          resolve();
        } else {
          console.error("Failed", bankResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Get bank failed");
        }
      });
    });
  }

  private async openBankAccount(client: TestClient): Promise<void> {
    const details: BankOpenAccountDetails = {};
    const request: BankServiceRequest<SignedKeyIdentity, BankOpenAccountDetails> = {
      type: 'open-account',
      identity: client.signedIdentity,
      details: details
    };
    const args: PostArgs = {
      data: request,
      headers: {
        "Content-Type": "application/json"
      }
    };
    console.log("TestClient: Opening bank account...");
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(client.bankResponse.serviceEndpoints.restServiceUrl, args, (data: any, openAccountResponse: Response) => {
        if (openAccountResponse.statusCode === 200) {
          client.bankAccountResponse = data as BankOpenAccountResponse;
          console.log("TestClient: account opened", JSON.stringify(client.bankAccountResponse));
          console.log("Open Account Request --------------------------------------------------------------------------");
          console.log(JSON.stringify(request, null, 2));
          console.log("Open Account Response --------------------------------------------------------------------------");
          console.log(JSON.stringify(data, null, 2));
          console.log("Open Account --------------------------------------------------------------------------");
          resolve();
        } else {
          console.log("TestClient: Failed", openAccountResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject(openAccountResponse.statusCode);
        }
      });
    });
  }

  private async getBankAccount(client: TestClient): Promise<void> {
    const details: BankGetAccountDetails = {};
    const request: BankServiceRequest<SignedAddressIdentity, BankGetAccountDetails> = {
      type: 'get-account',
      identity: client.signedAddress,
      details: details
    };
    const args: PostArgs = {
      data: request,
      headers: {
        "Content-Type": "application/json"
      }
    };
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(client.bankResponse.serviceEndpoints.restServiceUrl, args, (data: any, getAccountResponse: Response) => {
        if (getAccountResponse.statusCode === 200) {
          client.bankAccountResponse = data as BankGetAccountResponse;
          console.log("TestClient: account information", JSON.stringify(client.bankAccountResponse));
          console.log("Get Account Request --------------------------------------------------------------------------");
          console.log(JSON.stringify(request, null, 2));
          console.log("Get Account Response --------------------------------------------------------------------------");
          console.log(JSON.stringify(data, null, 2));
          console.log("Get Account --------------------------------------------------------------------------");
          resolve();
        } else {
          console.log("TestClient: Failed", getAccountResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject(getAccountResponse.statusCode);
        }
      });
    });
  }

  private async transfer(client: TestClient, toClient: TestClient, amount: number, reference: string): Promise<void> {
    const details: BankTransferDetails = {
      amount: amount,
      to: {
        bankUrl: toClient.bankResponse.serviceEndpoints.descriptionUrl,
        accountAddress: toClient.signedAddress.address
      },
      requestReference: reference
    };
    const request: BankServiceRequest<SignedAddressIdentity, BankTransferDetails> = {
      type: 'transfer',
      identity: client.signedAddress,
      details: details
    };
    const args: PostArgs = {
      data: request,
      headers: {
        "Content-Type": "application/json"
      }
    };
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(client.bankResponse.serviceEndpoints.restServiceUrl, args, (data: any, transferResponse: Response) => {
        if (transferResponse.statusCode === 200) {
          const transfer = data as BankTransferResponse;
          console.log("TestClient: transfer completed", JSON.stringify(transfer));
          console.log("Transfer Request --------------------------------------------------------------------------");
          console.log(JSON.stringify(request, null, 2));
          console.log("Transfer Response Response --------------------------------------------------------------------------");
          console.log(JSON.stringify(data, null, 2));
          console.log("Transfer Receipt Decoded Response --------------------------------------------------------------------------");
          console.log(JSON.stringify(ChannelIdentityUtils.decode(transfer.signedReceipts[0].signedReceipt, client.bankResponse.bank.publicKey, Date.now()), null, 2));
          console.log("Transfer --------------------------------------------------------------------------");
          resolve();
        } else {
          console.log("TestClient: Failed", transferResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject(transferResponse.statusCode);
        }
      });
    });
  }

}

const clientTester = new ClientTester();

export { clientTester };
