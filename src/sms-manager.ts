import * as express from "express";
import { Request, Response } from 'express';
import twilio = require('twilio');
import { configuration } from "./configuration";

export class SmsManager {
  private smsClient: twilio.RestClient;
  private handler: SmsInboundMessageHandler;

  async initialize(app: express.Application): Promise<void> {
    if (!configuration.get('sms.disabled')) {
      this.smsClient = new twilio.RestClient(configuration.get('sms.twilio.accountSid'), configuration.get('sms.twilio.authToken'));
    }
    app.post('/d/twilio', (request: Request, response: Response) => {
      void this.handleTwilioCallback(request, response);
    });
  }

  setHandler(handler: SmsInboundMessageHandler): void {
    this.handler = handler;
  }

  async send(toNumber: string, messageBody: string): Promise<void> {
    const fromNumber = Utils.cleanPhoneNumber(configuration.get('sms.phoneNumber'));
    if (!fromNumber) {
      throw new Error("Configuration does not have sms.phoneNumber");
    }
    if (this.smsClient) {
      const message = await this.smsClient.messages.create({
        to: toNumber,
        from: fromNumber,
        body: messageBody
      });
    } else {
      console.log("Sms: outbound message suppressed", {
        to: toNumber,
        from: fromNumber,
        body: messageBody
      });
    }
  }

  private async handleTwilioCallback(request: Request, response: Response): Promise<void> {
    const notification = request.body;
    if (!notification || !notification.To || !notification.From || !notification.Body) {
      return new RestServiceResult(null, 400, "Invalid Twilio notification");
    }
    if (!configuration.get('sms.twilio.skipValidation', false)) {
      const options: twilio.WebhookExpressOptions = {
        url: url.resolve(configuration.get('baseClientUri'), '/d/twilio')
      };
      if (!twilio.validateExpressRequest(request, configuration.get('sms.twilio.authToken'), options)) {
        console.warn("Sms: Invalid twilio request!  Ignoring", request.url, request.body);
        response.status(403).send("Twilio request is not valid");
        return;
      }
    }
    const from = Utils.cleanPhoneNumber(notification.From);
    const to = Utils.cleanPhoneNumber(notification.To);
    const messageBody = notification.Body.trim();
    let responseBody: string;
    if (this.handler) {
      responseBody = await this.handler.handleInboundSms(from, to, messageBody);
    }
    const twiml = new twilio.TwimlResponse();
    if (responseBody) {
      twiml.message(responseBody);
    }
    response.type('text/xml');
    response.status(200).send(twiml.toString());
    console.log("Sms: responding to Twilio callback", from, to, messageBody, responseBody);
  }
}

const smsManager = new SmsManager();

export { smsManager };

export interface SmsInboundMessageHandler {
  handleInboundSms(from: string, to: string, messageBody: string): Promise<string>;
}
