export interface ChannelMemberInfo {
  identity: SignedFullIdentity;
  isCreator: boolean;
  memberSince: number;
  lastActive: number;
}

export interface SignedFullIdentity extends Signed<SignableFullIdentity> { }

export interface SignedBasicIdentity extends Signed<SignableBasicIdentity> { }

export interface SignedAddress extends Signed<SignableAddress> { }
export interface Signed<T extends Signable> {
  info: T;
  signature: string;
}

export interface SignableFullIdentity extends SignableBasicIdentity {
  account?: string;
  name?: string;
  imageUrl?: string;
  contactMeShareCode?: string;
  details?: any;
}

export interface SignableBasicIdentity extends SignableAddress {
  publicKey: string;
}
export interface SignableAddress extends Signable {
  address: string;
}

export interface Signable {
  signedAt: number;
}
