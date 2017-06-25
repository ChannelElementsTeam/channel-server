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
import { Utils } from "./utils";
import { ChannelIdentityUtils } from "./common/channel-identity-utils";
import { ProviderServicesListResponse, ChannelShareRequest, ChannelShareResponse, ChannelShareCodeResponse, ChannelAcceptRequest, ChannelCreateRequest, ChannelsListRequest, ChannelsListResponse } from "./common/channel-service-rest";
import { SignedAddress, SignedFullIdentity, SignedBasicIdentity, ChannelMemberInfo } from "./common/channel-service-identity";
import { ChannelDeletedNotificationDetails, PingRequestDetails, ControlChannelMessage, ErrorDetails, HistoryMessageDetails, HistoryRequestDetails, HistoryResponseDetails, LeaveRequestDetails, JoinNotificationDetails, ChannelParticipantInfo, JoinResponseDetails, JoinRequestDetails, LeaveNotificationDetails } from "./common/channel-service-control";
import { ChannelMessageUtils, ChannelMessage } from "./common/channel-message-utils";
import { ChannelContractDetails, ChannelOptions, BasicChannelInformation, ChannelInformation } from "./common/channel-service-channel";

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
    this.app.post(restRelativeBaseUrl + '/channels/create', (request: Request, response: Response) => {
      void this.handleCreateChannel(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/channels/:cid/get', (request: Request, response: Response) => {
      void this.handleGetChannel(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/channels/:cid/share', (request: Request, response: Response) => {
      void this.handleShare(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/channels/:cid/accept', (request: Request, response: Response) => {
      void this.handleAccept(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/channels/:cid/delete', (request: Request, response: Response) => {
      void this.handleDeleteChannel(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/channels/list', (request: Request, response: Response) => {
      void this.handleGetChannelList(request, response);
    });
    this.app.get('/i/:share', (request: Request, response: Response) => {
      void this.handleGetInvitation(request, response);
    });
  }

  getServicesList(): ProviderServicesListResponse {
    const result: ProviderServicesListResponse = {
      providerUrl: this.providerUrl,
      serviceHomeUrl: this.homeUrl,
      accountUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/account'),
      createChannelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/create'),
      channelListUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels')
    };
    return result;
  }

  private validateSignedAddress(signedAddress: SignedAddress, expectedSignedAt: number, publicKey: string, request: Request, response: Response): boolean {
    if (!signedAddress || !signedAddress.info || !signedAddress.info.address || !signedAddress.info.signedAt || !signedAddress.signature) {
      response.status(400).send("Invalid signed address");
      return false;
    }
    if (!ChannelIdentityUtils.verifySignedAddress(signedAddress, publicKey, expectedSignedAt)) {
      response.status(400).send("Invalid address signature");
      return false;
    }
  }

  private async validateShareRequest(request: Request, response: Response): Promise<ShareRequestInfo> {
    const shareRequest = request.body as ChannelShareRequest;
    if (!shareRequest || !shareRequest.identity || !shareRequest.identity.info || !shareRequest.identity.info.address) {
      response.status(400).send("Invalid share request");
      return null;
    }
    const channelAddress = request.params.cid;
    const channel = await db.findChannelByAddress(channelAddress);
    if (!channel || channel.status !== 'active') {
      response.status(404).send("No such channel");
      return null;
    }
    const channelMember = await db.findChannelMemberByChannelAndAddress(channelAddress, shareRequest.identity.info.address, 'active');
    if (!channelMember || channelMember.status !== 'active') {
      response.status(403).send("You are not a channel member");
      return null;
    }
    if (!this.validateSignedAddress(shareRequest.identity, Date.now(), channelMember.identity.info.publicKey, request, response)) {
      return null;
    }
    return {
      shareRequest: shareRequest,
      channelRecord: channel,
      memberRecord: channelMember
    };
  }

  private async handleShare(request: Request, response: Response): Promise<void> {
    const shareRequestInfo = await this.validateShareRequest(request, response);
    if (!shareRequestInfo) {
      console.warn("ChannelServer: share request not valid");
      return;
    }
    let invitation: ChannelInvitation;
    let count = 0;
    while (count++ < 1000) {
      const invitationId = this.createToken(6);
      try {
        invitation = await db.insertInvitation(invitationId, shareRequestInfo.memberRecord.identity.info.address, shareRequestInfo.channelRecord.channelAddress, shareRequestInfo.shareRequest.details);
      } catch (err) {
        // Possible duplicate on id, so will just try again
      }
    }
    const reply: ChannelShareResponse = {
      shareCodeUrl: url.resolve(this.restBaseUrl, '/i/' + invitation.id)
    };
    console.log("ChannelServer: invitation created", shareRequestInfo.memberRecord.identity.info.address, shareRequestInfo.channelRecord.channelAddress);
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
      const channelRecord = await db.findChannelByAddress(invitation.channelAddress);
      if (!channelRecord || channelRecord.status !== 'active') {
        response.status(404).send("The channel is no longer available");
        return;
      }
      const channelInfo = await this.getBasicChannelInfo(channelRecord);
      const reply: ChannelShareCodeResponse = {
        providerUrl: this.providerUrl,
        acceptChannelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress + '/accept'),
        invitationDetails: invitation.details,
        invitationId: invitation.id,
        channelInfo: channelInfo
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

  private authenticateIdentity(identity: SignedFullIdentity, expectedSigningTimestamp: number, request: Request, response: Response): boolean {
    if (!identity.info || !identity.signature) {
      response.status(401).send("Invalid signed identity");
      return false;
    }
    if (!identity.info.address || !identity.info.publicKey || !identity.info.signedAt) {
      response.status(400).send("Invalid identity: missing mandatory fields");
      return false;
    }
    if (!ChannelIdentityUtils.verifyIdentityObject(identity, expectedSigningTimestamp)) {
      response.status(403).send("Invalid signature");
      return false;
    }
    return true;
  }

  private async validateAcceptRequest(request: Request, response: Response): Promise<AcceptRequestInfo> {
    const acceptRequest = request.body as ChannelAcceptRequest;
    if (!acceptRequest || !acceptRequest.identity || !acceptRequest.invitationId || !acceptRequest.memberServicesContract) {
      response.status(400).send("Invalid accept request");
      return null;
    }
    const invitation = await db.findInvitationById(acceptRequest.invitationId);
    if (!invitation) {
      response.status(404).send("No such invitation");
      return null;
    }
    if (!this.authenticateIdentity(acceptRequest.identity, Date.now(), request, response)) {
      response.status(401).send("Invalid identity");
      return null;
    }
    return {
      acceptRequest: acceptRequest,
      invitation: invitation
    };
  }

  private async handleAccept(request: Request, response: Response): Promise<void> {
    const acceptRequestInfo = await this.validateAcceptRequest(request, response);
    if (!acceptRequestInfo) {
      console.warn("ChannelServer: accept request not valid");
      return;
    }

    const channelRecord = await db.findChannelByAddress(acceptRequestInfo.invitation.channelAddress);
    if (!channelRecord || channelRecord.status !== 'active') {
      response.status(404).send("The shared channel no longer exists");
      return;
    }
    await db.insertChannelMember(channelRecord.channelAddress, acceptRequestInfo.acceptRequest.identity, acceptRequestInfo.acceptRequest.memberServicesContract, 'active');
    await this.handleGetChannelResponse(channelRecord, acceptRequestInfo.acceptRequest.identity, request, response);
    console.log("ChannelServer: invitation used and channel joined", acceptRequestInfo.acceptRequest.identity.info.address, acceptRequestInfo.invitation.id, channelRecord.channelAddress);
  }

  private async validateCreateRequest(request: Request, response: Response): Promise<ChannelCreateRequest> {
    const createRequest = request.body as ChannelCreateRequest;
    if (!createRequest || !createRequest.channelContract || !createRequest.identity || !createRequest.memberServicesContract) {
      response.status(400).send("Invalid create request");
      return null;
    }
    if (!this.authenticateIdentity(createRequest.identity, Date.now(), request, response)) {
      response.status(401).send("Invalid identity");
      return null;
    }
    return createRequest;
  }

  private async handleCreateChannel(request: Request, response: Response): Promise<void> {
    const channelRequest = await this.validateCreateRequest(request, response);
    if (!channelRequest) {
      return;
    }
    // This is assigning the transport responsibility for this channel to my own server.  When running with multiple
    // servers, this means that I'm balancing the switching load over those servers, too.  We just have to make sure
    // that REST requests that need to be handled by the server doing the transport arrive on the correct server.
    const channelAddress = ChannelIdentityUtils.generateValidAddress();
    this.fillAllOptions(channelRequest.channelContract.serviceContract.options);
    const channelRecord = await db.insertChannel(channelAddress, channelRequest.identity.info.address, channelRequest.identity.info.address, this.transportUrl, channelRequest.channelContract, 'active');
    const now = Date.now();
    const channelInfo: ChannelInfo = {
      code: this.allocateChannelCode(),
      channelAddress: channelRecord.channelAddress,
      memberAddress: channelRequest.identity.info.address,
      participantsByCode: {},
      lastAllocatedCode: 0,
      contract: channelRecord.contract,
      creatorAddress: channelRequest.identity.info.address
    };
    this.channelInfoByAddress[channelRecord.channelAddress] = channelInfo;
    this.channelAddressByCode[channelInfo.code] = channelRecord.channelAddress;
    await db.insertChannelMember(channelAddress, channelRequest.identity, channelRequest.memberServicesContract, 'active');
    const reply = await this.handleGetChannelResponse(channelRecord, channelRequest.identity, request, response);
    console.log("ChannelServer: channel created", channelRequest.identity.info.address, channelAddress);
  }

  private async validateChannelRequest(channelAddress: string, request: Request, response: Response): Promise<ChannelRequestInfo> {
    const channel = await db.findChannelByAddress(channelAddress);
    if (!channel || channel.status !== 'active') {
      response.status(404).send("No such channel");
      return null;
    }
    const signedAddress = request.body as SignedAddress;
    if (!signedAddress || !signedAddress.info || !signedAddress.info.address) {
      response.status(400).send("Invalid or missing address");
      return null;
    }
    const channelMember = await db.findChannelMemberByChannelAndAddress(channelAddress, signedAddress.info.address, 'active');
    if (!channelMember || channelMember.status !== 'active') {
      response.status(403).send("You are not a channel member");
      return null;
    }
    if (!this.validateSignedAddress(signedAddress, Date.now(), channelMember.identity.info.publicKey, request, response)) {
      response.status(401).send("Invalid identity");
      return null;
    }
    return {
      channelRecord: channel,
      memberRecord: channelMember
    };
  }

  private async handleGetChannel(request: Request, response: Response): Promise<void> {
    const requestInfo = await this.validateChannelRequest(request.params.cid, request, response);
    if (!requestInfo) {
      return;
    }
    const reply = await this.handleGetChannelResponse(requestInfo.channelRecord, requestInfo.memberRecord.identity, request, response);
    console.log("ChannelServer: channel fetched", requestInfo.memberRecord.identity.info.address, requestInfo.channelRecord.channelAddress);
  }

  private async handleDeleteChannel(request: Request, response: Response): Promise<void> {
    const requestInfo = await this.validateChannelRequest(request.params.cid, request, response);
    if (!requestInfo) {
      return;
    }
    if (requestInfo.channelRecord.creatorAddress !== requestInfo.memberRecord.identity.info.address) {
      response.status(403).send("You must be the creator to delete a channel");
      return;
    }
    await db.updateChannelStatus(requestInfo.channelRecord.channelAddress, 'deleted');
    response.json({});
    console.log("ChannelServer: channel deleted", requestInfo.memberRecord.identity.info.address, requestInfo.channelRecord.channelAddress);
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

  private async getBasicChannelInfo(channelRecord: ChannelRecord): Promise<BasicChannelInformation> {
    const result: BasicChannelInformation = {
      channelAddress: channelRecord.channelAddress,
      contract: channelRecord.contract,
      memberCount: await db.countChannelMembers(channelRecord.channelAddress, 'active'),
      created: channelRecord.created
    };
    return result;
  }

  private async handleGetChannelResponse(channelRecord: ChannelRecord, identity: SignedAddress, request: Request, response: Response): Promise<ChannelInformation> {
    const reply: ChannelInformation = {
      channelAddress: channelRecord.channelAddress,
      transportUrl: channelRecord.transportUrl,
      channelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress + '/get'),
      shareChannelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress + '/share'),
      contract: channelRecord.contract,
      isCreator: channelRecord.creatorAddress === identity.info.address,
      memberCount: await db.countChannelMembers(channelRecord.channelAddress, 'active'),
      members: [],
      created: channelRecord.created,
      lastUpdated: channelRecord.lastUpdated
    };
    if (reply.isCreator) {
      reply.deleteChannelUrl = url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress + '/delete');
    }
    const members = await db.findChannelMembers(channelRecord.channelAddress, 'active', 8);
    for (const member of members) {
      const m: ChannelMemberInfo = {
        identity: member.identity,
        isCreator: member.identity.info.address === channelRecord.creatorAddress,
        memberSince: member.added,
        lastActive: member.lastActive,
      };
      reply.members.push(m);
    }
    response.json(reply);
    return reply;
  }

  private async handleGetChannelList(request: Request, response: Response): Promise<void> {
    const listRequest = request.body as ChannelsListRequest;
    if (!listRequest || !listRequest.identity || !listRequest.identity.info || !listRequest.identity.signature) {
      response.status(400).send("Missing or invalid identity");
      return;
    }
    if (!ChannelIdentityUtils.verifyIdentityObject(listRequest.identity, Date.now())) {
      response.status(403).send("Invalid identity");
      return;
    }
    const memberAddress = listRequest.identity.info.address;
    const lastActiveBefore = listRequest.lastActiveBefore ? listRequest.lastActiveBefore : 0;
    const limit = listRequest.limit ? listRequest.limit : 50;
    const count = await db.countChannelMembersByAddress(memberAddress, 'active', lastActiveBefore);
    const memberRecords = await db.findChannelMembersByAddress(memberAddress, 'active', lastActiveBefore, limit);
    const reply: ChannelsListResponse = {
      total: count,
      channels: []
    };
    for (const record of memberRecords) {
      const channelRecord = await db.findChannelByAddress(record.channelAddress);
      if (channelRecord && channelRecord.status === 'active') {
        const channelDetails: ChannelInformation = {
          channelAddress: record.channelAddress,
          transportUrl: channelRecord.transportUrl,
          channelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress) + '/get',
          shareChannelUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress + '/share'),
          contract: channelRecord.contract,
          isCreator: channelRecord.creatorAddress === memberAddress,
          memberCount: await db.countChannelMembers(channelRecord.channelAddress, 'active'),
          members: [],
          created: channelRecord.created,
          lastUpdated: channelRecord.lastUpdated
        };
        if (channelDetails.isCreator) {
          channelDetails.deleteChannelUrl = url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/channels/' + channelRecord.channelAddress + '/delete');
        }
        const members = await db.findChannelMembers(channelRecord.channelAddress, 'active');
        for (const member of members) {
          const info: ChannelMemberInfo = {
            identity: member.identity,
            isCreator: member.identity.info.address === channelRecord.creatorAddress,
            memberSince: member.added,
            lastActive: member.lastActive,
          };
          channelDetails.members.push(info);
        }
        reply.channels.push(channelDetails);
      }
    }
    console.log("ChannelServer: channel list fetched", memberAddress, lastActiveBefore, limit, count);
    response.json(reply);
  }

  async handleSocketConnectRequest(request: Request): Promise<string> {
    const socketId = this.createId();
    const now = Date.now();
    this.socketInfoById[socketId] = {
      socketId: socketId,
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
    console.log("ChannelServer: socket connected", socketId);
    return socketId;
  }

  async handleSocketClosed(socketId: string): Promise<void> {
    const socketInfo = this.socketInfoById[socketId];
    if (socketInfo) {
      socketInfo.isOpen = false;
      console.log("ChannelServer: handleSocketClosed", socketId);
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
    if (channel.contract.serviceContract.options.topology === 'many-to-many') {
      for (const code of Object.keys(channel.participantsByCode)) {
        if (code !== participant.code.toString()) {
          const p = channel.participantsByCode[code];
          const notificationDetails: LeaveNotificationDetails = {
            channelAddress: channel.channelAddress,
            participantAddress: participant.memberIdentity.info.address,
            participantCode: participant.code,
            permanently: permanently
          };
          const message = ChannelMessageUtils.serializeControlMessage(null, 'leave-notification', notificationDetails);
          await this.transport.deliverMessage(message, p.socketId);
          count++;
          console.log("ChannelServer: Sending leave-notification", p.socketId, notificationDetails.channelAddress, notificationDetails.participantAddress);
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
    if (channelInfo.contract.serviceContract.options.topology === 'one-to-many' && participant.memberIdentity.info.address !== channelInfo.creatorAddress) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(null, socketId, 403, "This is a one-to-many channel.  Only the creator is allowed to send messages.", channelAddress));
      return result;
    }
    if (messageInfo.history && channelInfo.contract.serviceContract.options.history) {
      await db.insertMessage(channelAddress, participant.memberIdentity.info.address, messageInfo.timestamp, messageInfo.serializedMessage.byteLength, messageInfo.serializedMessage);
    }
    await this.updateChannelMemberActive(channelAddress, participant.code.toString());
    const socketIds: string[] = [];
    for (const code of Object.keys(channelInfo.participantsByCode)) {
      if (code !== messageInfo.senderCode.toString()) {
        const p = channelInfo.participantsByCode[code];
        if (channelInfo.contract.serviceContract.options.topology === 'many-to-one' && p.memberIdentity.info.address !== channelInfo.creatorAddress && participant.memberIdentity.info.address !== channelInfo.creatorAddress) {
          continue;
        }
        if (p.socketId !== socketId && result.forwardMessageToSockets.indexOf(p.socketId) < 0) {
          result.forwardMessageToSockets.push(p.socketId);
        }
      }
    }
    console.log("ChannelServer: Forwarding channel message to " + result.forwardMessageToSockets.length + " sockets", socket.socketId, channelAddress);
    return result;
  }

  private async handleReceivedControlMessage(messageInfo: ChannelMessage, socket: SocketInfo): Promise<MessageHandlingDirective> {
    if (messageInfo.controlMessagePayload && messageInfo.controlMessagePayload.jsonMessage && messageInfo.controlMessagePayload.jsonMessage.type !== 'ping-reply') {
      console.log("ChannelServer: Control message received", socket.socketId, messageInfo.controlMessagePayload ? JSON.stringify(messageInfo.controlMessagePayload.jsonMessage) : null);
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
    if (!requestDetails || !requestDetails.channelAddress || !requestDetails.memberIdentity || !requestDetails.memberIdentity.info) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 400, "Join request details missing or invalid", requestDetails ? requestDetails.channelAddress : null));
      return result;
    }
    const channelMemberRecord = await db.findChannelMemberByChannelAndAddress(requestDetails.channelAddress, requestDetails.memberIdentity.info.address, 'active');
    if (!channelMemberRecord) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 403, "You are not a member of this channel", requestDetails ? requestDetails.channelAddress : null));
      return result;
    }
    if (!ChannelIdentityUtils.verifySignedAddress(requestDetails.memberIdentity, channelMemberRecord.identity.info.publicKey, Date.now())) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 403, "Your signed address is not valid", requestDetails ? requestDetails.channelAddress : null));
      return result;
    }
    const channelRecord = await db.findChannelByAddress(requestDetails.channelAddress);
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
    let channelInfo = this.channelInfoByAddress[channelRecord.channelAddress];
    if (!channelInfo) {
      // This channel has no active participants right now.  So we'll allocate a new code for it
      channelInfo = {
        code: this.allocateChannelCode(),
        channelAddress: channelRecord.channelAddress,
        memberAddress: channelMemberRecord.identity.info.address,
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
    await db.updateChannelMemberActive(channelMemberRecord.channelAddress, channelMemberRecord.identity.info.address, 'active', now, null);
    const participant: ParticipantInfo = {
      memberIdentity: memberIdentity,
      participantIdentityDetails: requestDetails.participantIdentityDetails,
      code: this.allocateParticipantCode(channelInfo),
      channelAddress: channelRecord.channelAddress,
      socketId: socket.socketId,
      isCreator: channelMemberRecord.identity.info.address === channelRecord.creatorAddress,
      memberSince: channelMemberRecord.added,
      lastActive: now
    };
    socket.participantCodeByChannelAddress[channelRecord.channelAddress] = participant.code.toString();
    channelInfo.participantsByCode[participant.code] = participant;
    const joinResponseDetails: JoinResponseDetails = {
      channelAddress: channelRecord.channelAddress,
      channelCode: channelInfo.code,
      participantAddress: participant.memberIdentity.info.address,
      participantCode: participant.code,
      participants: []
    };
    const joinResponse: ControlChannelMessage = {
      requestId: controlRequest.requestId,
      type: 'join-reply',
      details: joinResponseDetails
    };
    if (channelInfo.contract.serviceContract.options.topology === 'many-to-many') {
      for (const code of Object.keys(channelInfo.participantsByCode)) {
        const p = channelInfo.participantsByCode[code];
        const info: ChannelParticipantInfo = {
          code: p.code,
          participantIdentity: { memberIdentity: memberIdentity, participantDetails: requestDetails.participantIdentityDetails },
          isCreator: p.memberIdentity.info.address === channelRecord.creatorAddress,
          isYou: p.memberIdentity.info.address === participant.memberIdentity.info.address,
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
    if (channelInfo.contract.serviceContract.options.topology === 'many-to-many') {
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
    console.log("ChannelServer: Completed join and notified " + notificationCount, socket.socketId, controlRequest.requestId, channelInfo.channelAddress, channelInfo.code, participant.memberIdentity.info.address, participant.code);
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
    const channelRecord = await db.findChannelByAddress(requestDetails.channelAddress);
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
      await db.updateChannelMemberActive(channelInfo.channelAddress, participant.memberIdentity.info.address, 'inactive', Date.now());
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
    console.log("ChannelServer: Completed leave and notified " + notificationCount, socket.socketId, controlRequest.requestId, channelInfo.channelAddress, channelInfo.code, participant.memberIdentity.info.address, participant.code);
    return result;
  }

  private async updateChannelMemberActive(channelAddress: string, code: string): Promise<void> {
    const now = Date.now();
    const channelInfo = this.channelInfoByAddress[channelAddress];
    if (channelInfo) {
      const participant = channelInfo.participantsByCode[code];
      if (participant) {
        participant.lastActive = now;
        await db.updateChannelMemberActive(channelAddress, participant.memberIdentity.info.address, 'active', now);
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
    const channelRecord = await db.findChannelByAddress(requestDetails.channelAddress);
    if (!channelRecord) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 404, "No such channel", requestDetails.channelAddress));
      return result;
    }
    const channelInfo = this.channelInfoByAddress[requestDetails.channelAddress];
    const channelMemberRecord = await db.findChannelMember(channelRecord.channelAddress, channelInfo.memberAddress);
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
    await this.updateChannelMemberActive(channelRecord.channelAddress, channelMemberRecord.identity.info.address);
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
      console.warn("ChannelServer: received ping-reply with unexpected requestId.  Ignoring", controlRequest.requestId, socket.socketId);
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
        console.warn("ChannelServer: Timeout waiting for ping-reply", socket.socketId);
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
  memberIdentity: SignedFullIdentity;
  participantIdentityDetails: any;
  code: number;
  channelAddress: string;
  socketId: string;
  isCreator: boolean;
  memberSince: number;
  lastActive: number;
}

interface ChannelInfo {
  code: number;
  channelAddress: string;
  memberAddress: string;
  participantsByCode: { [code: string]: ParticipantInfo };
  lastAllocatedCode: number;
  contract: ChannelContractDetails;
  creatorAddress: string;
}

interface SocketInfo {
  socketId: string;
  participantCodeByChannelAddress: { [channelAddress: string]: string };
  isOpen: boolean;
  lastPingSent: number;
  lastPingReply: number;
  pingId: number;
  lastTimestampReceived: number;
}

interface ShareRequestInfo {
  shareRequest: ChannelShareRequest;
  channelRecord: ChannelRecord;
  memberRecord: ChannelMemberRecord;
}

interface AcceptRequestInfo {
  acceptRequest: ChannelAcceptRequest;
  invitation: ChannelInvitation;
}

interface ChannelRequestInfo {
  channelRecord: ChannelRecord;
  memberRecord: ChannelMemberRecord;
}
