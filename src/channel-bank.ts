import * as express from "express";
import { Request, Response } from 'express';
import * as net from 'net';
import { configuration } from "./configuration";
import * as url from 'url';
import { ChannelBankDescription, BANKING_PROTOCOL, BankServiceEndpoints, BankServiceRequest, SignedAddressIdentity, SignedKeyIdentity, BankOpenAccountDetails, ChannelIdentityUtils, FullIdentity, KeyIdentity, AddressIdentity, BankGetAccountDetails, BankTransferDetails, BankOpenAccountResponse, BankAccountInformation, BankTransferResponse, KeyInfo, BankTransferReceipt, BankGetAccountResponse } from 'channels-common';
import { BankAccountRecord, BankInfo } from "./interfaces/db-records";
import { db } from "./db";
import * as uuid from "uuid";
import { Utils } from "./utils";

const DYNAMIC_BASE = '/d';
const MINIMUM_ACCOUNT_BALANCE = -10;
const BANK_ID = 'main';

export class ChannelBank {
  private app: express.Application;
  private providerUrl: string;
  private homeUrl: string;
  private restBaseUrl: string;
  private restRelativeBaseUrl: string;
  private bankUrl: string;
  private bankInfo: BankInfo;
  private bankKeyInfo: KeyInfo;

  constructor(app: express.Application, server: net.Server) {
    this.app = app;
    this.providerUrl = url.resolve(configuration.get('baseClientUri'), "/channel-elements.json");
    this.homeUrl = configuration.get('baseClientUri');
    this.restBaseUrl = configuration.get('baseClientUri');
    this.bankUrl = this.getServicesList().descriptionUrl;
    this.restRelativeBaseUrl = DYNAMIC_BASE;
    this.registerHandlers(this.restRelativeBaseUrl);
  }

  async start(): Promise<void> {
    this.bankInfo = await db.findBank(BANK_ID);
    while (!this.bankInfo) {
      const privateKey = ChannelIdentityUtils.generatePrivateKey();
      const keyInfo = ChannelIdentityUtils.getKeyInfo(privateKey);
      try {
        console.log("ChannelBank.start: creating new bank");
        this.bankInfo = await db.insertBank(BANK_ID, 'Channel Elements Bank', new Buffer(privateKey).toString('hex'));
      } catch (err) {
        console.error("ChannelBank.start: Error inserting bank.  Collision?", err);
        this.bankInfo = await db.findBank(BANK_ID);
      }
    }
    const privateKey = Buffer.from(this.bankInfo.privateKey, "hex");
    this.bankKeyInfo = ChannelIdentityUtils.getKeyInfo(privateKey);
  }

  private registerHandlers(restRelativeBaseUrl: string): void {
    this.app.get('/channel-bank.json', (request: Request, response: Response) => {
      void this.handleDescriptionRequest(request, response);
    });
    this.app.post(restRelativeBaseUrl + '/bank', (request: Request, response: Response) => {
      void this.handleBankRequest(request, response);
    });
  }

