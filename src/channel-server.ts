import * as express from "express";
import { Request, Response } from 'express';
import * as net from 'net';
import * as uuid from "uuid";
import * as auth from "basic-auth";
import * as url from 'url';
import * as expressHandlebars from 'express-handlebars';
import * as moment from 'moment-timezone';

import { TextDecoder, TextEncoder } from 'text-encoding';

import { TransportServer, TransportEventHandler, MessageHandlingDirective, ControlMessageDirective } from './transport-server';
import { db } from "./db";
import { ChannelMemberRecord, ChannelRecord, MessageRecord, ChannelInvitation, RegistrationRecord, SmsBlockRecord } from './interfaces/db-records';
import { Utils } from "./utils";
import { configuration } from "./configuration";

import {
  ChannelDeletedNotificationDetails, PingRequestDetails, ControlChannelMessage, ErrorDetails, HistoryMessageDetails, HistoryRequestDetails, HistoryResponseDetails, LeaveRequestDetails,
  JoinNotificationDetails, ChannelParticipantInfo, JoinResponseDetails, JoinRequestDetails, LeaveNotificationDetails, ChannelMessageUtils, ChannelMessage, ChannelContractDetails, ChannelOptions,
  BasicChannelInformation, ChannelInformation, ChannelMemberInfo, MemberContractDetails, ProviderServiceEndpoints, ChannelServiceRequest, ChannelCreateDetails, ChannelShareDetails, ChannelGetDetails,
  ChannelAcceptDetails, ChannelsListDetails, ChannelDeleteDetails, ChannelShareCodeResponse, CHANNELS_PROTOCOL, ChannelShareResponse, ChannelDeleteResponse, ChannelsListResponse, ChannelServiceDescription,
  AddressIdentity, ChannelIdentityUtils, FullIdentity, KeyIdentity, SignedAddressIdentity, SignedKeyIdentity, ChannelParticipantIdentity, GetRegistrationDetails, GetRegistrationResponse, UpdateRegistrationDetails, NotificationSettings, NotificationTiming
} from "channels-common";
import { smsManager, SmsInboundMessageHandler } from "./sms-manager";

const TOKEN_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_HISTORY_BUFFERED_SIZE = 50000;
const MAX_FULL_IDENTITY_CLOCK_SKEW = 1000 * 60 * 5;
const DYNAMIC_BASE = '/d';
const MINIMUM_NOTIFICATION_CONSIDER_INTERVAL = 1000 * 60 * 5;
const MINIMUM_CHANNEL_NOTIFICATION_ACTIVE_INTERVAL = 1000 * 60 * 10;
const MINIMUM_CHANNEL_NOTIFICATION_INACTIVE_INTERVAL = 1000 * 60 * 60;
const DEFAULT_MIN_SMS_INTERVAL_MINS = 60;

export class ChannelServer implements TransportEventHandler, SmsInboundMessageHandler {
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

  constructor(app: express.Application, server: net.Server) {
    this.app = app;
    this.providerUrl = url.resolve(configuration.get('baseClientUri'), "/channel-elements.json");
    this.homeUrl = configuration.get('baseClientUri');
    this.restBaseUrl = configuration.get('baseClientUri');
    this.restRelativeBaseUrl = DYNAMIC_BASE;
    this.transportBaseUrl = configuration.get('baseTransportUri');
    this.transportUrl = this.transportBaseUrl + '/transport/s1';
    this.registerHandlers(this.restRelativeBaseUrl);
    this.transport = new TransportServer(app, server, this, '/transport/s1');
    this.pingInterval = configuration.get('ping.interval', 30000);
    this.pingTimeout = configuration.get('ping.timeout', 15000);

    this.app.engine('handlebars', expressHandlebars({ defaultLayout: 'main' }));
    this.app.set('view engine', 'handlebars');
  }

  async start(): Promise<void> {
    await smsManager.initialize(this.app);
    smsManager.setHandler(this);
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
    this.app.get('/channel-elements.json', (request: Request, response: Response) => {
      void this.handleProviderRequest(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/service', (request: Request, response: Response) => {
      void this.handleServiceRequest(request, response);
    });
    this.app.get('/i/:share', (request: Request, response: Response) => {
      void this.handleGetInvitation(request, response);
    });
  }

  private async handleProviderRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleProviderRequest");
    const reply: ChannelServiceDescription = {
      protocol: CHANNELS_PROTOCOL,
      provider: {
        name: "Channel Elements",
        logo: url.resolve(configuration.get('baseClientUri'), '/s/logo.png'),
        homepage: configuration.get('baseClientUri'),
        account: null,
        bankUrl: null,
        publicKey: null,
        details: {}
      },
      implementation: {
        name: "Channel Elements Reference Server",
        logo: url.resolve(configuration.get('baseClientUri'), '/s/logo.png'),
        homepage: "https://github.com/ChannelElementsTeam/channel-server",
        version: "0.1.0",
        extensions: this.getServerImplementationDetails()
      },
      serviceEndpoints: this.getServicesList()
    };
    response.json(reply);
  }

