import * as express from "express";
import { Request, Response } from 'express';
import * as net from 'net';
import * as crypto from "crypto";
import * as uuid from "uuid";
import * as auth from "basic-auth";
import * as url from 'url';
import * as expressHandlebars from 'express-handlebars';

import { TextDecoder, TextEncoder } from 'text-encoding';

import { TransportServer, TransportEventHandler, MessageHandlingDirective, ControlMessageDirective } from './transport-server';
import { db } from "./db";
import { UserRecord, ChannelMemberRecord, ChannelRecord, MessageRecord, ChannelInvitation } from './interfaces/db-records';
import { RegistrationResponse, ChannelServerResponse, RegistrationRequest, ChannelCreateRequest, GetChannelResponse, ChannelMemberInfo, ControlChannelMessage, ChannelParticipantInfo, AccountResponse, AccountUpdateRequest, JoinRequestDetails, JoinResponseDetails, JoinNotificationDetails, ErrorDetails, ShareRequest, ShareResponse, LeaveNotificationDetails, HistoryRequestDetails, HistoryResponseDetails, ControlMessagePayload, ProviderServiceList, ChannelListResponse, LeaveRequestDetails, ChannelOptions, HistoryMessageDetails } from './common/channel-server-messages';
import { Utils } from "./utils";
import { DeserializedMessage, ChannelMessageUtils, PingRequestDetails, ChannelDeleteResponseDetails, ChannelDeletedNotificationDetails, ShareCodeResponse, ChannelJoinRequest, ChannelMessage, ChannelContractDetails, ChannelMemberIdentity, ChannelParticipantIdentity } from "./common/channel-server-messages";

const TOKEN_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_HISTORY_BUFFERED_SIZE = 50000;

export class ChannelServer implements TransportEventHandler {
  private providerUrl: string;
  private homeUrl: string;
  private restBaseUrl: string;
  private restRelativeBaseUrl: string;
  private transportBaseUrl: string;
  private pingInterval: number;
  private pingTimeout: number;
  private lastChannelCheck = Date.now();
  private app: express.Application;
  private transport: TransportServer;
  private transportUrl: string;

  private channelAddressByCode: { [code: string]: string } = {};
  private channelInfoByAddress: { [channelAddress: string]: ChannelInfo } = {};
  private socketInfoById: { [socketId: string]: SocketInfo } = {};

  // private socketIdsByUserId: { [userId: string]: string[] } = {};
  private lastAllocatedChannelCode = 0;

  registrationUrl: string;

  constructor(app: express.Application, server: net.Server, providerUrl: string, homeUrl: string, restBaseUrl: string, restRelativeBaseUrl: string, transportBaseUrl: string, relativeTransportUrl: string, pingInterval: number, pingTimeout: number) {
    this.app = app;
    this.providerUrl = providerUrl;
    this.homeUrl = homeUrl;
    this.restBaseUrl = restBaseUrl;
    this.restRelativeBaseUrl = restRelativeBaseUrl;
    this.transportBaseUrl = transportBaseUrl;
    this.transportUrl = this.transportBaseUrl + relativeTransportUrl;
    this.registerHandlers(restRelativeBaseUrl);
    this.transport = new TransportServer(app, server, this, relativeTransportUrl);
    this.pingInterval = pingInterval;
    this.pingTimeout = pingTimeout;

    this.app.engine('handlebars', expressHandlebars({ defaultLayout: 'main' }));
    this.app.set('view engine', 'handlebars');
  }

  start(): void {
    this.transport.start();
    if (this.pingInterval > 0) {
      setInterval(() => {
        this.processPings();
      }, 1000);
    }
    setInterval(() => {
      void this.processDeletedChannels();
    }, 5000);
  }

