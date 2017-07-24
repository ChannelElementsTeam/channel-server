import * as express from "express";
import { Request, Response } from 'express';
import * as net from 'net';
import { configuration } from "./configuration";
import * as url from 'url';
import { BankServiceEndpoints, BankServiceRequest, SignedAddressIdentity, SignedKeyIdentity, ChannelIdentityUtils, KeyIdentity, AddressIdentity, BankGetAccountDetails, BankTransferDetails, BankTransferResponse, KeyInfo, BankTransferReceipt, BankGetAccountResponse, CardRegistryServiceDescription, CHANNELS_CARD_REGISTRY_PROTOCOL, ServiceEndpoints, CardRegistryServiceRequest, CardRegistryRegisterUserDetails, CardRegistryRegisterUserResponse, CardRegistrySearchDetails, CardRegistrySearchResponse, CardRegistryEntry } from 'channels-common';
import { BankAccountRecord, BankInfo, CardRegistryRegistrationRecord, CardRegistryCardRecord } from "./interfaces/db-records";
import { db } from "./db";
import * as uuid from "uuid";
import { Utils } from "./utils";

import * as path from "path";
import fs = require('fs');

const DYNAMIC_BASE = '/d';
const MINIMUM_ACCOUNT_BALANCE = -10;
const BANK_ID = 'main';
const CARD_REGISTRY_PROTOCOL_VERSION = 1;

export class CardRegistry {
  private app: express.Application;
  private providerUrl: string;
  private homeUrl: string;
  private restBaseUrl: string;
  private restRelativeBaseUrl: string;
  private registryUrl: string;

  constructor(app: express.Application, server: net.Server) {
    this.app = app;
    this.providerUrl = url.resolve(configuration.get('baseClientUri'), "/channels-card-registry.json");
    this.homeUrl = configuration.get('baseClientUri');
    this.restBaseUrl = configuration.get('baseClientUri');
    this.registryUrl = this.getServicesList().descriptionUrl;
    this.restRelativeBaseUrl = DYNAMIC_BASE;
    this.registerHandlers(this.restRelativeBaseUrl);
  }

  async start(): Promise<void> {
    await this.loadCards();
  }