  private async handleDescriptionRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelBank.handleDescriptionRequest");
    const reply: ChannelBankDescription = {
      protocol: BANKING_PROTOCOL,
      bank: {
        name: "Channel Elements Bank",
        logo: url.resolve(configuration.get('baseClientUri'), '/s/logo.png'),
        homepage: configuration.get('baseClientUri'),
        publicKey: this.bankKeyInfo.publicKeyPem,
        details: {}
      },
      implementation: {
        name: "Channel Elements Reference Bank",
        logo: url.resolve(configuration.get('baseClientUri'), '/s/logo.png'),
        homepage: "https://github.com/ChannelElementsTeam/channel-server",
        version: "0.1.0",
        extensions: {}
      },
      serviceEndpoints: this.getServicesList()
    };
    response.json(reply);
  }

  getServicesList(): BankServiceEndpoints {
    const result: BankServiceEndpoints = {
      descriptionUrl: this.providerUrl,
      homeUrl: this.homeUrl,
      restServiceUrl: url.resolve(this.restBaseUrl, this.restRelativeBaseUrl + '/bank'),
    };
    return result;
  }

  private async handleBankRequest(request: Request, response: Response): Promise<void> {
    const serviceRequest = request.body as BankServiceRequest<SignedAddressIdentity | SignedKeyIdentity, any>;
    if (!serviceRequest || !serviceRequest.type || !serviceRequest.identity) {
      response.status(400).send("Invalid request structure");
      return;
    }
    switch (serviceRequest.type) {
      case 'open-account':
        await this.handleOpenAccountRequest(request, response);
        break;
      case 'get-account':
        await this.handleGetAccountRequest(request, response);
        break;
      case 'transfer':
        await this.handleTransferRequest(request, response);
        break;
      default:
        response.status(400).send("Invalid request type");
        break;
    }
  }

  private async handleOpenAccountRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelBank.handleOpenAccountRequest");
    const openRequest = request.body as BankServiceRequest<SignedKeyIdentity, BankOpenAccountDetails>;
    const fullIdentity = await this.validateFullIdentity(openRequest.identity, response);
    if (!fullIdentity) {
      return;
    }
    const existing = await this.getAccountRecord(fullIdentity.address);
    if (existing) {
      response.status(409).send("You already have an account");
      return;
    }
    await this.openAccount(openRequest.identity, fullIdentity, response);
  }

  private async handleGetAccountRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelBank.handleGetAccountRequest");
    const getRequest = request.body as BankServiceRequest<SignedAddressIdentity, BankGetAccountDetails>;
    const accountRecord = await this.getAccountRecord(getRequest.identity.address);
    if (!this.validateAddressIdentity(getRequest.identity, accountRecord, response)) {
      return;
    }
    await this.respondWithAccount(accountRecord, response);
  }

  private async handleTransferRequest(request: Request, response: Response): Promise<void> {
    console.log("ChannelBank.handleTransferRequest");
    const transferRequest = request.body as BankServiceRequest<SignedAddressIdentity, BankTransferDetails>;
    const accountRecord = await this.getAccountRecord(transferRequest.identity.address);
    if (!this.validateAddressIdentity(transferRequest.identity, accountRecord, response)) {
      return;
    }
    if (!transferRequest.details || !transferRequest.details.amount || !transferRequest.details.to || !transferRequest.details.to.accountAddress || !transferRequest.details.to.bankUrl) {
      response.status(400).send("Invalid transfer request");
      return;
    }
    if (transferRequest.details.amount <= 0) {
      response.status(400).send("Transfer amount cannot be less than zero");
      return;
    }
    if (accountRecord.balance - transferRequest.details.amount < MINIMUM_ACCOUNT_BALANCE) {
      response.status(402).send("Refused:  insufficient funds");
      return;
    }
    await this.transfer(accountRecord, transferRequest.details, response);
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
      response.status(401).send("Invalid identity signature or signedAt");
      return null;
    }
    return keyIdentity;
  }

  private validateAddressIdentity(signedIdentity: SignedAddressIdentity, accountRecord: BankAccountRecord, response: Response): AddressIdentity {
    if (!accountRecord) {
      response.status(404).send("No bank account");
      return null;
    }
    if (!signedIdentity || !signedIdentity.signature || !signedIdentity.address) {
      response.status(400).send("Invalid identity");
      return null;
    }
    const addressIdentity = ChannelIdentityUtils.decode<AddressIdentity>(signedIdentity.signature, accountRecord.identity.publicKey, Date.now());
    if (!addressIdentity || !addressIdentity.address || addressIdentity.address !== signedIdentity.address) {
      response.status(401).send("Invalid identity signature or signedAt");
    }
    return addressIdentity;
  }

  private async getAccountRecord(accountAddress: string): Promise<BankAccountRecord> {
    if (!accountAddress) {
      return null;
    }
    const result = await db.findBankAccountByAddress(accountAddress);
    if (result && result.status === 'active') {
      return result;
    }
    return null;
  }

  private async openAccount(signedIdentity: SignedKeyIdentity, fullIdentity: FullIdentity, response: Response): Promise<void> {
    const account = await db.insertBankAccount(signedIdentity, fullIdentity, 'active');
    await this.respondWithAccount(account, response);
  }

  private async respondWithAccount(account: BankAccountRecord, response: Response): Promise<void> {
    const reply: BankGetAccountResponse = {
      accountAddress: account.identity.address,
      balance: account.balance,
      lastTransaction: account.lastTransaction
    };
    response.json(reply);
  }

  private async transfer(account: BankAccountRecord, details: BankTransferDetails, response: Response): Promise<void> {
    if (details.to.bankUrl !== this.bankUrl) {
      response.status(550).send("No relationship with recipient's bank");
      return;
    }
    const transactionId = uuid.v4();
    const now = Date.now();
    const from: BankAccountInformation = {
      accountAddress: account.identity.address,
      bankUrl: this.bankUrl
    };
    await db.insertBankTransaction(transactionId, details.requestReference, from, details.to, now, 'pending', []);
    await db.insertBankAccountTransaction(account.identity.address, transactionId, details.requestReference, transactionId, 'transfer-from', details.amount, now, from, details.to, 'complete');
    await db.insertBankAccountTransaction(details.to.accountAddress, transactionId, details.requestReference, transactionId, 'transfer-to', details.amount, now, from, details.to, 'complete');
    await db.incrementBankAccountBalance(account.identity.address, -details.amount, now);
    await db.incrementBankAccountBalance(details.to.accountAddress, details.amount, now);
    const receipt: BankTransferReceipt = {
      requestReference: details.requestReference,
      bankReference: transactionId,
      amount: details.amount,
      timestamp: now,
      from: from,
      to: details.to,
      signedAt: Date.now()
    };
    const signature = ChannelIdentityUtils.sign(this.bankKeyInfo, receipt);
    const reply: BankTransferResponse = {
      signedReceipts: []
    };
    reply.signedReceipts.push({
      bankUrl: this.bankUrl,
      signedReceipt: signature
    });
    await db.updateBankTransactionStatusAndReceipts(transactionId, 'complete', reply.signedReceipts);
    response.json(reply);
  }
}
