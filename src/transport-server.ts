import * as express from "express";
import { Request, Response } from 'express';
import * as net from 'net';

import { ChannelMemberRecord, UserRecord } from "./interfaces/db-records";
import { ControlChannelMessage, ChannelMessageUtils, DeserializedMessage, ChannelMessage } from "./common/channel-server-messages";
import { configuration } from "./configuration";

export class TransportServer {
  private expressWs: any;
  private lastChannelCheck = Date.now();
  private wsapp: ExpressWithChannelSockets;
  private controller: TransportEventHandler;
  private socketsById: { [socketId: string]: ChannelSocket } = {};
  relativeTransportUrl: string;
  private logRx: boolean;
  private logTx: boolean;

  constructor(app: express.Application, server: net.Server, controller: TransportEventHandler, relativeTransportUrl: string) {
    require('express-ws')(app, server);
    this.wsapp = app as ExpressWithChannelSockets;
    this.controller = controller;
    this.relativeTransportUrl = relativeTransportUrl;
    this.logRx = configuration.get('debug.transport.log.rx', false) as boolean;
    this.logTx = configuration.get('debug.transport.log.tx', false) as boolean;
  }

  start(): void {
    this.wsapp.ws(this.relativeTransportUrl, (ws: ChannelSocket, request: Request) => {
      console.log("Transport: connection requested");
      void this.controller.handleSocketConnectRequest(request).then((socketId: string) => {
        if (socketId) {
          this.socketsById[socketId] = ws;
          ws.on('message', (message: Uint8Array | string) => {
            void this.handleChannelSocketMessage(ws, message, socketId);
            return false;
          });
          ws.on('close', () => {
            void this.handleChannelSocketClose(ws, request, socketId);
          });
          console.log("Transport: connection accepted", socketId);
        } else {
          ws.close();
          console.log("Transport: connection rejected");
        }
      });
    });
  }

  private async handleChannelSocketMessage(ws: ChannelSocket, message: Uint8Array | string, socketId: string): Promise<void> {
    if (message instanceof Uint8Array) {
      const messageInfo = await ChannelMessageUtils.parseChannelMessage(message as Uint8Array);
      if (this.logRx) {
        console.log("Transport: Rx ", socketId, messageInfo.valid, messageInfo.errorMessage, messageInfo.contents.channelCode, messageInfo.contents.senderCode, messageInfo.contents.timestamp, messageInfo.contents.fullPayload.length);
      }
      if (messageInfo.valid) {
        const directive = await this.controller.handleReceivedMessage(messageInfo.contents, socketId);
        for (const targetSocketId of directive.forwardMessageToSockets) {
          const socket = this.socketsById[targetSocketId];
          try {
            socket.send(message);
            if (this.logTx) {
              console.log("Transport: Tx (switched)", targetSocketId, message.byteLength);
            }
          } catch (err) {
            console.warn("Transport: Failure trying to send on socket", socketId, err);
          }
        }
        for (const delivery of directive.deliverControlMessages) {
          const socket = this.socketsById[delivery.socketId];
          try {
            socket.send(ChannelMessageUtils.serializeControlMessage(delivery.controlMessage.requestId, delivery.controlMessage.type, delivery.controlMessage.details));
          } catch (err) {
            console.warn("Transport: Failure trying to send control message on socket", socketId, err);
          }
        }
      } else {
        console.warn("Transport: received invalid message on socket: " + messageInfo.errorMessage, socketId);
      }
    } else {
      console.warn("Transport: received string message on socket.  Ignoring.", message);
    }
  }

  private async handleChannelSocketClose(ws: ChannelSocket, request: Request, socketId: string): Promise<void> {
    console.log("Transport: connection closed", socketId);
    delete this.socketsById[socketId];
    await this.controller.handleSocketClosed(socketId);
  }

  async deliverMessage(message: Uint8Array, socketId: string): Promise<boolean> {
    const socket = this.socketsById[socketId];
    if (socket) {
      try {
        socket.send(message);
      } catch (err) {
        console.warn("Transport: Failure trying to deliver message on socket", socketId, err);
        return false;
      }
      return true;
    } else {
      console.error("Transport: no such socket for control message delivery");
      return false;
    }
  }

  getBufferedAmount(socketId: string): number {
    return this.socketsById[socketId] ? this.socketsById[socketId].bufferedAmount : 0;
  }

  closeSocket(socketId: string): void {
    if (this.socketsById[socketId]) {
      this.socketsById[socketId].close();
    }
  }
}

interface ChannelSocket {
  on: (event: string, handler: (arg?: any) => void) => void;
  send: (contents: Uint8Array) => void;
  close: () => void;
  bufferedAmount: number;
}

interface ExpressWithChannelSockets extends express.Application {
  ws: (path: string, callback: (ws: any, request: Request) => void) => void;
}

export interface TransportEventHandler {
  handleSocketConnectRequest(request: Request): Promise<string>;
  handleSocketClosed(socketId: string): Promise<void>;
  handleReceivedMessage(messageInfo: ChannelMessage, socketId: string): Promise<MessageHandlingDirective>;
}

export interface ControlMessageDirective {
  controlMessage: ControlChannelMessage;
  socketId: string;
}

export interface MessageHandlingDirective {
  forwardMessageToSockets: string[];
  deliverControlMessages: ControlMessageDirective[];
}
