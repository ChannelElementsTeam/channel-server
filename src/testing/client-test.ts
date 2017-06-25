import * as express from "express";
import { Express, Request, Response } from 'express';
import { configuration } from '../configuration';
import { client as WebSocketClient, connection, IMessage } from 'websocket';
import { TextDecoder, TextEncoder } from 'text-encoding';
import * as url from "url";
import { ChannelShareCodeResponse, ChannelShareResponse, ChannelsListResponse, ChannelCreateResponse, ChannelServiceDescription, ChannelAcceptResponse, ChannelGetResponse, ChannelCreateDetails, ChannelShareDetails, ChannelServiceRequest, ProviderServiceEndpoints, ChannelsListDetails, ChannelAcceptDetails, ChannelGetDetails, ChannelDeleteDetails } from "../common/channel-service-rest";
import { JoinResponseDetails, ControlChannelMessage, JoinRequestDetails, HistoryRequestDetails, LeaveRequestDetails } from "../common/channel-service-control";
import { ChannelMessage, ChannelMessageUtils, MessageToSerialize } from "../common/channel-message-utils";
import { ChannelContractDetails, ChannelInformation, MemberContractDetails } from "../common/channel-service-channel";
import { SignedIdentity, AddressIdentity, FullIdentity, ChannelIdentityUtils, KeyIdentity } from "../common/channel-service-identity";
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
  signedAddress: SignedIdentity<AddressIdentity>;
  signedIdentity: SignedIdentity<FullIdentity>;
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
  privateKey: Uint8Array;

  constructor(name: string) {
    this.privateKey = ChannelIdentityUtils.generatePrivateKey();
    const keyInfo = ChannelIdentityUtils.getKeyInfo(this.privateKey);
    this.signedIdentity = ChannelIdentityUtils.createSignedFullIdentity(keyInfo, name);
    this.signedAddress = ChannelIdentityUtils.createSignedAddressIdentity(keyInfo, this.signedIdentity.info.address);
  }
  private requestHandlersById: { [requestId: string]: (controlMessage: ControlChannelMessage) => Promise<void> } = {};
  async handleMessage(messageInfo: ChannelMessage): Promise<void> {
    let handled = false;
    if (messageInfo.channelCode === 0 && messageInfo.senderCode === 0 && messageInfo.controlMessagePayload) {
      const controlMessage = messageInfo.controlMessagePayload.jsonMessage as ControlChannelMessage;
      if (controlMessage.type === 'ping') {
        const byteArray = ChannelMessageUtils.serializeControlMessage(controlMessage.requestId, 'ping-reply', {});
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
      }
    }
    if (!handled) {
      if (messageInfo.controlMessagePayload) {
        console.log("TestClient: Control Message Received", this.id, messageInfo.timestamp, JSON.stringify(messageInfo.controlMessagePayload.jsonMessage));
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
    app.get('/d/test/send', (request: Request, response: Response) => {
      void this.handleSend(request, response);
    });
    app.get('/d/test/leave', (request: Request, response: Response) => {
      void this.handleLeave(request, response);
    });
    app.get('/d/test/delete', (request: Request, response: Response) => {
      void this.handleDelete(request, response);
    });
  }

  private async handleCreateClientWithChannel(request: Request, response: Response): Promise<void> {
    const id = request.query.id;
    const name = request.query.name || 'unnamed';
    if (!id) {
      response.status(400).send("Missing id param");
      return;
    }
    const client = new TestClient(name);
    this.clientsById[id] = client;
    await this.getProvider(client);
    await this.createChannel(client, name);
    await this.openSocket(client);
    await this.joinChannel(client, name);
    await this.shareChannel(client, name);
    await this.listChannels(client);
    await this.send(client, "This is just after channel creation.");
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
    await this.openSocket(client);
    await this.joinChannel(client, name);
    await this.requestHistory(client);
    await this.listChannels(client);
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

  private async createChannel(client: TestClient, name: string): Promise<void> {
    const contract: ChannelContractDetails = {
      package: "default",
      serviceContract: {
        options: {
          history: true,
          topology: 'many-to-many'
        },
        extensions: {}
      },
      participationContract: {
        type: "https://channelelements.com/contracts/test1",
        extensions: {}
      }
    };
    const memberContract: MemberContractDetails = {
      notificationType: 'none'
    };
    const details: ChannelCreateDetails = {
      channelContract: contract,
      memberContract: memberContract
    };
    const request: ChannelServiceRequest<FullIdentity, ChannelCreateDetails> = {
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
      this.restClient.post(client.providerResponse.serviceEndpoints.restServiceUrl, args, (data: any, createResponse: Response) => {
        if (createResponse.statusCode === 200) {
          console.log("TestClient: Channel created", JSON.stringify(data));
          client.channelResponse = data as ChannelCreateResponse;
          console.log("TestClient: channel list reply", JSON.stringify(client.channelResponse));
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

  private async joinChannel(client: TestClient, name: string): Promise<void> {
    const details: JoinRequestDetails = {
      channelAddress: client.channelResponse.channelAddress,
      memberIdentity: client.signedAddress,
      participantIdentityDetails: { name: name }
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
    const shareRequest: ChannelServiceRequest<FullIdentity, ChannelShareDetails> = {
      type: 'share',
      identity: client.signedIdentity,
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
        notificationType: 'none'
      };
      const details: ChannelAcceptDetails = {
        invitationId: client.shareCodeResponse.invitationId,
        memberContract: memberContract
      };
      const request: ChannelServiceRequest<FullIdentity, ChannelAcceptDetails> = {
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
      const request: ChannelServiceRequest<AddressIdentity, ChannelGetDetails> = {
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
      const request: ChannelServiceRequest<KeyIdentity, ChannelsListDetails> = {
        type: 'list',
        identity: client.signedIdentity,
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
      memberAddress: client.signedIdentity.info.address,
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
      const request: ChannelServiceRequest<AddressIdentity, ChannelDeleteDetails> = {
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
          resolve();
        } else {
          console.error("Failed", deleteResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Delete channel failed");
        }
      });
    });
  }
}

const clientTester = new ClientTester();

export { clientTester };
