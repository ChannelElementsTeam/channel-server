import * as express from "express";
import { Request, Response } from 'express';
import * as net from 'net';

import { ChannelMemberRecord, UserRecord } from "./interfaces/db-records";
import { ControlChannelMessage } from "./interfaces/channel-server-interfaces";
import { ChannelUtils, MessageInfo } from "./channel-utils";

export class TransportServer {
  private expressWs: any;
  private wsapp: ExpressWithChannelSockets;
  private controller: TransportEventHandler;
  private socketsById: { [socketId: string]: ChannelSocket } = {};
  relativeTransportUrl: string;

  constructor(app: express.Application, server: net.Server, controller: TransportEventHandler, relativeTransportUrl: string) {
    require('express-ws')(app, server);
    this.wsapp = app as ExpressWithChannelSockets;
    this.controller = controller;
    this.relativeTransportUrl = relativeTransportUrl;
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
      const messageInfo = await ChannelUtils.parseChannelMessage(message as Uint8Array);
      if (messageInfo.valid) {
        const directive = await this.controller.handleReceivedMessage(messageInfo.info, socketId);
        for (const targetSocketId of directive.forwardMessageToSockets) {
          const socket = this.socketsById[targetSocketId];
          socket.send(message);
        }
        for (const delivery of directive.deliverControlMessages) {
          const socket = this.socketsById[delivery.socketId];
          socket.send(ChannelUtils.serializeControlMessage(delivery.controlMessage.requestId, delivery.controlMessage.type, delivery.controlMessage.details));
        }
      } else {
        console.warn("Transport: received invalid message on socket", socketId);
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
      socket.send(message);
      return true;
    } else {
      console.error("Transport: no such socket for control message delivery");
      return false;
    }
  }

  getBufferedAmount(socketId: string): number {
    return this.socketsById[socketId] ? this.socketsById[socketId].bufferedAmount : 0;
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
  handleReceivedMessage(messageInfo: MessageInfo, socketId: string): Promise<MessageHandlingDirective>;
}

export interface ControlMessageDirective {
  controlMessage: ControlChannelMessage;
  socketId: string;
}

export interface MessageHandlingDirective {
  forwardMessageToSockets: string[];
  deliverControlMessages: ControlMessageDirective[];
}
