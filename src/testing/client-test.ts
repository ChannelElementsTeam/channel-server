import * as express from "express";
import { Express, Request, Response } from 'express';
import { configuration } from '../configuration';
import { RegistrationRequest, RegistrationResponse, ChannelCreateRequest, ControlChannelMessage, JoinRequestDetails, ShareResponse, GetChannelResponse, JoinResponseDetails, ShareRequest, HistoryRequestDetails, HistoryResponseDetails, ChannelListResponse, LeaveRequestDetails } from '../common/channel-server-messages';
import { client as WebSocketClient, connection, IMessage } from 'websocket';
import { TextDecoder, TextEncoder } from 'text-encoding';
import { ChannelMessageUtils, ShareCodeResponse, ChannelJoinRequest, DeserializedMessage, ChannelMessage, MessageToSerialize, ChannelMemberIdentity, ChannelContractDetails } from "../common/channel-server-messages";
import * as url from "url";
import { EntityAddress } from "../common/entity-address";
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
  identity: ChannelMemberIdentity;
  registrationResponse?: RegistrationResponse;
  socket?: WebSocketClient;
  conn?: connection;
  channelResponse?: GetChannelResponse;
  channelListResponse?: ChannelListResponse;
  requestIndex = 1;
  shareResponse?: ShareResponse;
  shareCodeResponse?: ShareCodeResponse;
  joinResponseDetails?: JoinResponseDetails;

  constructor() {
    this.identity = {
      address: EntityAddress.generate().toString(),
      details: {}
    };
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
        console.log("History-message", messageInfo);
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
    const client = new TestClient();
    this.clientsById[id] = client;
    await this.register(client, name, url.resolve(configuration.get('baseClientUri'), '/d/register'));
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
    const client = new TestClient();
    this.clientsById[id] = client;
    await this.getShare(client, from);
    await this.register(client, name, (client.shareCodeResponse).registrationUrl);
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

  private async register(client: TestClient, name: string, registerUrl: string): Promise<void> {
    const registrationRequest: RegistrationRequest = {
      identity: { name: name }
    };
    const args: PostArgs = {
      data: registrationRequest,
      headers: { "Content-Type": "application/json" }
    };
    console.log("Registering...");
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(registerUrl, args, (data: any, registerResponse: Response) => {
        if (registerResponse.statusCode === 200) {
          console.log("Registered", data);
          client.registrationResponse = data as RegistrationResponse;
          resolve();
        } else {
          console.log("Failed", registerResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject(registerResponse.statusCode);
        }
      });
    });
  }

  private async createChannel(client: TestClient, name: string): Promise<void> {
    const contract: ChannelContractDetails = {
      channelContract: {
        options: {
          history: true,
          topology: 'many-to-many'
        },
        details: {}
      },
      participationContract: {
        type: "https://channelelements.com/contracts/test1",
        details: {}
      }
    };
    const createRequest: ChannelCreateRequest = {
      channelAddress: EntityAddress.generate().toString(),
      creatorIdentity: client.identity,
      contract: contract
    };
    const args: PostArgs = {
      data: createRequest,
      headers: {
        Authorization: basic(client.registrationResponse.id, client.registrationResponse.token),
        "Content-Type": "application/json"
      }
    };
    console.log("TestClient: Creating channel...");
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(client.registrationResponse.services.createChannelUrl, args, (data: any, createResponse: Response) => {
        if (createResponse.statusCode === 200) {
          console.log("TestClient: Channel created", data);
          client.channelResponse = data as GetChannelResponse;
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
      client.socket.connect(client.channelResponse.transportUrl + "?id=" + encodeURIComponent(client.registrationResponse.id) + "&token=" + encodeURIComponent(client.registrationResponse.token), null, null, headers);
    });
  }

  private async joinChannel(client: TestClient, name: string): Promise<void> {
    const details: JoinRequestDetails = {
      channelAddress: client.channelResponse.channelAddress,
      memberAddress: client.identity.address,
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
          console.log("TestClient: history reply", controlMessage.details);
          innerResolve();
          resolve();
        });
      });
    });
  }

  private async shareChannel(client: TestClient, name: string): Promise<void> {
    const shareRequest: ShareRequest = {
      channelAddress: client.channelResponse.channelAddress,
      details: { name: name, sharing: true }
    };
    const args: PostArgs = {
      data: shareRequest,
      headers: {
        Authorization: basic(client.registrationResponse.id, client.registrationResponse.token),
        "Content-Type": "application/json"
      }
    };
    return new Promise<void>((resolve, reject) => {
      this.restClient.post(client.registrationResponse.services.shareChannelUrl, args, (data: any, createResponse: Response) => {
        if (createResponse.statusCode === 200) {
          console.log("TestClient: Share code created", data);
          client.shareResponse = data as ShareResponse;
          resolve();
        } else {
          console.error("Failed", createResponse.statusCode, new TextDecoder('utf-8').decode(data));
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
          console.log("TestClient: Share code fetched", data);
          client.shareCodeResponse = data as ShareCodeResponse;
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
      const details: ChannelJoinRequest = {
        invitationId: client.shareCodeResponse.invitationId,
        identity: client.identity
      };
      const args: PostArgs = {
        data: details,
        headers: {
          Authorization: basic(client.registrationResponse.id, client.registrationResponse.token),
          "Content-Type": "application/json"
        }
      };
      this.restClient.post(client.shareCodeResponse.acceptChannelUrl, args, (data: any, joinChannelResponse: Response) => {
        if (joinChannelResponse.statusCode === 200) {
          console.log("TestClient: Share code fetched", data);
          client.channelResponse = data as GetChannelResponse;
          resolve();
        } else {
          console.warn("Failed", joinChannelResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Failed to accept");
        }
      });
    });
  }

  private async getChannel(client: TestClient, channelUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args: RestArgs = {
        headers: {
          Authorization: basic(client.registrationResponse.id, client.registrationResponse.token)
        }
      };
      this.restClient.get(channelUrl, args, (data: any, channelResponse: Response) => {
        if (channelResponse.statusCode === 200) {
          client.channelResponse = data as GetChannelResponse;
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
      const args: RestArgs = {
        headers: {
          Authorization: basic(client.registrationResponse.id, client.registrationResponse.token)
        }
      };
      this.restClient.get(client.registrationResponse.services.channelListUrl, args, (data: any, channelResponse: Response) => {
        if (channelResponse.statusCode === 200) {
          client.channelListResponse = data as ChannelListResponse;
          console.log("TestClient: Channel list fetched", JSON.stringify(data));
          resolve();
        } else {
          console.error("Failed", channelResponse.statusCode, new TextDecoder('utf-8').decode(data));
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
          console.log("TestClient: Leave completed", permanently);
          innerResolve();
          resolve();
        });
      });
    });
  }

  private deleteChannel(client: TestClient): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args: RestArgs = {
        headers: {
          Authorization: basic(client.registrationResponse.id, client.registrationResponse.token)
        }
      };
      this.restClient.delete(client.channelResponse.channelUrl, args, (data: any, channelResponse: Response) => {
        if (channelResponse.statusCode === 200) {
          console.log("TestClient: Channel deleted", JSON.stringify(data));
          resolve();
        } else {
          console.error("Failed", channelResponse.statusCode, new TextDecoder('utf-8').decode(data));
          reject("Delete channel failed");
        }
      });
    });
  }
}

const clientTester = new ClientTester();

export { clientTester };
