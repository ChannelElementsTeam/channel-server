import { SignedChannelMemberIdentity, ChannelMemberIdentity } from "./channel-server-messages";
import { TextDecoder, TextEncoder } from 'text-encoding';
import * as crypto from 'crypto';
const secp256k1 = require('secp256k1');
const ethereumUtils = require('ethereumjs-util');
const KeyEncoder = require('key-encoder');
const jws = require('jws');

export interface KeyInfo {
  privateKeyBytes: Uint8Array;
  privateKeyPem: string;
  publicKeyBytes: Uint8Array;
  publicKeyPem: string;
  ethereumAddress: string;
  address: string;
}
export class ChannelIdentityUtils {

  static generatePrivateKey(): Uint8Array {
    let privateKeyBuffer: Buffer;
    do {
      privateKeyBuffer = crypto.randomBytes(32);
    } while (!secp256k1.privateKeyVerify(privateKeyBuffer));
    return new Uint8Array(privateKeyBuffer);
  }
  static getKeyInfo(privateKey: Uint8Array): KeyInfo {
    const publicKey = secp256k1.publicKeyCreate(new Buffer(privateKey)) as Uint8Array;
    const ethPublic = ethereumUtils.importPublic(new Buffer(publicKey)) as Uint8Array;
    const ethAddress = ethereumUtils.pubToAddress(ethPublic, false) as Uint8Array;
    const keyEncoder = new KeyEncoder('secp256k1');
    const result: KeyInfo = {
      privateKeyBytes: privateKey,
      privateKeyPem: keyEncoder.encodePrivate(new Buffer(privateKey).toString('hex'), 'raw', 'pem'),
      publicKeyBytes: publicKey,
      publicKeyPem: keyEncoder.encodePublic(new Buffer(publicKey).toString('hex'), 'raw', 'pem'),
      ethereumAddress: '0x' + new Buffer(ethAddress).toString('hex'),
      address: new Buffer(ethAddress).toString('base64')
    };
    return result;
  }

  static createSignedChannelMemberIdentity(keyInfo: KeyInfo, name?: string, imageUrl?: string, contactMeShareCode?: string, details?: any): SignedChannelMemberIdentity {
    const identity: ChannelMemberIdentity = {
      address: keyInfo.address,
      account: keyInfo.ethereumAddress,
      publicKey: keyInfo.publicKeyPem,
      signedAt: Date.now(),
    };
    if (name) {
      identity.name = name;
    }
    if (imageUrl) {
      identity.imageUrl = imageUrl;
    }
    if (contactMeShareCode) {
      identity.contactMeShareCode = contactMeShareCode;
    }
    if (details) {
      identity.details = details;
    }
    const result: SignedChannelMemberIdentity = {
      identity: identity,
      signature: this.sign(keyInfo, identity)
    };
    return result;
  }

  private static sign(keyInfo: KeyInfo, object: any): any {
    const hash = this.hash(object);
    const jwsSignature = jws.sign({
      header: { alg: 'RS256' },
      payload: object,
      privateKey: keyInfo.privateKeyPem
    });
    const verification = this.verify(hash, jwsSignature, keyInfo.publicKeyPem);
    if (!verification) {
      throw new Error("Sign/Verify is not working");
    }
    return jwsSignature;
  }

  static verifySignedChannelMemberIdentity(info: SignedChannelMemberIdentity, expectedSignTime: number): boolean {
    const hash = this.hash(info.identity);
    return this.verify(hash, info.signature, info.identity.publicKey);
  }

  private static verify(hash: string, signature: any, publicKeyPem: string): boolean {
    const hashBuffer = Buffer.from(hash, 'base64');
    try {
      return jws.verify(signature, 'RS256', publicKeyPem);
    } catch (err) {
      console.warn("ChannelIdentity.verify failure", err);
      return false;
    }
  }

  private static hash(object: any): string {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(object));
    return hash.digest('base64');
  }

}