  private registerHandlers(restRelativeBaseUrl: string): void {
    this.app.get('/channels-card-registry.json', (request: Request, response: Response) => {
      void this.handleDescriptionRequest(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/cards', (request: Request, response: Response) => {
      void this.handleCardsRequest(request, response);
    });
  }

  private async handleDescriptionRequest(request: Request, response: Response): Promise<void> {
    console.log("CardRegistry.handleDescriptionRequest");
    const reply: CardRegistryServiceDescription = {
      protocol: CHANNELS_CARD_REGISTRY_PROTOCOL,
      version: {
        current: CARD_REGISTRY_PROTOCOL_VERSION,
        min: CARD_REGISTRY_PROTOCOL_VERSION
      },
      service: {
        name: "Channel Elements Bank",
        logo: url.resolve(configuration.get('baseClientUri'), '/s/logo.png'),
        homepage: configuration.get('baseClientUri'),
        details: {}
      },
      implementation: {
        name: "Channel Elements Reference Bank",
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
      descriptionUrl: this.registryUrl,
      homeUrl: this.homeUrl,
      restServiceUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/cards'),
    };
    return result;
  }

  private async handleCardsRequest(request: Request, response: Response): Promise<void> {
    const serviceRequest = request.body as BankServiceRequest<SignedAddressIdentity | SignedKeyIdentity, any>;
    if (!serviceRequest || !serviceRequest.type || !serviceRequest.identity) {
      response.status(400).send("Invalid request structure");
      return;
    }
    switch (serviceRequest.type) {
      case 'register-user':
        await this.handleRegisterUserRequest(request, response);
        break;
      case 'search':
        await this.handleSearchRequest(request, response);
        break;
      default:
        response.status(400).send("Invalid request type");
        break;
    }
  }

  private async handleRegisterUserRequest(request: Request, response: Response): Promise<void> {
    console.log("CardRegistry.handleRegisterUserRequest");
    const openRequest = request.body as CardRegistryServiceRequest<SignedKeyIdentity, CardRegistryRegisterUserDetails>;
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

  private async handleSearchRequest(request: Request, response: Response): Promise<void> {
    console.log("CardRegistry.handleSearchRequest");
    const searchRequest = request.body as CardRegistryServiceRequest<SignedAddressIdentity, CardRegistrySearchDetails>;
    const registration = await this.validateAddressIdentity(searchRequest.identity, Date.now(), response);
    if (!registration) {
      return;
    }
    await this.search(registration, searchRequest.details, response);
  }

  private async search(registration: CardRegistryRegistrationRecord, searchDetails: CardRegistrySearchDetails, response: Response): Promise<void> {
    const reply: CardRegistrySearchResponse = {
      matches: []
    };
    const matches = await db.searchCardRegistryCard(searchDetails.searchString, searchDetails.categoriesFilter, searchDetails.maxCount || 100);
    for (const match of matches) {
      const item: CardRegistryEntry = {
        entryId: match.entryId,
        approved: match.approved,
        pending: match.pending,
        rejectionReason: match.rejectionReason,
        categories: match.categories,
        cardSourceWithVersion: match.cardSourceWithVersion,
        lastSubmitted: match.lastSubmitted,
        lastSubmittedByAddress: match.lastSubmittedByAddress,
        firstApproved: match.firstApproved,
        lastApproved: match.lastApproved,
        lastApprovedVersion: match.lastApprovedVersion,
        cardName: match.cardName,
        websiteUrl: match.websiteUrl,
        description: match.description,
        author: match.author,
        iconUrl: match.iconUrl,
        price: match.price,
        bankAccount: match.bankAccount,
        overallRating: match.averageRating,
        purchaseCount: match.purchaseCount,
        purchasersCount: match.purchasersCount,
        numberReviews: match.numberReviews,
        requestsPayment: match.requestsPayment,
        offersPayment: match.offersPayment,
        collaborative: match.collaborative
      };
      reply.matches.push(item);
    }
    response.json(reply);
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

  private async validateAddressIdentity(signedIdentity: SignedAddressIdentity, expectedTimestamp: number, response: Response): Promise<CardRegistryRegistrationRecord> {
    if (!signedIdentity || !signedIdentity.signature || !signedIdentity.address) {
      response.status(400).send("Invalid identity");
      return null;
    }
    const registration = await db.findCardRegistryRegistration(signedIdentity.address);
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

  private async getUserRegistration(accountAddress: string): Promise<CardRegistryRegistrationRecord> {
    if (!accountAddress) {
      return null;
    }
    const result = await db.findCardRegistryRegistration(accountAddress);
    if (result && result.status === 'active') {
      return result;
    }
    return null;
  }

  private async respondWithRegistration(registration: CardRegistryRegistrationRecord, response: Response): Promise<void> {
    const reply: CardRegistryRegisterUserResponse = {};
    response.json(reply);
  }

  private async registerUser(signedIdentity: SignedKeyIdentity, identity: KeyIdentity, response: Response): Promise<void> {
    const now = Date.now();
    const registration = await db.insertCardRegistryRegistration(identity.address, signedIdentity, identity, now, now, 'active');
    await this.respondWithRegistration(registration, response);
  }

  private async loadCards(): Promise<void> {
    const cardsPath = path.join(__dirname + "/../card-registry.json");
    console.log("Reading cards from " + cardsPath);
    try {
      const data = fs.readFileSync(cardsPath, 'utf8');
      const cardInfo = JSON.parse(data) as CardFile;
      let added = 0;
      let updated = 0;
      if (cardInfo.cards) {
        for (const card of cardInfo.cards) {
          const existing = await db.findCardRegistryCard(card.entryId);
          if (!existing || existing.lastApproved < card.lastApproved) {
            if (existing) {
              updated++;
            } else {
              added++;
            }
            await this.updateCardEntry(existing, card);
          }
        }
      }
      console.log("CardRegistry.loadCards:  Added " + added + " and updated " + updated + " cards");
    } catch (err) {
      console.error("CardRegistry.loadCards: failure loading cards", err);
    }

  }

  private async updateCardEntry(existing: CardRegistryCardRecord, updated: CardRegistryCardRecord): Promise<void> {
    const now = Date.now();
    if (existing) {
      existing.averageRating = typeof updated.averageRating === 'number' ? updated.averageRating : 0;
      existing.categoriesCaseInsensitive = [];
      if (updated.categories) {
        existing.categories = [];
        for (const category of updated.categories) {
          existing.categoriesCaseInsensitive.push(category.toLowerCase());
        }
      }
      existing.collaborative = typeof updated.collaborative === 'boolean' ? updated.collaborative : existing.collaborative;
      existing.firstApproved = typeof updated.firstApproved === 'number' ? updated.firstApproved : existing.firstApproved;
      existing.lastApproved = typeof updated.lastApproved === 'number' ? updated.lastApproved : existing.lastApproved;
      existing.lastSubmitted = typeof updated.lastSubmitted === 'number' ? updated.lastSubmitted : existing.lastSubmitted;
      existing.offersPayment = typeof updated.offersPayment === 'boolean' ? updated.offersPayment : existing.offersPayment;
      existing.requestsPayment = typeof updated.requestsPayment === 'boolean' ? updated.requestsPayment : existing.requestsPayment;
      existing.pending = typeof updated.pending === 'boolean' ? updated.pending : existing.pending;
      existing.price = typeof updated.price === 'number' ? updated.price : existing.price;
      existing.purchaseCount = typeof updated.purchaseCount === 'number' ? updated.purchaseCount : existing.purchaseCount;
      existing.purchasersCount = typeof updated.purchasersCount === 'number' ? updated.purchasersCount : existing.purchasersCount;
      existing.ranking = typeof updated.ranking === 'number' ? updated.ranking : existing.ranking;
      existing.cardName = typeof updated.cardName === 'string' ? updated.cardName : existing.cardName;
      existing.cardSourceWithVersion = typeof updated.cardSourceWithVersion === 'string' ? updated.cardSourceWithVersion : existing.cardSourceWithVersion;
      existing.description = typeof updated.description === 'string' ? updated.description : existing.description;
      existing.categoryNames = existing.categories.join(' ').split('/').join(' ').toLowerCase();
      await db.updateCardRegistryCard(existing);
    } else {
      updated.added = now;
      updated.averageRating = typeof updated.averageRating === 'number' ? updated.averageRating : 0;
      updated.categoriesCaseInsensitive = [];
      if (!updated.categories) {
        updated.categories = [];
      }
      for (const category of updated.categories) {
        updated.categoriesCaseInsensitive.push(category.toLowerCase());
      }
      updated.collaborative = typeof updated.collaborative === 'boolean' ? updated.collaborative : false;
      updated.firstApproved = updated.firstApproved || now;
      updated.lastApproved = updated.lastApproved || now;
      updated.lastSubmitted = updated.lastSubmitted || now;
      updated.numberReviews = 0;
      updated.offersPayment = typeof updated.offersPayment === 'boolean' ? updated.offersPayment : false;
      updated.requestsPayment = typeof updated.requestsPayment === 'boolean' ? updated.requestsPayment : false;
      updated.pending = typeof updated.pending === 'boolean' ? updated.pending : false;
      updated.price = typeof updated.price === 'number' ? updated.price : 0;
      updated.purchaseCount = typeof updated.purchaseCount === 'number' ? updated.purchaseCount : 0;
      updated.purchasersCount = typeof updated.purchasersCount === 'number' ? updated.purchasersCount : 0;
      updated.ranking = typeof updated.ranking === 'number' ? updated.ranking : 0;
      updated.categoryNames = updated.categories.join(' ').split('/').join(' ').toLowerCase();
      await db.updateCardRegistryCard(updated);
    }
  }

}

interface CardFile {
  cards: CardRegistryCardRecord[];
}
