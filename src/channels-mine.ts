import * as express from "express";
import { Request, Response } from 'express';
import * as net from 'net';
import { configuration } from "./configuration";
import * as url from 'url';
import { MineServiceDescription, CHANNELS_MINE_PROTOCOL, ServiceEndpoints, MineServiceRequest, SignedAddressIdentity, SignedKeyIdentity, MineRegisterUserDetails, ChannelIdentityUtils, AddressIdentity, KeyIdentity, MineRegisterUserResponse, MinePollDetails, MinePollResponse, SignedBankReceipt, BankServiceDescription } from "channels-common";
import { db } from "./db";
import { MineRegistrationRecord } from "./interfaces/db-records";
import { channelsRestClient } from "channels-rest-client";

const DYNAMIC_BASE = '/d';
const MINE_PROTOCOL_VERSION = 1;
const INITIAL_MINE_PAYMENT = 1;
const ACTIVE_USER_MINE_PAYMENT = 0.2;
const MINIMUM_PAYMENT_INTERVAL = 4 * 60 * 60 * 1000;

export class ChannelsMine {
  private app: express.Application;
  private providerUrl: string;
  private homeUrl: string;
  private restBaseUrl: string;
  private restRelativeBaseUrl: string;
  private mineUrl: string;

  constructor(app: express.Application, server: net.Server) {
    this.app = app;
    this.providerUrl = url.resolve(configuration.get('baseClientUri'), "/channels-mine.json");
    this.homeUrl = configuration.get('baseClientUri');
    this.restBaseUrl = configuration.get('baseClientUri');
    this.mineUrl = this.getServicesList().descriptionUrl;
    this.restRelativeBaseUrl = DYNAMIC_BASE;
    this.registerHandlers(this.restRelativeBaseUrl);
  }

  async start(): Promise<void> {
    // noop
  }

  private registerHandlers(restRelativeBaseUrl: string): void {
    this.app.get('/channels-mine.json', (request: Request, response: Response) => {
      try {
        void this.handleDescriptionRequest(request, response);
      } catch (err) {
        console.error("Mine: Failure on description", err);
        response.status(500).send("Internal error: " + err.toString());
      }
    });
    this.app.post(restRelativeBaseUrl + '/mine', (request: Request, response: Response) => {
      try {
        void this.handleMineRequest(request, response);
      } catch (err) {
        console.error("Mine: Failure on description", err);
        response.status(500).send("Internal error: " + err.toString());
      }
    });
  }

  private async handleDescriptionRequest(request: Request, response: Response): Promise<void> {
    console.log("Mine.handleDescriptionRequest");
    const reply: MineServiceDescription = {
      protocol: CHANNELS_MINE_PROTOCOL,
      version: {
        current: MINE_PROTOCOL_VERSION,
        min: MINE_PROTOCOL_VERSION
      },
      service: {
        name: "Channels Mine",
        logo: url.resolve(configuration.get('baseClientUri'), '/s/logo.png'),
        homepage: configuration.get('baseClientUri'),
        details: {}
      },
      implementation: {
        name: "Channel Elements Reference Mine",
        logo: url.resolve(configuration.get('baseClientUri'), '/s/logo.png'),
        homepage: "https://github.com/ChannelElementsTeam/channel-server",
        version: "0.1.0",
        implementationExtensions: {}
      },
      serviceEndpoints: this.getServicesList()
    };
    response.json(reply);
  }

  getServicesList(): ServiceEndpoints {
    const result: ServiceEndpoints = {
      descriptionUrl: this.mineUrl,
      homeUrl: this.homeUrl,
      restServiceUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/mine'),
    };
    return result;
  }

  private async handleMineRequest(request: Request, response: Response): Promise<void> {
    const serviceRequest = request.body as MineServiceRequest<SignedAddressIdentity | SignedKeyIdentity, any>;
    if (!serviceRequest || !serviceRequest.type || !serviceRequest.identity) {
      response.status(400).send("Invalid request structure");
      return;
    }
    switch (serviceRequest.type) {
      case 'register-user':
        await this.handleRegisterUserRequest(request, response);
        break;
      case 'search':
        await this.handlePollRequest(request, response);
        break;
      default:
        response.status(400).send("Invalid request type");
        break;
    }
  }

