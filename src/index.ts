import * as express from "express";
import { Express, Request, Response } from 'express';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as compression from "compression";
import * as bodyParser from "body-parser";
import * as cookieParser from "cookie-parser";
import * as path from "path";
import * as fs from 'fs';
import * as url from 'url';

import { configuration } from "./configuration";
import { db } from './db';
import { ChannelServer } from './channel-server';
import { BraidResponse } from "./interfaces/channel-server-interfaces";

import { clientTester } from './testing/client-test';

const VERSION = 1;
const DYNAMIC_BASE = '/d';

class BraidCommServer {
  private app: express.Application;
  private server: net.Server;
  private expressWs: any;
  private started: number;
  private channelServer: ChannelServer;

  async start(): Promise<void> {
    this.setupExceptionHandling();
    await this.setupConfiguration();
    await db.initialize();
    await this.setupExpress();
    this.channelServer = new ChannelServer(this.app, this.server, url.resolve(configuration.get('baseClientUri'), "/braid.json"), configuration.get('baseClientUri'), configuration.get('baseClientUri'), DYNAMIC_BASE, configuration.get('baseTransportUri'), '/transport/s1');
    await this.channelServer.start();
    await this.setupServerPing();
    this.started = Date.now();

    clientTester.initialize(this.app);

    console.log("Braid server running");
  }

  private setupBraidResponse() {
    this.app.get('/braid.json', (request: Request, response: Response) => {
      const reply: BraidResponse = {
        version: 1,
        services: this.channelServer.getServicesList(),
      };
      response.json(reply);
    });
  }

  private setupExceptionHandling(): void {
    process.on('exit', (code: any) => {
      console.log(`About to exit with code: ${code}`);
    });

    const onExit = require('signal-exit');

    onExit((code: any, signal: any) => {
      console.log('process exiting!');
      console.log(code, signal);
    });

    process.on('unhandledRejection', (reason: any) => {
      console.error("Unhandled Rejection!", JSON.stringify(reason), reason.stack);
    });

    process.on('uncaughtException', (err: any) => {
      console.error("Unhandled Exception!", err.toString(), err.stack);
    });
  }

  private async setupConfiguration(): Promise<void> {
    for (let i = 0; i < process.argv.length - 1; i++) {
      if (process.argv[i] === '-c') {
        await configuration.load(process.argv[i + 1]);
        return;
      }
    }
    await configuration.load('./config.json');
  }

  private async setupExpress(): Promise<void> {
    this.app = express();

    this.app.use(compression());
    this.app.use(bodyParser.json()); // for parsing application/json
    this.app.use(bodyParser.urlencoded({
      extended: true
    }));
    this.app.use(cookieParser());

    this.app.use('/v' + VERSION, express.static(path.join(__dirname, '../public'), { maxAge: 1000 * 60 * 60 * 24 * 7 }));
    this.app.use('/s', express.static(path.join(__dirname, "../static"), { maxAge: 1000 * 60 * 60 * 24 * 7 }));
    if (configuration.get('client.ssl')) {
      const privateKey = fs.readFileSync(configuration.get('ssl.key'), 'utf8');
      const certificate = fs.readFileSync(configuration.get('ssl.cert'), 'utf8');
      const credentials: any = {
        key: privateKey,
        cert: certificate
      };
      const ca = this.getCertificateAuthority();
      if (ca) {
        credentials.ca = ca;
      }
      this.server = https.createServer(credentials, this.app);
    } else {
      this.server = http.createServer(this.app);
    }
    this.server.listen(configuration.get('client.port'), (err: any) => {
      if (err) {
        console.error("Failure listening", err);
        process.exit();
      } else {
        console.log("Listening for client connections on port " + configuration.get('client.port'));
      }
    });
  }

  private getCertificateAuthority(): string[] {
    let ca: string[];
    if (configuration.get('ssl.ca')) {
      ca = [];
      const chain = fs.readFileSync(configuration.get('ssl.ca'), 'utf8');
      const chains = chain.split("\n");
      let cert: string[] = [];
      for (const line of chains) {
        if (line.length > 0) {
          cert.push(line);
          if (line.match(/-END CERTIFICATE-/)) {
            ca.push(cert.join('\n'));
            cert = [];
          }
        }
      }
    }
    return ca;
  }

  private setupServerPing(): void {
    this.app.get(DYNAMIC_BASE + '/ping', (request: Request, response: Response) => {
      response.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
      response.setHeader('Content-Type', 'application/json');
      const result: any = {
        product: 'Braid-Comm-Server',
        status: 'OK',
        version: VERSION,
        deployed: new Date(this.started).toISOString(),
        server: configuration.get('serverId')
      };
    });
  }

}

const server = new BraidCommServer();

void server.start();