  private getServerImplementationDetails(): any {
    const result: any = {
      implementation: "Reference Implementation",
      by: "HivePoint, Inc.",
      contact: "info@hivepoint.com"
    };
    return result;
  }

  getServicesList(): ProviderServiceEndpoints {
    const result: ProviderServiceEndpoints = {
      descriptionUrl: this.providerUrl,
      homeUrl: this.homeUrl,
      restServiceUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/service'),
    };
    return result;
  }

  private async handleServiceRequest(request: Request, response: Response): Promise<void> {
    const serviceRequest = request.body as ChannelServiceRequest<SignedAddressIdentity | SignedKeyIdentity, any>;
    if (!serviceRequest || !serviceRequest.type || !serviceRequest.identity) {
      response.status(400).send("Invalid request structure");
      return;
    }
    switch (serviceRequest.type) {
      case 'create':
        await this.handleCreateRequest(request, response);
        break;
      case 'share':
        await this.handleShareRequest(request, response);
        break;
      case 'get':
        await this.handleGetRequest(request, response);
        break;
      case 'accept':
        await this.handleAcceptRequest(request, response);
        break;
      case 'delete':
        await this.handleDeleteRequest(request, response);
        break;
      case 'list':
        await this.handleListRequest(request, response);
        break;
      case 'get-registration':
        await this.handleGetRegistration(request, response);
        break;
      case 'update-registration':
        await this.handleUpdateRegistration(request, response);
        break;
      default:
        response.status(400).send("Invalid request type");
        break;
    }
  }

  private async ensureRegistration(address: string, signedIdentity: SignedKeyIdentity, identity: KeyIdentity): Promise<void> {
    const registration = await db.findRegistration(address);
    const now = Date.now();
    if (registration) {
      if (registration.status !== 'active') {
        await db.updateRegistrationStatus(address, 'active');
      }
    } else {
      await db.insertRegistration(address, signedIdentity, identity, now, now, 'active', -100, 100);
    }
  }
  private async updateLastActive(address: string): Promise<void> {
    await db.updateRegistrationLastActive(address);
  }

  private async handleCreateRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleCreateRequest");
    const createRequest = request.body as ChannelServiceRequest<SignedKeyIdentity, ChannelCreateDetails>;
    const fullIdentity = await this.validateFullIdentity(createRequest.identity, response);
    if (!fullIdentity) {
      return;
    }
    // console.log("Full Identity---------------------------------------------");
    // console.log(JSON.stringify(fullIdentity, null, 2));
    // console.log("Full Identity---------------------------------------------");