  private async handleRegisterUserRequest(request: Request, response: Response): Promise<void> {
    console.log("Mine.handleRegisterUserRequest");
    const openRequest = request.body as MineServiceRequest<SignedKeyIdentity, MineRegisterUserDetails>;
    const keyIdentity = await this.validateKeyIdentity(openRequest.identity, response);
    if (!keyIdentity) {
      return;
    }
    const existing = await this.getUserRegistration(keyIdentity.address);
    if (existing) {
      await this.respondWithRegistration(existing, response);
      return;
    }
    await this.registerUser(openRequest.identity, keyIdentity, response);
  }

  private async handlePollRequest(request: Request, response: Response): Promise<void> {
    console.log("Mine.handlePollRequest");
    const pollRequest = request.body as MineServiceRequest<SignedAddressIdentity, MinePollDetails>;
    const registration = await this.validateAddressIdentity(pollRequest.identity, Date.now(), response);
    if (!registration) {
      return;
    }
    if (!pollRequest.details.bankProviderUrl) {
      response.status(400).send("Missing bankProviderUrl");
      return;
    }
    await this.poll(registration, pollRequest.details, response);
  }

  private async poll(registration: MineRegistrationRecord, details: MinePollDetails, response: Response): Promise<void> {
    const reply: MinePollResponse = {};
    let lastPayment: number;
    let payment = 0;
    const now = Date.now();
    if (registration.lastPayment) {
      if (now - registration.lastPayment > MINIMUM_PAYMENT_INTERVAL) {
        lastPayment = now;
        payment = ACTIVE_USER_MINE_PAYMENT;
      }
    } else {
      payment = INITIAL_MINE_PAYMENT;
      lastPayment = now;
    }
    if (payment > 0) {
      const receipt = await this.makePayment(registration, details, payment);
      reply.miningReceipt = receipt;
    }
    await db.updateMineRegistrationLastActive(registration.address, lastPayment, details.switchProviderUrls, details.cardRegistryUrls, details.bankProviderUrl);
    response.json(reply);
  }

  private async makePayment(registration: MineRegistrationRecord, details: MinePollDetails, payment: number): Promise<SignedBankReceipt> {
    let bankDescription: BankServiceDescription;
    try {
      bankDescription = await channelsRestClient.getBankDescription(details.bankProviderUrl);
    } catch (err) {
      throw new Error("Invalid bank");
    }
    // TODO
    return null;
  }

  private validateKeyIdentity(signedIdentity: SignedKeyIdentity, response: Response): KeyIdentity {
    if (!signedIdentity || !signedIdentity.signature || !signedIdentity.publicKey) {
      response.status(400).send("Invalid identity");
      return null;
    }
    const keyIdentity = ChannelIdentityUtils.decodeSignedKey(signedIdentity, Date.now());
    if (!keyIdentity || !keyIdentity.publicKey || keyIdentity.publicKey !== signedIdentity.publicKey) {
      response.status(400).send("Invalid identity signature or signedAt");
      return null;
    }
    return keyIdentity;
  }

  private async validateAddressIdentity(signedIdentity: SignedAddressIdentity, expectedTimestamp: number, response: Response): Promise<MineRegistrationRecord> {
    if (!signedIdentity || !signedIdentity.signature || !signedIdentity.address) {
      response.status(400).send("Invalid identity");
      return null;
    }
    const registration = await db.findMineRegistration(signedIdentity.address);
    if (!registration || registration.status !== 'active') {
      response.status(401).send("No such registered identity");
      return null;
    }
    const addressIdentity = ChannelIdentityUtils.decode<AddressIdentity>(signedIdentity.signature, registration.identity.publicKey, expectedTimestamp);
    if (!addressIdentity || !addressIdentity.address || addressIdentity.address !== signedIdentity.address) {
      response.status(403).send("Invalid identity signature or signedAt");
    }
    return registration;
  }

  private async getUserRegistration(accountAddress: string): Promise<MineRegistrationRecord> {
    if (!accountAddress) {
      return null;
    }
    const result = await db.findMineRegistration(accountAddress);
    if (result && result.status === 'active') {
      return result;
    }
    return null;
  }

  private async respondWithRegistration(registration: MineRegistrationRecord, response: Response): Promise<void> {
    const reply: MineRegisterUserResponse = {};
    response.json(reply);
  }

  private async registerUser(signedIdentity: SignedKeyIdentity, identity: KeyIdentity, response: Response): Promise<void> {
    const now = Date.now();
    const registration = await db.insertMineRegistration(identity.address, signedIdentity, identity, now, now, 'active');
    await this.respondWithRegistration(registration, response);
  }

}
