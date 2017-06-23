import * as forge from 'node-forge';
const jws = require('jws');
import { SignedChannelMemberIdentity, ChannelMemberIdentity } from "./channel-server-messages";
const ethereumUtils = require('ethereumjs-utils');

export interface KeyPair {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}
export class ChannelIdentityUtils {
  static async generateKeyPair(): Promise<KeyPair> {
    return new Promise<KeyPair>((resolve, reject) => {
      forge.pki.rsa.generateKeyPair({ bits: 1024, workers: -1 }, (err: Error, keyPair: forge.pki.KeyPair) => {
        if (err) {
          reject(err);
        } else {
          resolve({
            privateKey: forge.pki.privateKeyToPem(keyPair.privateKey),
            publicKey: forge.pki.publicKeyToPem(keyPair.publicKey),
            fingerprint: forge.pki.
          });
        }
      });
    });
  }

  static createSignedChannelMemberIdentity(keyPair: KeyPair, name?: string, imageUrl?: string, contactMeShareCode?: string, details?: any): SignedChannelMemberIdentity {
    const identity: ChannelMemberIdentity = {
      address: this.computeAddressFromPrivateKey(keyPair.privateKeyBytes),
      publicKey: keyPair.publicKey,
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
      signature: this.computeSignature(identity, keyPair.privateKey)
    };
    return result;
  }

  static computeAddressFromPrivateKey(privateKeyBytes: Uint8Array): string {

  }

  static computeAddressFromPublicKey(publicKeyBytes: Uint8Array): string {

  }

  static computeSignature(object: any, privateKeyPem: string): string {

  }

  static verifySignature(object: any, publicKeyPem: string): boolean {

  }

}