  private registerHandlers(restRelativeBaseUrl: string): void {
    this.app.post(restRelativeBaseUrl + '/register', (request: Request, response: Response) => {
      void this.handleRegister(request, response);
    });
    this.app.get(restRelativeBaseUrl + '/account', (request: Request, response: Response) => {
      void this.handleGetAccount(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/account', (request: Request, response: Response) => {
      void this.handleUpdateAccount(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/share', (request: Request, response: Response) => {
      void this.handleShare(request, response);
    });
    this.app.get('/i/:share', (request: Request, response: Response) => {
      void this.handleGetInvitation(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/accept', (request: Request, response: Response) => {
      void this.handleAccept(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/channels/create', (request: Request, response: Response) => {
      void this.handleCreateChannel(request, response);
    });
    this.app.get(restRelativeBaseUrl + '/channels/:cid', (request: Request, response: Response) => {
      void this.handleGetChannel(request, response);
    });
    this.app.delete(restRelativeBaseUrl + '/channels/:cid', (request: Request, response: Response) => {
      void this.handleDeleteChannel(request, response);
    });
    this.app.get(restRelativeBaseUrl + '/channels', (request: Request, response: Response) => {
      void this.handleGetChannelList(request, response);
    });
  }

  getServicesList(): ProviderServiceList {
    const result: ProviderServiceList = {
      providerUrl: this.providerUrl,
      serviceHomeUrl: this.homeUrl,
      registrationUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/register'),
      accountUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/account'),
      createChannelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/create'),
      channelListUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels'),
      shareChannelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/share'),
      acceptChannelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/accept')
    };
    return result;
  }

  private async handleRegister(request: Request, response: Response): Promise<void> {
    const signUpRequest = request.body as RegistrationRequest;
    if (!signUpRequest || !signUpRequest.identity) {
      console.warn("ChannelServer: invalid request", signUpRequest);
      response.status(400).send("Invalid request body");
      return;
    }
    const userId = this.createId();
    const token = this.createToken();
    const user = await db.insertUser(userId, token, signUpRequest.identity, 'active');
    const reply: RegistrationResponse = {
      id: userId,
      token: token,
      services: this.getServicesList(),
    };
    console.log("ChannelServer: registered", userId);
    response.json(reply);
  }

  private async authenticateUser(request: Request, response?: Response): Promise<UserRecord> {
    let credentials: auth.BasicAuthResult;
    if (request.query.id && request.query.token) {
      credentials = {
        name: request.query.id,
        pass: request.query.token
      };
    }
    if (!credentials) {
      credentials = auth(request);
    }
    if (!credentials) {
      return null;
    }
    const user = await db.findUserById(credentials.name);
    if (!user || user.token !== credentials.pass) {
      if (response) {
        response.status(401).send("Unauthorized");
      }
      return null;
    }
    if (user.status !== 'active') {
      if (response) {
        response.status(403).send("Forbidden");
      }
      return null;
    }
    return user;
  }

  private async handleGetAccount(request: Request, response: Response): Promise<void> {
    const user = await this.authenticateUser(request, response);
    if (!user) {
      console.warn("ChannelServer: handleGetAccount not authenticated");
      response.status(401).send("Not authenticated");
      return;
    }
    const reply: AccountResponse = {
      id: user.id,
      services: this.getServicesList()
    };
    console.log("ChannelServer: account fetched", user.id);
    response.json(reply);
  }

  private async handleUpdateAccount(request: Request, response: Response): Promise<void> {
    const user = await this.authenticateUser(request, response);
    if (!user) {
      console.warn("ChannelServer: handleUpdateAccount not authenticated");
      return;
    }
    const update = request.body as AccountUpdateRequest;
    if (!update || !update.identity) {
      response.status(400).send("Missing or invalid request body");
      return;
    }
    await db.updateUserIdentity(user.id, update.identity);
    console.log("ChannelServer: account updated", user.id);
    response.json({});
  }

  private async handleShare(request: Request, response: Response): Promise<void> {
    const user = await this.authenticateUser(request, response);
    if (!user) {
      console.warn("ChannelServer: handleShare not authenticated");
      return;
    }
    const shareRequest = request.body as ShareRequest;
    if (!shareRequest || !shareRequest.channelAddress) {
      response.status(400).send("Invalid request:  missing channelAddress");
      return;
    }
    const channelMember = await db.findChannelMember(shareRequest.channelAddress, user.id);
    if (!channelMember || channelMember.status !== 'active') {
      response.status(403).send("You cannot share a channel unless you are a member");
      return;
    }
    const channelRecord = await db.findChannelById(shareRequest.channelAddress);
    if (!channelRecord) {
      response.status(404).send("No such channel");
      return;
    }
    let invitation: ChannelInvitation;
    let count = 0;
    while (count++ < 1000) {
      const invitationId = this.createToken(6);
      try {
        invitation = await db.insertInvitation(invitationId, user.id, channelRecord.channelAddress, shareRequest ? shareRequest.details : null);
      } catch (err) {
        // Possible duplicate on id, so will just try again
      }
    }
    const reply: ShareResponse = {
      shareCodeUrl: url.resolve(this.restBaseUrl, '/i/' + invitation.id)
    };
    console.log("ChannelServer: invitation created", user.id, channelRecord.channelAddress);
    response.json(reply);
  }

  private async handleGetInvitation(request: Request, response: Response): Promise<void> {
    const shareId = request.params.share;
    const invitation = await db.findInvitationById(shareId);
    if (!invitation) {
      response.status(404).send("No such invitation");
      return;
    }
    if (request.accepts('json')) {
      const reply: ShareCodeResponse = {
        providerUrl: this.providerUrl,
        registrationUrl: this.getServicesList().registrationUrl,
        acceptChannelUrl: this.getServicesList().acceptChannelUrl,
        details: invitation.details,
        invitationId: invitation.id
      };
      response.json(reply);
      console.log("ChannelServer: invitation fetched", shareId, invitation.channelAddress);
    } else {
      response.render('sharecode', {
        helpers: {
          sharecode: () => {
            return url.resolve(this.restBaseUrl, '/i/' + invitation.id);
          }
        }
      });
    }
  }

  private async handleAccept(request: Request, response: Response): Promise<void> {
    const user = await this.authenticateUser(request, response);
    if (!user) {
      console.warn("ChannelServer: handleAccept not authenticated");
      return;
    }
    const details = request.body as ChannelJoinRequest;
    if (!details || !details.invitationId) {
      response.status(400).send("Request is invalid -- missing invitationId");
      return;
    }
    const invitation = await db.findInvitationById(details.invitationId);
    if (!invitation) {
      response.status(404).send("This invitation is no longer valid");
      return;
    }
    const channelRecord = await db.findChannelById(invitation.channelAddress);
    if (!channelRecord || channelRecord.status !== 'active') {
      response.status(404).send("The shared channel no longer exists");
      return;
    }
    await db.insertChannelMember(channelRecord.channelAddress, details.identity, user.id, 'active');
    await this.handleGetChannelResponse(channelRecord, user, request, response);
    console.log("ChannelServer: invitation used and channel joined", user.id, invitation.id, invitation.channelAddress);
  }

  private async handleCreateChannel(request: Request, response: Response): Promise<void> {
    const user = await this.authenticateUser(request, response);
    if (!user) {
      console.warn("ChannelServer: handleCreateChannel not authenticated");
      return;
    }
    const channelRequest = request.body as ChannelCreateRequest;
    // TODO: validate channelRequest

    // This is assigning the transport responsibility for this channel to my own server.  When running with multiple
    // servers, this means that I'm balancing the switching load over those servers, too.  We just have to make sure
    // that REST requests that need to be handled by the server doing the transport arrive on the correct server.
    const channelAddress = channelRequest.channelAddress;
    this.fillAllOptions(channelRequest.contract.channelContract.options);
    const channelRecord = await db.insertChannel(channelAddress, user.id, channelRequest.creatorIdentity.address, this.transportUrl, channelRequest.contract, 'active');
    const now = Date.now();
    const channelInfo: ChannelInfo = {
      code: this.allocateChannelCode(),
      channelAddress: channelRecord.channelAddress,
      participantsByCode: {},
      lastAllocatedCode: 0,
      contract: channelRecord.contract,
      creatorAddress: channelRequest.creatorIdentity.address
    };
    this.channelInfoByAddress[channelRecord.channelAddress] = channelInfo;
    this.channelAddressByCode[channelInfo.code] = channelRecord.channelAddress;
    const participantAddress = this.createId();
    await db.insertChannelMember(channelAddress, channelRequest.creatorIdentity, user.id, 'active');
    const reply = await this.handleGetChannelResponse(channelRecord, user, request, response);
    console.log("ChannelServer: channel created", user.id, channelAddress);
  }

  private async handleGetChannel(request: Request, response: Response): Promise<void> {
    const user = await this.authenticateUser(request, response);
    if (!user) {
      console.warn("ChannelServer: handleCreateChannel not authenticated");
      return;
    }
    const channelMember = await db.findChannelMember(request.params.cid, user.id);
    if (!channelMember || channelMember.status !== 'active') {
      response.status(403).send("You are not a member of this channel");
      return;
    }
    const channelRecord = await db.findChannelById(request.params.cid);
    if (!channelRecord || channelRecord.status !== 'active') {
      response.status(404).send("No such channel");
      return;
    }

    const reply = await this.handleGetChannelResponse(channelRecord, user, request, response);
    console.log("ChannelServer: channel fetched", user.id, channelRecord.channelAddress);
  }

  private async handleDeleteChannel(request: Request, response: Response): Promise<void> {
    const user = await this.authenticateUser(request, response);
    if (!user) {
      console.warn("ChannelServer: handleCreateChannel not authenticated");
      return;
    }
    const channelAddress = request.params.cid;
    const channelMember = await db.findChannelMember(channelAddress, user.id);
    if (!channelMember || channelMember.status !== 'active') {
      response.status(403).send("You cannot delete a channel unless you are a member");
      return;
    }
    const channelRecord = await db.findChannelById(channelAddress);
    if (!channelRecord || channelRecord.status !== 'active') {
      response.status(404).send("No such channel");
      return;
    }
    if (channelRecord.creatorUserId !== user.id) {
      response.status(404).send("You must be the creator to delete a channel");
      return;
    }
    await db.updateChannelStatus(channelRecord.channelAddress, 'deleted');
    const reply: ChannelDeleteResponseDetails = {
      channelAddress: channelRecord.channelAddress
    };
    response.json(reply);
    console.log("ChannelServer: channel deleted", user.id, channelRecord.channelAddress);
    void this.processDeletedChannels();
  }

  private async processDeletedChannels(): Promise<void> {
    const lastCheck = this.lastChannelCheck;
    this.lastChannelCheck = Date.now();
    const updatedChannels = await db.findUpdatedChannels(lastCheck);
    for (const channelRecord of updatedChannels) {
      if (channelRecord.status !== 'active') {
        const channelInfo = this.channelInfoByAddress[channelRecord.channelAddress];
        if (channelInfo) {
          for (const code of Object.keys(channelInfo.participantsByCode)) {
            const participant = channelInfo.participantsByCode[code];
            const socket = this.socketInfoById[participant.socketId];
            const details: ChannelDeletedNotificationDetails = {
              channelAddress: channelRecord.channelAddress
            };
            const message = ChannelMessageUtils.serializeControlMessage(null, 'channel-deleted', details);
            await this.transport.deliverMessage(message, socket.socketId);
            delete socket.participantCodeByChannelAddress[channelRecord.channelAddress];
          }
          delete this.channelInfoByAddress[channelRecord.channelAddress];
          delete this.channelAddressByCode[channelInfo.code];
        }
      }
    }
  }

  private async handleGetChannelResponse(channelRecord: ChannelRecord, user: UserRecord, request: Request, response: Response): Promise<GetChannelResponse> {
    const reply: GetChannelResponse = {
      channelAddress: channelRecord.channelAddress,
      transportUrl: channelRecord.transportUrl,
      registerUrl: this.getServicesList().registrationUrl,
      channelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress),
      contract: channelRecord.contract,
      isCreator: channelRecord.creatorUserId === user.id,
      memberCount: await db.countChannelMembers(channelRecord.channelAddress, 'active'),
      recentlyActiveMembers: [],
      created: channelRecord.created,
      lastUpdated: channelRecord.lastUpdated
    };
    const members = await db.findChannelMembers(channelRecord.channelAddress, 'active', 8);
    for (const member of members) {
      const info: ChannelMemberInfo = {
        identity: member.identity,
        isCreator: member.userId === channelRecord.creatorUserId,
        memberSince: member.added,
        lastActive: member.lastActive,
      };
      reply.recentlyActiveMembers.push(info);
    }
    response.json(reply);
    return reply;
  }

  private async handleGetChannelList(request: Request, response: Response): Promise<void> {
    const user = await this.authenticateUser(request, response);
    if (!user) {
      console.warn("ChannelServer: handleGetChannelList not authenticated");
      return;
    }
    const lastActiveBefore = request.query.before ? Number(request.query.before) : 0;
    const memberAddress = request.query.memberAddress;
    if (!memberAddress) {
      response.status(400).send("Missing memberAddress parameter");
    }
    const limit = request.query.limit ? Number(request.query.limit) : 50;
    const count = await db.countChannelMembersByAddress(memberAddress, 'active', lastActiveBefore);
    const memberRecords = await db.findChannelMembersByAddress(memberAddress, 'active', lastActiveBefore, limit);
    const reply: ChannelListResponse = {
      total: count,
      channels: []
    };
    for (const record of memberRecords) {
      const channelRecord = await db.findChannelById(record.channelAddress);
      if (channelRecord && channelRecord.status === 'active') {
        const channelDetails: GetChannelResponse = {
          channelAddress: record.channelAddress,
          transportUrl: channelRecord.transportUrl,
          registerUrl: this.getServicesList().registrationUrl,
          channelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress),
          contract: channelRecord.contract,
          isCreator: channelRecord.creatorUserId === user.id,
          memberCount: await db.countChannelMembers(channelRecord.channelAddress, 'active'),
          recentlyActiveMembers: [],
          created: channelRecord.created,
          lastUpdated: channelRecord.lastUpdated
        };
        const members = await db.findChannelMembers(channelRecord.channelAddress, 'active');
        for (const member of members) {
          const info: ChannelMemberInfo = {
            identity: member.identity,
            isCreator: member.userId === channelRecord.creatorUserId,
            memberSince: member.added,
            lastActive: member.lastActive,
          };
          channelDetails.recentlyActiveMembers.push(info);
        }
        reply.channels.push(channelDetails);
      }
    }
    console.log("ChannelServer: channel list fetched", user.id, lastActiveBefore, limit, count);
    response.json(reply);
  }

  async handleSocketConnectRequest(request: Request): Promise<string> {
    const user = await this.authenticateUser(request);
    if (!user) {
      console.warn("ChannelServer: handleSocketConnectRequest: not authenticated");
      return;
    }
    const socketId = this.createId();
    const now = Date.now();
    this.socketInfoById[socketId] = {
      socketId: socketId,
      userId: user.id,
      participantCodeByChannelAddress: {},
      isOpen: true,
      lastPingSent: now,
      lastPingReply: now,
      pingId: 1,
      lastTimestampReceived: 0
    };
    // let socketIds = this.socketIdsByUserId[user.id];
    // if (!socketIds) {
    //   socketIds = [];
    //   this.socketIdsByUserId[user.id] = socketIds;
    // }
    // socketIds.push(socketId);
    console.log("ChannelServer: socket connected", user.id, socketId);
    return socketId;
  }

  async handleSocketClosed(socketId: string): Promise<void> {
    const socketInfo = this.socketInfoById[socketId];
    if (socketInfo) {
      socketInfo.isOpen = false;
      console.log("ChannelServer: handleSocketClosed", socketId, socketInfo.userId);
      delete this.socketInfoById[socketId];
      for (const channelAddress of Object.keys(socketInfo.participantCodeByChannelAddress)) {
        const participantCode = socketInfo.participantCodeByChannelAddress[channelAddress];
        const channelInfo = this.channelInfoByAddress[channelAddress];
        if (channelInfo) {
          const participantInfo = channelInfo.participantsByCode[participantCode];
          if (participantInfo) {
            await this.handleParticipantLeft(channelInfo, participantInfo, socketInfo, false);
          }
        }
      }
    } else {
      console.error("ChannelServer: handleSocketClosed: socket missing");
    }
  }

  private async handleParticipantLeft(channel: ChannelInfo, participant: ParticipantInfo, socket: SocketInfo, permanently: boolean): Promise<number> {
    delete channel.participantsByCode[participant.code];
    let count = 0;
    if (channel.contract.channelContract.options.topology === 'many-to-many') {
      for (const code of Object.keys(channel.participantsByCode)) {
        if (code !== participant.code.toString()) {
          const p = channel.participantsByCode[code];
          const notificationDetails: LeaveNotificationDetails = {
            channelAddress: channel.channelAddress,
            participantAddress: participant.memberIdentity.address,
            participantCode: participant.code,
            permanently: permanently
          };
          const message = ChannelMessageUtils.serializeControlMessage(null, 'leave-notification', notificationDetails);
          await this.transport.deliverMessage(message, p.socketId);
          count++;
          console.log("ChannelServer: Sending leave-notification", p.userId, p.socketId, notificationDetails.channelAddress, notificationDetails.participantAddress);
        }
      }
    }
    if (Object.keys(channel.participantsByCode).length === 0) {
      console.log("ChannelServer: Last participant left channel.  Removing active channel.", channel.channelAddress, channel.code);
      delete this.channelAddressByCode[channel.code];
      delete this.channelInfoByAddress[channel.channelAddress];
    }
    return count;
  }

  // TODO: Move this message handling entirely into the transport layer using lookup tables there, and only
  // handle error cases and control messages.  This will allow the transport layer to be tuned for high performance
  // and eventually allow a single channel server to manage multiple transport switches.
  async handleReceivedMessage(messageInfo: ChannelMessage, socketId: string): Promise<MessageHandlingDirective> {
    const result: MessageHandlingDirective = {
      forwardMessageToSockets: [],
      deliverControlMessages: []
    };
    const socket = this.socketInfoById[socketId];
    if (!socket) {
      throw new Error("Missing socket");
    }
    if (messageInfo.timestamp <= socket.lastTimestampReceived) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(null, socketId, 400, "Discarding illegal message:  timestamp must always increase", null));
      return result;  // sending to an unknown channel
    }
    if (messageInfo.channelCode === 0 || messageInfo.senderCode === 0) {
      return this.handleReceivedControlMessage(messageInfo, socket);
    }
    const channelAddress = this.channelAddressByCode[messageInfo.channelCode.toString()];
    if (!channelAddress) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(null, socketId, 404, "Unknown channel code", channelAddress));
      return result;  // sending to an unknown channel
    }
    const channelInfo = this.channelInfoByAddress[channelAddress];
    if (!channelInfo) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(null, socketId, 500, "Server error: channel information missing", channelAddress));
      return result;  // no channel information available for some reason
    }
    const participant = channelInfo.participantsByCode[messageInfo.senderCode.toString()];
    if (!participant || participant.socketId !== socket.socketId) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(null, socketId, 403, "You have not been assigned this sender code on that channel on this socket", channelAddress));
      return result;  // sending with illegal sender code
    }
    if (channelInfo.contract.channelContract.options.topology === 'one-to-many' && participant.memberIdentity.address !== channelInfo.creatorAddress) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(null, socketId, 403, "This is a one-to-many channel.  Only the creator is allowed to send messages.", channelAddress));
      return result;
    }
    if (messageInfo.history && channelInfo.contract.channelContract.options.history) {
      await db.insertMessage(channelAddress, participant.memberIdentity.address, messageInfo.timestamp, messageInfo.serializedMessage.byteLength, messageInfo.serializedMessage);
    }
    await this.updateChannelMemberActive(channelAddress, participant.code.toString());
    const socketIds: string[] = [];
    for (const code of Object.keys(channelInfo.participantsByCode)) {
      if (code !== messageInfo.senderCode.toString()) {
        const p = channelInfo.participantsByCode[code];
        if (channelInfo.contract.channelContract.options.topology === 'many-to-one' && p.memberIdentity.address !== channelInfo.creatorAddress && participant.memberIdentity.address !== channelInfo.creatorAddress) {
          continue;
        }
        if (p.socketId !== socketId && result.forwardMessageToSockets.indexOf(p.socketId) < 0) {
          result.forwardMessageToSockets.push(p.socketId);
        }
      }
    }
    console.log("ChannelServer: Forwarding channel message to " + result.forwardMessageToSockets.length + " sockets", socket.userId, socket.socketId, channelAddress);
    return result;
  }

  private async handleReceivedControlMessage(messageInfo: ChannelMessage, socket: SocketInfo): Promise<MessageHandlingDirective> {
    if (messageInfo.controlMessagePayload && messageInfo.controlMessagePayload.jsonMessage && messageInfo.controlMessagePayload.jsonMessage.type !== 'ping-reply') {
      console.log("ChannelServer: Control message received", socket.userId, socket.socketId, messageInfo.controlMessagePayload ? JSON.stringify(messageInfo.controlMessagePayload.jsonMessage) : null);
    }
    // These are messages from the client to the server to perform control functions, such as joining or reconnecting to a channel.
    // The format of all control messages is a JSON-encoded payload.
    const controlRequest = messageInfo.controlMessagePayload.jsonMessage as ControlChannelMessage;
    if (!controlRequest || !controlRequest.type) {
      const result: MessageHandlingDirective = {
        forwardMessageToSockets: [],
        deliverControlMessages: [this.createErrorMessageDirective(null, socket.socketId, 400, "Invalid control message", null)]
      };
      return result;
    }
    switch (controlRequest.type) {
      case 'join':
        return await this.handleJoinRequest(controlRequest, socket);
      case 'leave':
        return await this.handleLeaveRequest(controlRequest, socket);
      case 'history':
        return await this.handleHistoryRequest(controlRequest, socket);
      case 'ping':
        return await this.handlePingRequest(controlRequest, socket);
      case 'ping-reply':
        return await this.handlePingReply(controlRequest, socket);
      default:
        const result: MessageHandlingDirective = {
          forwardMessageToSockets: [],
          deliverControlMessages: [this.createErrorMessageDirective(null, socket.socketId, 400, "Unknown or invalid control message type", null)]
        };
        return result;
    }
  }

  private async handleJoinRequest(controlRequest: ControlChannelMessage, socket: SocketInfo): Promise<MessageHandlingDirective> {
    const result: MessageHandlingDirective = {
      forwardMessageToSockets: [],
      deliverControlMessages: []
    };
    const requestDetails = controlRequest.details as JoinRequestDetails;
    if (!requestDetails || !requestDetails.channelAddress) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 400, "Join request details missing or invalid", requestDetails ? requestDetails.channelAddress : null));
      return result;
    }
    const channelRecord = await db.findChannelById(requestDetails.channelAddress);
    if (!channelRecord) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 404, "No such channel", null));
      return result;
    }
    if (channelRecord.transportUrl !== this.transportUrl) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 404, "This switch is not responsible for this channel", requestDetails ? requestDetails.channelAddress : null));
      return result;
    }
    if (socket.participantCodeByChannelAddress[channelRecord.channelAddress]) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 409, "This channel is already active on this socket.  You cannot join again on this socket.", requestDetails ? requestDetails.channelAddress : null));
      return result;
    }
    const channelMemberRecord = await db.findChannelMember(channelRecord.channelAddress, socket.userId);
    if (!channelMemberRecord || channelMemberRecord.status !== 'active') {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 403, "You are not a member", null));
      return;
    }
    let channelInfo = this.channelInfoByAddress[channelRecord.channelAddress];
    if (!channelInfo) {
      // This channel has no active participants right now.  So we'll allocate a new code for it
      channelInfo = {
        code: this.allocateChannelCode(),
        channelAddress: channelRecord.channelAddress,
        participantsByCode: {},
        lastAllocatedCode: 0,
        contract: channelRecord.contract,
        creatorAddress: channelRecord.creatorAddress
      };
      this.channelInfoByAddress[channelRecord.channelAddress] = channelInfo;
      this.channelAddressByCode[channelInfo.code] = channelRecord.channelAddress;
    }
    const now = Date.now();
    const memberIdentity = channelMemberRecord.identity;
    await db.updateChannelMemberActive(channelMemberRecord.channelAddress, channelMemberRecord.userId, 'active', now, null);
    const participant: ParticipantInfo = {
      memberIdentity: memberIdentity,
      participantIdentityDetails: requestDetails.participantIdentityDetails,
      code: this.allocateParticipantCode(channelInfo),
      channelAddress: channelRecord.channelAddress,
      userId: socket.userId,
      socketId: socket.socketId,
      isCreator: socket.userId === channelRecord.creatorUserId,
      memberSince: channelMemberRecord.added,
      lastActive: now
    };
    socket.participantCodeByChannelAddress[channelRecord.channelAddress] = participant.code.toString();
    channelInfo.participantsByCode[participant.code] = participant;
    const joinResponseDetails: JoinResponseDetails = {
      channelAddress: channelRecord.channelAddress,
      channelCode: channelInfo.code,
      participantAddress: participant.memberIdentity.address,
      participantCode: participant.code,
      participants: []
    };
    const joinResponse: ControlChannelMessage = {
      requestId: controlRequest.requestId,
      type: 'join-reply',
      details: joinResponseDetails
    };
    if (channelInfo.contract.channelContract.options.topology === 'many-to-many') {
      for (const code of Object.keys(channelInfo.participantsByCode)) {
        const p = channelInfo.participantsByCode[code];
        const info: ChannelParticipantInfo = {
          code: p.code,
          participantIdentity: { memberIdentity: memberIdentity, participantDetails: requestDetails.participantIdentityDetails },
          isCreator: p.userId === channelRecord.creatorUserId,
          isYou: p.memberIdentity.address === participant.memberIdentity.address,
          memberSince: p.memberSince,
          lastActive: p.lastActive
        };
        joinResponseDetails.participants.push(info);
      }
    }
    const joinResponseDirective: ControlMessageDirective = {
      controlMessage: joinResponse,
      socketId: socket.socketId
    };
    result.deliverControlMessages.push(joinResponseDirective);

    let notificationCount = 0;
    // Now we also need to tell all of the other participants about the new participant, if many-to-many
    if (channelInfo.contract.channelContract.options.topology === 'many-to-many') {
      for (const code of Object.keys(channelInfo.participantsByCode)) {
        const p = channelInfo.participantsByCode[code];
        if (p.socketId !== socket.socketId) {
          const joinNotificationDetails: JoinNotificationDetails = {
            channelAddress: channelInfo.channelAddress,
            memberIdentity: memberIdentity,
            participantCode: participant.code,
            participantDetails: participant.participantIdentityDetails
          };
          const notification: ControlChannelMessage = {
            type: 'join-notification',
            details: joinNotificationDetails
          };
          const notificationDirective: ControlMessageDirective = {
            controlMessage: notification,
            socketId: p.socketId
          };
          result.deliverControlMessages.push(notificationDirective);
          notificationCount++;
        }
      }
    }
    console.log("ChannelServer: Completed join and notified " + notificationCount, socket.userId, socket.socketId, controlRequest.requestId, channelInfo.channelAddress, channelInfo.code, participant.memberIdentity.address, participant.code);
    return result;
  }

  private async handleLeaveRequest(controlRequest: ControlChannelMessage, socket: SocketInfo): Promise<MessageHandlingDirective> {
    const result: MessageHandlingDirective = {
      forwardMessageToSockets: [],
      deliverControlMessages: []
    };
    const requestDetails = controlRequest.details as LeaveRequestDetails;
    if (!requestDetails || !requestDetails.channelAddress) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 400, "Leave request details missing or invalid", requestDetails.channelAddress));
      return result;
    }
    const channelRecord = await db.findChannelById(requestDetails.channelAddress);
    if (!channelRecord) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 404, "No such channel", requestDetails.channelAddress));
      return result;
    }
    const channelInfo = this.channelInfoByAddress[channelRecord.channelAddress];
    if (!channelInfo) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 403, "This channel is not active", requestDetails.channelAddress));
      return result;
    }
    const participantCode = socket.participantCodeByChannelAddress[channelRecord.channelAddress];
    if (!participantCode) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 403, "You can't leave because you are not a participant", requestDetails.channelAddress));
      return result;
    }
    const participant = channelInfo.participantsByCode[participantCode];
    if (!participant) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 403, "You cannot leave a channel that you haven't joined.", requestDetails.channelAddress));
      return result;
    }
    if (requestDetails.permanently) {
      await db.updateChannelMemberActive(channelInfo.channelAddress, socket.userId, 'inactive', Date.now());
    }
    const notificationCount = await this.handleParticipantLeft(channelInfo, participant, socket, requestDetails.permanently);
    const leaveResponse: ControlChannelMessage = {
      requestId: controlRequest.requestId,
      type: 'leave-reply',
      details: {}
    };
    const leaveResponseDirective: ControlMessageDirective = {
      controlMessage: leaveResponse,
      socketId: socket.socketId
    };
    result.deliverControlMessages.push(leaveResponseDirective);
    console.log("ChannelServer: Completed leave and notified " + notificationCount, socket.userId, socket.socketId, controlRequest.requestId, channelInfo.channelAddress, channelInfo.code, participant.memberIdentity.address, participant.code);
    return result;
  }

  private async updateChannelMemberActive(channelAddress: string, code: string): Promise<void> {
    const now = Date.now();
    const channelInfo = this.channelInfoByAddress[channelAddress];
    if (channelInfo) {
      const participant = channelInfo.participantsByCode[code];
      if (participant) {
        participant.lastActive = now;
        await db.updateChannelMemberActive(channelAddress, participant.memberIdentity.address, 'active', now);
      }
    }
  }

  private async handleHistoryRequest(controlRequest: ControlChannelMessage, socket: SocketInfo): Promise<MessageHandlingDirective> {
    const result: MessageHandlingDirective = {
      forwardMessageToSockets: [],
      deliverControlMessages: []
    };
    const requestDetails = controlRequest.details as HistoryRequestDetails;
    if (!requestDetails || !requestDetails.channelAddress) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 400, "History request details missing or invalid", requestDetails.channelAddress));
      return result;
    }
    const channelRecord = await db.findChannelById(requestDetails.channelAddress);
    if (!channelRecord) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 404, "No such channel", requestDetails.channelAddress));
      return result;
    }
    const channelMemberRecord = await db.findChannelMember(channelRecord.channelAddress, socket.userId);
    if (!channelMemberRecord || channelMemberRecord.status !== 'active') {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 403, "You are not a member", null));
      return;
    }
    const totalCount = await db.countMessages(channelRecord.channelAddress, requestDetails.before, requestDetails.after);
    const count = totalCount < 100 ? totalCount : 100;
    const responseDetails: HistoryResponseDetails = {
      count: count,
      total: totalCount
    };
    const response: ControlChannelMessage = {
      requestId: controlRequest.requestId,
      type: 'history-reply',
      details: responseDetails
    };
    const directive: ControlMessageDirective = {
      controlMessage: response,
      socketId: socket.socketId
    };
    result.deliverControlMessages.push(directive);
    void this.processHistoryRequestAsync(channelRecord, socket, requestDetails, responseDetails.count);
    await this.updateChannelMemberActive(channelRecord.channelAddress, channelMemberRecord.identity.address);
    return result;
  }

  private async processHistoryRequestAsync(channelRecord: ChannelRecord, socket: SocketInfo, requestDetails: HistoryRequestDetails, maxCount: number): Promise<void> {
    const cursor = db.findMessages(channelRecord.channelAddress, requestDetails.before, requestDetails.after);
    let count = 0;
    while (cursor.hasNext && count < maxCount && socket.isOpen) {
      const message: MessageRecord = await cursor.next();
      const values = message.contents.split(',');
      const messageBytes = new Uint8Array(values.length);
      const view = new DataView(messageBytes.buffer, messageBytes.byteOffset);
      for (let i = 0; i < values.length; i++) {
        view.setUint8(i, Number(values[i]));
      }
      const details: HistoryMessageDetails = {
        timestamp: message.timestamp,
        channelAddress: channelRecord.channelAddress,
        senderAddress: message.senderAddress
      };
      const historyMessage = ChannelMessageUtils.serializeControlMessage(null, 'history-message', details, messageBytes);
      if (!await this.transport.deliverMessage(historyMessage, socket.socketId)) {
        break;
      }
      await Utils.sleep(10);
      while (this.transport.getBufferedAmount(socket.socketId) > MAX_HISTORY_BUFFERED_SIZE) {
        await Utils.sleep(10);
      }
      count++;
    }
  }

  private async handlePingRequest(controlRequest: ControlChannelMessage, socket: SocketInfo): Promise<MessageHandlingDirective> {
    const result: MessageHandlingDirective = {
      forwardMessageToSockets: [],
      deliverControlMessages: []
    };
    const requestDetails = controlRequest.details as PingRequestDetails;
    const response: ControlChannelMessage = {
      requestId: controlRequest.requestId,
      type: 'ping-reply',
      details: {}
    };
    const directive: ControlMessageDirective = {
      controlMessage: response,
      socketId: socket.socketId
    };
    result.deliverControlMessages.push(directive);
    return result;
  }

  private async handlePingReply(controlRequest: ControlChannelMessage, socket: SocketInfo): Promise<MessageHandlingDirective> {
    const result: MessageHandlingDirective = {
      forwardMessageToSockets: [],
      deliverControlMessages: []
    };
    if (controlRequest.requestId === 'p' + socket.pingId) {
      socket.lastPingReply = Date.now();
    } else {
      console.warn("ChannelServer: received ping-reply with unexpected requestId.  Ignoring", controlRequest.requestId, socket.socketId, socket.userId);
    }
    return result;
  }

  private fillAllOptions(options: ChannelOptions): void {
    options.history = typeof options.history === 'undefined' ? true : options.history;
    options.priority = typeof options.priority === 'undefined' ? false : options.priority;
    options.maxDataRate = typeof options.maxDataRate === 'undefined' ? 65535 : options.maxDataRate;
    options.maxHistoryCount = typeof options.maxHistoryCount === 'undefined' ? 1000 : options.maxHistoryCount;
    options.maxHistorySeconds = typeof options.maxHistorySeconds === 'undefined' ? 1000 * 60 * 60 * 24 * 90 : options.maxHistorySeconds;
    options.maxMessageRate = typeof options.maxMessageRate === 'undefined' ? 100 : options.maxMessageRate;
    options.maxParticipants = typeof options.maxParticipants === 'undefined' ? 1000 : options.maxParticipants;
    options.maxPayloadSize = typeof options.maxPayloadSize === 'undefined' ? 65535 : options.maxPayloadSize;
    options.topology = typeof options.topology === 'undefined' ? 'many-to-many' : options.topology;
  }

  private allocateChannelCode(): number {
    let code = this.lastAllocatedChannelCode + 1;
    while (true) {
      if (code > 1 << 30) {
        code = 1;
      }
      if (!this.channelAddressByCode[code.toString()]) {
        this.lastAllocatedChannelCode = code;
        return code;
      }
      code++;
    }
  }

  private allocateParticipantCode(channelInfo: ChannelInfo): number {
    let code = channelInfo.lastAllocatedCode + 1;
    while (true) {
      if (code > 1 << 30) {
        code = 1;
      }
      if (!channelInfo.participantsByCode[code.toString()]) {
        this.lastAllocatedChannelCode = code;
        return code;
      }
      code++;
    }
  }

  private createErrorMessageDirective(controlRequest: ControlChannelMessage, socketId: string, errorCode: number, errorMessage: string, channelAddress: string): ControlMessageDirective {
    const details: ErrorDetails = {
      statusCode: errorCode,
      errorMessage: errorMessage
    };
    if (channelAddress) {
      details.channelAddress = channelAddress;
    }
    const message: ControlChannelMessage = {
      requestId: controlRequest ? controlRequest.requestId : null,
      type: 'error',
      details: details
    };
    const result: ControlMessageDirective = {
      controlMessage: message,
      socketId: socketId
    };
    console.log("ChannelServer: Error message", socketId, errorCode, errorMessage, controlRequest ? controlRequest.requestId : null, controlRequest ? controlRequest.type : null);
    return result;
  }

  private createId(): string {
    return uuid.v4();
  }

  private processPings(): void {
    const now = Date.now();
    for (const socketId of Object.keys(this.socketInfoById)) {
      const socket = this.socketInfoById[socketId];
      if (socket.isOpen && now - socket.lastPingSent > this.pingTimeout && socket.lastPingReply < socket.lastPingSent) {
        console.warn("ChannelServer: Timeout waiting for ping-reply", socket.socketId, socket.userId);
        this.transport.closeSocket(socket.socketId);
      } else if (socket.isOpen && now - socket.lastPingSent > this.pingInterval) {
        process.nextTick(() => {
          void this.sendPing(socket);
        });
      }
    }
  }

  private async sendPing(socket: SocketInfo): Promise<void> {
    const details: PingRequestDetails = {
      interval: this.pingInterval
    };
    socket.pingId++;
    const message = ChannelMessageUtils.serializeControlMessage('p' + socket.pingId, 'ping', details);
    await this.transport.deliverMessage(message, socket.socketId);
    socket.lastPingSent = Date.now();
  }

  private createToken(length = 24): string {
    let result = '';
    const array = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      const letter = TOKEN_LETTERS.charAt(array[i] % TOKEN_LETTERS.length);
      result += letter;
    }
    return result;
  }
}

interface ParticipantInfo {
  memberIdentity: ChannelMemberIdentity;
  participantIdentityDetails: any;
  code: number;
  channelAddress: string;
  userId: string;
  socketId: string;
  isCreator: boolean;
  memberSince: number;
  lastActive: number;
}

interface ChannelInfo {
  code: number;
  channelAddress: string;
  participantsByCode: { [code: string]: ParticipantInfo };
  lastAllocatedCode: number;
  contract: ChannelContractDetails;
  creatorAddress: string;
}

interface SocketInfo {
  socketId: string;
  userId: string;
  participantCodeByChannelAddress: { [channelAddress: string]: string };
  isOpen: boolean;
  lastPingSent: number;
  lastPingReply: number;
  pingId: number;
  lastTimestampReceived: number;
}