    if (!await this.validateChannelContractDetails(createRequest.details.channelContract, response)) {
      return;
    }
    if (!this.validateMemberContract(createRequest.details.memberContract, response)) {
      return;
    }
    await this.ensureRegistration(fullIdentity.address, createRequest.identity, fullIdentity);
    await this.updateLastActive(fullIdentity.address);
    await this.createChannel(createRequest.identity, fullIdentity, createRequest.details, request, response);
  }

  private async handleShareRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleShareRequest");
    const shareRequest = request.body as ChannelServiceRequest<SignedAddressIdentity, ChannelShareDetails>;
    const channelMemberRecord = await this.getChannelMemberRecord(shareRequest.details.channel, shareRequest.identity.address);
    if (!channelMemberRecord) {
      response.status(403).send("You are not a member of this channel");
      return;
    }
    if (!this.validateAddressIdentity(shareRequest.identity, channelMemberRecord, response)) {
      return;
    }
    const channelRecord = await this.getChannelRecord(channelMemberRecord.channelAddress);
    await this.updateLastActive(channelMemberRecord.identity.address);
    await this.shareChannel(channelRecord, channelMemberRecord, shareRequest.details, request, response);
  }

  private async handleGetRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleGetRequest");
    const getRequest = request.body as ChannelServiceRequest<SignedAddressIdentity, ChannelGetDetails>;
    const channelMemberRecord = await this.getChannelMemberRecord(getRequest.details.channel, getRequest.identity.address);
    if (!channelMemberRecord) {
      response.status(403).send("You are not a member of this channel");
      return;
    }
    if (!this.validateAddressIdentity(getRequest.identity, channelMemberRecord, response)) {
      return;
    }
    const channelRecord = await this.getChannelRecord(getRequest.details.channel);
    await this.updateLastActive(channelMemberRecord.identity.address);
    await this.getChannel(channelRecord, channelMemberRecord, request, response);
  }
  private async handleAcceptRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleAcceptRequest");
    const acceptRequest = request.body as ChannelServiceRequest<SignedKeyIdentity, ChannelAcceptDetails>;
    const fullIdentity = await this.validateFullIdentity(acceptRequest.identity, response);
    if (!fullIdentity) {
      return;
    }
    const invitation = await this.getInvitation(acceptRequest.details.invitationId);
    if (!invitation) {
      response.status(404).send("Invalid invitation");
      return;
    }
    const channelRecord = await this.getChannelRecord(invitation.channelAddress);
    if (!channelRecord || channelRecord.status !== 'active') {
      response.status(403).send("Invitation is invalid or expired");
    }
    if (!await this.validateMemberContract(acceptRequest.details.memberContract, response)) {
      return;
    }
    const existingMemberRecord = await this.getChannelMemberRecord(channelRecord.channelAddress, fullIdentity.address);
    if (existingMemberRecord) {
      response.status(409).send("You are already a member of this channel");
      return;
    }
    await this.ensureRegistration(fullIdentity.address, acceptRequest.identity, fullIdentity);
    await this.updateLastActive(fullIdentity.address);
    await this.acceptInvitation(acceptRequest.identity, fullIdentity, invitation, channelRecord, acceptRequest.details, request, response);
  }
  private async handleDeleteRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleDeleteRequest");
    const deleteRequest = request.body as ChannelServiceRequest<SignedAddressIdentity, ChannelDeleteDetails>;
    const channelMemberRecord = await this.getChannelMemberRecord(deleteRequest.details.channel, deleteRequest.identity.address);
    if (!channelMemberRecord) {
      response.status(403).send("You are not a member of this channel");
      return;
    }
    if (!this.validateAddressIdentity(deleteRequest.identity, channelMemberRecord, response)) {
      return;
    }

    const channelRecord = await this.getChannelRecord(deleteRequest.details.channel);
    if (channelRecord.creatorAddress !== channelMemberRecord.identity.address) {
      response.status(403).send("Only channel creator can delete");
      return;
    }
    await this.updateLastActive(channelMemberRecord.identity.address);
    await this.deleteChannel(channelRecord, channelMemberRecord, request, response);
  }

  private async handleListRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleListRequest");
    const listRequest = request.body as ChannelServiceRequest<SignedAddressIdentity, ChannelsListDetails>;
    const channelMemberRecord = await db.getLatestChannelMemberRecord(listRequest.identity.address, 'active');
    if (!channelMemberRecord) {
      response.status(403).send("Unknown member address");
      return;
    }
    const identity = this.validateAddressIdentity(listRequest.identity, channelMemberRecord, response);
    if (!identity) {
      return;
    }
    await this.updateLastActive(channelMemberRecord.identity.address);
    await this.listChannels(identity, listRequest.details, request, response);
  }

  private async handleGetRegistration(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleGetRegistration");
    const getRegistrationRequest = request.body as ChannelServiceRequest<SignedKeyIdentity, GetRegistrationDetails>;
    const identity = this.validateKeyIdentity(getRegistrationRequest.identity, response);
    if (!identity) {
      return;
    }
    const registration = await db.findRegistration(identity.address);
    if (!registration || registration.status !== 'active') {
      response.status(404).send("No matching address registered");
      return;
    }
    await this.updateLastActive(identity.address);
    await this.completeGetRegistration(registration, request, response);
  }

  private async completeGetRegistration(registration: RegistrationRecord, request: Request, response: Response): Promise<void> {
    const reply: GetRegistrationResponse = {};
    if (registration.timezone) {
      reply.timezone = registration.timezone;
    }
    if (registration.notifications) {
      reply.notifications = registration.notifications;
    }
    response.json(reply);
  }
  private async handleUpdateRegistration(request: Request, response: Response): Promise<void> {
    console.log("ChannelServer.handleUpdateRegistration");
    const updateRegistrationRequest = request.body as ChannelServiceRequest<SignedKeyIdentity, UpdateRegistrationDetails>;
    if (!updateRegistrationRequest || !updateRegistrationRequest.identity || !updateRegistrationRequest.details) {
      response.status(400).send("Missing or invalid update request");
      return;
    }
    const identity = this.validateKeyIdentity(updateRegistrationRequest.identity, response);
    if (!identity) {
      return;
    }
    const registration = await db.findRegistration(identity.address);
    let settings: NotificationSettings = {};
    if (registration && registration.notifications) {
      settings = registration.notifications;
    }
    if (updateRegistrationRequest.details && updateRegistrationRequest.details.notifications) {
      if (updateRegistrationRequest.details.notifications.minimumSmsIntervalMinutes) {
        settings.minimumSmsIntervalMinutes = updateRegistrationRequest.details.notifications.minimumSmsIntervalMinutes;
      }
      if (updateRegistrationRequest.details.notifications.minimumWebPushIntervalMinutes) {
        settings.minimumWebPushIntervalMinutes = updateRegistrationRequest.details.notifications.minimumWebPushIntervalMinutes;
      }
      if (updateRegistrationRequest.details.notifications.smsNumber) {
        settings.smsNumber = updateRegistrationRequest.details.notifications.smsNumber;
      }
      if (typeof updateRegistrationRequest.details.notifications.suspended === 'boolean') {
        settings.suspended = updateRegistrationRequest.details.notifications.suspended;
      }
      if (updateRegistrationRequest.details.notifications.timing) {
        settings.timing = updateRegistrationRequest.details.notifications.timing;
      }
      if (updateRegistrationRequest.details.notifications.webPushNotifications) {
        settings.webPushNotifications = updateRegistrationRequest.details.notifications.webPushNotifications;
      }
      if (updateRegistrationRequest.details.notifications.smsNotificationCallbackUrlTemplate) {
        settings.smsNotificationCallbackUrlTemplate = updateRegistrationRequest.details.notifications.smsNotificationCallbackUrlTemplate;
      }
      if (typeof updateRegistrationRequest.details.notifications.minimumChannelActiveNotificationIntervalMinutes === 'number') {
        settings.minimumChannelActiveNotificationIntervalMinutes = updateRegistrationRequest.details.notifications.minimumChannelActiveNotificationIntervalMinutes;
      }
      if (typeof updateRegistrationRequest.details.notifications.minimumChannelInactiveNotificationIntervalMinutes === 'number') {
        settings.minimumChannelInactiveNotificationIntervalMinutes = updateRegistrationRequest.details.notifications.minimumChannelInactiveNotificationIntervalMinutes;
      }
    }
    if (registration) {
      await db.updateRegistrationSettings(registration, updateRegistrationRequest.details.timezone, settings);
    } else {
      await db.insertRegistration(identity.address, updateRegistrationRequest.identity, identity, 0, Date.now(), 'active', -100, 100, updateRegistrationRequest.details.timezone, settings);
    }
    await this.updateLastActive(identity.address);
    await this.completeGetRegistration(registration, request, response);
  }

  private validateFullIdentity(signedIdentity: SignedKeyIdentity, response: Response): FullIdentity {
    return this.validateKeyIdentity(signedIdentity, response) as FullIdentity;
  }

  private validateKeyIdentity(signedIdentity: SignedKeyIdentity, response: Response): KeyIdentity {
    if (!signedIdentity || !signedIdentity.signature || !signedIdentity.publicKey) {
      response.status(400).send("Invalid identity");
      return null;
    }
    const keyIdentity = ChannelIdentityUtils.decode<KeyIdentity>(signedIdentity.signature, signedIdentity.publicKey, Date.now());
    if (!keyIdentity || !keyIdentity.publicKey || keyIdentity.publicKey !== signedIdentity.publicKey) {
      response.status(400).send("Invalid identity signature or signedAt");
      return null;
    }
    return keyIdentity;
  }

  private validateAddressIdentity(signedIdentity: SignedAddressIdentity, channelMemberRecord: ChannelMemberRecord, response: Response): AddressIdentity {
    if (!channelMemberRecord) {
      response.status(400).send("Invalid channel or member");
      return null;
    }
    if (!signedIdentity || !signedIdentity.signature || !signedIdentity.address) {
      response.status(400).send("Invalid identity");
      return null;
    }
    const addressIdentity = ChannelIdentityUtils.decode<AddressIdentity>(signedIdentity.signature, channelMemberRecord.identity.publicKey, Date.now());
    if (!addressIdentity || !addressIdentity.address || addressIdentity.address !== signedIdentity.address) {
      response.status(403).send("Invalid identity signature or signedAt");
    }
    return addressIdentity;
  }

  private async getChannelRecord(channelAddress: string): Promise<ChannelRecord> {
    if (!channelAddress) {
      return null;
    }
    return await db.findChannelByAddress(channelAddress);
  }

  private async getChannelMemberRecord(channelAddress: string, memberAddress: string): Promise<ChannelMemberRecord> {
    if (!channelAddress || !memberAddress) {
      return null;
    }
    return await db.findChannelMemberByChannelAndAddress(channelAddress, memberAddress, 'active');
  }

  private async getInvitation(invitationId: string): Promise<ChannelInvitation> {
    if (!invitationId) {
      return null;
    }
    return await db.findInvitationById(invitationId);
  }

  private async validateChannelContractDetails(contract: ChannelContractDetails, response: Response): Promise<boolean> {
    if (!contract || !contract.package || !contract.participationContract || !contract.serviceContract) {
      response.status(400).send("Invalid contract");
      return false;
    }
    if (!contract.participationContract.type) {
      response.status(400).send("Invalid participation contract");
      return false;
    }
    this.fillAllOptions(contract.serviceContract.options);
    return true;
  }

  private async validateMemberContract(memberContract: MemberContractDetails, response: Response): Promise<boolean> {
    if (!memberContract) {
      response.status(400).send("Invalid member contract");
      return false;
    }
    return true;
  }

  private async createChannel(signedIdentity: SignedKeyIdentity, identity: FullIdentity, details: ChannelCreateDetails, request: Request, response: Response): Promise<void> {
    // This is assigning the transport responsibility for this channel to my own server.  When running with multiple
    // servers, this means that I'm balancing the switching load over those servers, too.  We just have to make sure
    // that REST requests that need to be handled by the server doing the transport arrive on the correct server.
    const channelAddress = ChannelIdentityUtils.generateValidAddress();
    this.fillAllOptions(details.channelContract.serviceContract.options);
    const channelRecord = await db.insertChannel(channelAddress, details.name, identity.address, this.transportUrl, details.channelContract, 'active');
    const now = Date.now();
    const channelInfo: ChannelInfo = {
      code: this.allocateChannelCode(),
      channelAddress: channelRecord.channelAddress,
      memberAddress: identity.address,
      participantsByCode: {},
      participantsByAddress: {},
      lastAllocatedCode: 0,
      contract: channelRecord.contract,
      creatorAddress: identity.address
    };
    this.channelInfoByAddress[channelRecord.channelAddress] = channelInfo;
    this.channelAddressByCode[channelInfo.code] = channelRecord.channelAddress;
    const channelMemberRecord = await db.insertChannelMember(channelAddress, signedIdentity, identity, details.memberContract, 'active');
    const reply = await this.getChannel(channelRecord, channelMemberRecord, request, response);
    console.log("ChannelServer: channel created", identity.address, channelAddress);
  }

  private async shareChannel(channelRecord: ChannelRecord, channelMemberRecord: ChannelMemberRecord, details: ChannelShareDetails, request: Request, response: Response): Promise<void> {
    let invitation: ChannelInvitation;
    let count = 0;
    while (count++ < 1000) {
      const invitationId = Utils.createToken(6);
      try {
        invitation = await db.insertInvitation(invitationId, channelMemberRecord.identity.address, channelRecord.channelAddress, details.extensions);
      } catch (err) {
        // Possible duplicate on id, so will just try again
      }
    }
    const reply: ChannelShareResponse = {
      shareCodeUrl: url.resolve(this.restBaseUrl, '/i/' + invitation.id)
    };
    console.log("ChannelServer: invitation created", channelMemberRecord.identity.address, channelRecord.channelAddress);
    response.json(reply);
  }

  private async getChannel(channelRecord: ChannelRecord, channelMemberRecord: ChannelMemberRecord, request: Request, response: Response): Promise<void> {
    const reply: ChannelInformation = {
      channelAddress: channelRecord.channelAddress,
      transportUrl: channelRecord.transportUrl,
      contract: channelRecord.contract,
      isCreator: channelRecord.creatorAddress === channelMemberRecord.identity.address,
      memberCount: await db.countChannelMembers(channelRecord.channelAddress, 'active'),
      members: [],
      created: channelRecord.created,
      lastUpdated: channelRecord.lastUpdated
    };
    if (channelRecord.name) {
      reply.name = channelRecord.name;
    }
    const members = await db.findChannelMembers(channelRecord.channelAddress, 'active', 8);
    for (const member of members) {
      const m: ChannelMemberInfo = {
        identity: member.signedIdentity,
        isCreator: member.identity.address === channelRecord.creatorAddress,
        memberSince: member.added,
        lastActive: member.lastActive,
      };
      reply.members.push(m);
    }
    response.json(reply);
  }

  private async acceptInvitation(signedIdentity: SignedKeyIdentity, identity: FullIdentity, invitation: ChannelInvitation, channelRecord: ChannelRecord, details: ChannelAcceptDetails, request: Request, response: Response): Promise<void> {
    const channelMemberRecord = await db.insertChannelMember(channelRecord.channelAddress, signedIdentity, identity, details.memberContract, 'active');
    await this.getChannel(channelRecord, channelMemberRecord, request, response);
  }

  private async deleteChannel(channelRecord: ChannelRecord, channelMemberRecord: ChannelMemberRecord, request: Request, response: Response): Promise<void> {
    await db.updateChannelStatus(channelRecord.channelAddress, 'deleted');
    const deleteResponse: ChannelDeleteResponse = {};
    response.json(deleteResponse);
    console.log("ChannelServer: channel deleted", channelMemberRecord.identity.address, channelRecord.channelAddress);
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

  private async listChannels(identity: AddressIdentity, details: ChannelsListDetails, request: Request, response: Response): Promise<void> {
    const memberAddress = identity.address;
    const lastActiveBefore = details.lastActiveBefore ? details.lastActiveBefore : 0;
    const limit = details.limit ? details.limit : 50;
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
          contract: channelRecord.contract,
          isCreator: channelRecord.creatorAddress === memberAddress,
          memberCount: await db.countChannelMembers(channelRecord.channelAddress, 'active'),
          members: [],
          created: channelRecord.created,
          lastUpdated: channelRecord.lastUpdated
        };
        if (channelRecord.name) {
          channelDetails.name = channelRecord.name;
        }
        const members = await db.findChannelMembers(channelRecord.channelAddress, 'active');
        for (const member of members) {
          const info: ChannelMemberInfo = {
            identity: member.signedIdentity,
            isCreator: member.identity.address === channelRecord.creatorAddress,
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
        protocol: CHANNELS_PROTOCOL,
        serviceEndpoints: this.getServicesList(),
        invitationId: invitation.id,
        channelInfo: channelInfo,
        extensions: invitation.extensions,
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

  private async getBasicChannelInfo(channelRecord: ChannelRecord): Promise<BasicChannelInformation> {
    const result: BasicChannelInformation = {
      channelAddress: channelRecord.channelAddress,
      contract: channelRecord.contract,
      memberCount: await db.countChannelMembers(channelRecord.channelAddress, 'active'),
      created: channelRecord.created
    };
    return result;
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
    delete channel.participantsByAddress[participant.memberIdentity.address];
    let count = 0;
    if (channel.contract.serviceContract.options.topology === 'many-to-many') {
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
    if (channelInfo.contract.serviceContract.options.topology === 'one-to-many' && participant.memberIdentity.address !== channelInfo.creatorAddress) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(null, socketId, 403, "This is a one-to-many channel.  Only the creator is allowed to send messages.", channelAddress));
      return result;
    }
    if (messageInfo.history && channelInfo.contract.serviceContract.options.history) {
      await db.insertMessage(channelAddress, participant.memberIdentity.address, messageInfo.timestamp, messageInfo.serializedMessage.byteLength, messageInfo.serializedMessage);
    }
    await this.updateChannelMemberActive(channelAddress, participant.code.toString());
    const socketIds: string[] = [];
    for (const code of Object.keys(channelInfo.participantsByCode)) {
      if (code !== messageInfo.senderCode.toString()) {
        const p = channelInfo.participantsByCode[code];
        if (channelInfo.contract.serviceContract.options.topology === 'many-to-one' && p.memberIdentity.address !== channelInfo.creatorAddress && participant.memberIdentity.address !== channelInfo.creatorAddress) {
          continue;
        }
        if (p.socketId !== socketId && result.forwardMessageToSockets.indexOf(p.socketId) < 0) {
          result.forwardMessageToSockets.push(p.socketId);
        }
      }
    }
    console.log("ChannelServer: Forwarding channel message to " + result.forwardMessageToSockets.length + " sockets", socket.socketId, channelAddress);
    if (!messageInfo.priority) {
      // Don't consider notifications for real-time (media) messages
      await this.considerNotifications(channelInfo, participant);
    }
    return result;
  }

  private async considerNotifications(channelInfo: ChannelInfo, participant: ParticipantInfo): Promise<void> {
    const now = Date.now();
    const members = await db.findChannelMembersBeforeLastConsideredAndUpdate(channelInfo.channelAddress, 'active', now - MINIMUM_NOTIFICATION_CONSIDER_INTERVAL);
    for (const member of members) {
      // ignore active participants
      if (channelInfo.participantsByAddress[member.identity.address]) {
        continue;
      }
      const channelMemberRecord = await db.findChannelMemberByChannelAndAddress(channelInfo.channelAddress, member.identity.address, 'active');
      if (!channelMemberRecord) {
        continue;
      }
      // if not subscribed, then a notification is not relevant
      if (!channelMemberRecord.memberServices || !channelMemberRecord.memberServices.subscribe) {
        continue;
      }
      const registration = await db.findRegistration(channelMemberRecord.identity.address);
      if (!registration) {
        continue;
      }
      if (!registration.notifications || registration.notifications.suspended) {
        continue;
      }
      if (!registration.notifications.smsNumber) {
        continue;
      }
      const smsBlock = await db.findSmsBlockByNumber(registration.notifications.smsNumber);
      if (smsBlock && smsBlock.blocked) {
        continue;
      }
      if (now - registration.lastSmsNotification < (registration.notifications.minimumSmsIntervalMinutes ? registration.notifications.minimumSmsIntervalMinutes : DEFAULT_MIN_SMS_INTERVAL_MINS) * 60 * 1000) {
        continue;
      }
      if (this.isBlackedOut(registration.notifications.timing, registration.timezone)) {
        continue;
      }
      // We'll choose the minimum interval depending on whether they became active after I last sent a notification
      // suggesting that they are interested, and therefore a shorter interval between notifications is warranted
      const inactiveInterval = registration.notifications.minimumChannelInactiveNotificationIntervalMinutes ? registration.notifications.minimumChannelInactiveNotificationIntervalMinutes : MINIMUM_CHANNEL_NOTIFICATION_INACTIVE_INTERVAL;
      const activeInterval = registration.notifications.minimumChannelActiveNotificationIntervalMinutes ? registration.notifications.minimumChannelActiveNotificationIntervalMinutes : MINIMUM_CHANNEL_NOTIFICATION_ACTIVE_INTERVAL;
      const minimumInterval = channelMemberRecord.lastNotificationSent > channelMemberRecord.lastActive ? inactiveInterval : activeInterval;
      if (now - channelMemberRecord.lastNotificationSent < minimumInterval) {
        continue;
      }
      await this.sendChannelActivityNotification(channelInfo, channelMemberRecord, registration, participant);
    }
  }

  private isBlackedOut(timing: NotificationTiming, timezone: string): boolean {
    if (!timing || !timezone) {
      return false;
    }
    const m = moment().tz(timezone);
    if (timing.noNotificationDays) {
      for (const d of timing.noNotificationDays) {
        if (m.day() === d) {
          return true;
        }
      }
    }
    if (timing.notBeforeMinutes) {
      if (m.hours() * 60 + m.minutes() < timing.notBeforeMinutes) {
        return true;
      }
    }
    if (timing.notAfterMinutes) {
      if (m.hours() * 60 + m.minutes() > timing.notAfterMinutes) {
        return true;
      }
    }
    return false;
  }

  private async sendChannelActivityNotification(channelInfo: ChannelInfo, channelMemberRecord: ChannelMemberRecord, registration: RegistrationRecord, sender: ParticipantInfo): Promise<void> {
    let message = '';
    const senderName = sender.memberIdentity.name ? sender.memberIdentity.name : "Someone";
    const channelRecord = await db.findChannelByAddress(channelInfo.channelAddress);
    const channelName = channelRecord.name ? "channel '" + channelRecord.name + "'" : "one of your channels";
    if (!registration.lastSmsNotification) {
      message = "Notification from Channels:\n";
    }
    message += senderName + " is active on " + channelName;
    if (registration.notifications.smsNotificationCallbackUrlTemplate) {
      message += '\n' + registration.notifications.smsNotificationCallbackUrlTemplate.replace('{{channel}}', channelInfo.channelAddress);
    }
    if (!registration.lastSmsNotification) {
      message += "\n\nSend STOP to block notifications.";
    }
    await smsManager.send(registration.notifications.smsNumber, message);
    await db.updateRegistrationLastNotificationSent(registration.address);
    await db.updateChannelMemberLastNotification(channelMemberRecord.channelAddress, channelMemberRecord.identity.address);
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
    if (!requestDetails || !requestDetails.channelAddress || !requestDetails.memberIdentity || !requestDetails.memberIdentity.address || !requestDetails.memberIdentity.signature) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 400, "Join request details missing or invalid", requestDetails ? requestDetails.channelAddress : null));
      return result;
    }
    const channelMemberRecord = await db.findChannelMemberByChannelAndAddress(requestDetails.channelAddress, requestDetails.memberIdentity.address, 'active');
    if (!channelMemberRecord) {
      result.deliverControlMessages.push(this.createErrorMessageDirective(controlRequest, socket.socketId, 403, "You are not a member of this channel", requestDetails ? requestDetails.channelAddress : null));
      return result;
    }
    if (!ChannelIdentityUtils.decode(requestDetails.memberIdentity.signature, channelMemberRecord.identity.publicKey, Date.now())) {
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
        memberAddress: channelMemberRecord.identity.address,
        participantsByCode: {},
        participantsByAddress: {},
        lastAllocatedCode: 0,
        contract: channelRecord.contract,
        creatorAddress: channelRecord.creatorAddress
      };
      this.channelInfoByAddress[channelRecord.channelAddress] = channelInfo;
      this.channelAddressByCode[channelInfo.code] = channelRecord.channelAddress;
    }
    const now = Date.now();
    const memberIdentity = channelMemberRecord.identity;
    await db.updateChannelMemberActive(channelMemberRecord.channelAddress, channelMemberRecord.identity.address, 'active', now, null);
    const participant: ParticipantInfo = {
      memberSignedIdentity: channelMemberRecord.signedIdentity,
      memberIdentity: memberIdentity,
      participantIdentityDetails: requestDetails.participantIdentityDetails,
      code: this.allocateParticipantCode(channelInfo),
      channelAddress: channelRecord.channelAddress,
      socketId: socket.socketId,
      isCreator: channelMemberRecord.identity.address === channelRecord.creatorAddress,
      memberSince: channelMemberRecord.added,
      lastActive: now
    };
    socket.participantCodeByChannelAddress[channelRecord.channelAddress] = participant.code.toString();
    channelInfo.participantsByCode[participant.code] = participant;
    channelInfo.participantsByAddress[participant.memberIdentity.address] = participant;
    const joinResponseDetails: JoinResponseDetails = {
      channelAddress: channelRecord.channelAddress,
      channelCode: channelInfo.code,
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
        const pId: ChannelParticipantIdentity = {
          signedIdentity: p.memberSignedIdentity,
          participantDetails: p.participantIdentityDetails
        };
        const info: ChannelParticipantInfo = {
          code: p.code,
          participantIdentity: pId,
          isCreator: p.memberIdentity.address === channelRecord.creatorAddress,
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
    if (channelInfo.contract.serviceContract.options.topology === 'many-to-many') {
      for (const code of Object.keys(channelInfo.participantsByCode)) {
        const p = channelInfo.participantsByCode[code];
        if (p.socketId !== socket.socketId) {
          const joinNotificationDetails: JoinNotificationDetails = {
            channelAddress: channelInfo.channelAddress,
            memberIdentity: channelMemberRecord.signedIdentity,
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
    await this.updateLastActive(memberIdentity.address);
    console.log("ChannelServer: Completed join and notified " + notificationCount, socket.socketId, controlRequest.requestId, channelInfo.channelAddress, channelInfo.code, participant.memberIdentity.address, participant.code);
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
      await db.updateChannelMemberActive(channelInfo.channelAddress, participant.memberIdentity.address, 'inactive', Date.now());
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
    await this.updateLastActive(participant.memberIdentity.address);
    console.log("ChannelServer: Completed leave and notified " + notificationCount, socket.socketId, controlRequest.requestId, channelInfo.channelAddress, channelInfo.code, participant.memberIdentity.address, participant.code);
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

  async handleInboundSms(from: string, to: string, messageBody: string): Promise<string> {
    console.log("ChannelServer.handleInboundSms", from, to, messageBody);
    if (!messageBody) {
      return null;
    }
    const entry = await db.findSmsBlockByNumber(from);
    if (['stop', 'block'].indexOf(messageBody.toLowerCase()) >= 0) {
      return await this.handleInboundSmsBlock(from, to, entry);
    }
    if (['go', 'unstop', 'unblock'].indexOf(messageBody.toLowerCase()) >= 0) {
      return await this.handleInboundSmsUnblock(from, to, entry);
    }
    return null;
  }

  private async handleInboundSmsBlock(from: string, to: string, entry: SmsBlockRecord): Promise<string> {
    if (entry && entry.blocked) {
      return "We already have your number listed as blocked, and will not be sending any messages until you send 'unblock'.";
    }
    await db.upsertSmsBlock(from, true, Date.now());
    return "Got it.  We won't send you any message until you send us 'unblock'.";
  }

  private async handleInboundSmsUnblock(from: string, to: string, entry: SmsBlockRecord): Promise<string> {
    if (!entry || !entry.blocked) {
      return "We do not have you listed as blocked.  So this has no effect.";
    }
    await db.upsertSmsBlock(from, false, Date.now());
    return "Got it.  When we have something to notify you about, we will send you a message.";
  }
}

interface ParticipantInfo {
  memberSignedIdentity: SignedKeyIdentity;
  memberIdentity: FullIdentity;
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
  participantsByAddress: { [address: string]: ParticipantInfo };
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
