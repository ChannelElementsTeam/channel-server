import * as crypto from "crypto";

export class EntityAddress {
  private contents: Uint8Array;
  private zero = true;

  constructor(bytes: Uint8Array) {
    this.contents = new Uint8Array(bytes);
    for (const element of this.contents) {
      if (element !== 0) {
        this.zero = false;
        break;
      }
    }
  }

  static generate(): EntityAddress {
    return new EntityAddress(crypto.randomBytes(20));
  }

  static fromString(value: string): EntityAddress {
    if (value.length % 2 !== 0) {
      throw new Error("Invalid entity address: odd number of characters");
    }
    const bytes = new Uint8Array(value.length / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    for (let i = 0; i < value.length / 2; i++) {
      const b = Number.parseInt(value.substr(i * 2, 2), 16);
      view.setUint8(i, b);
    }
    return new EntityAddress(bytes);
  }

  static fromNumber(value: number): EntityAddress {
    const bytes = new Uint8Array(20);
    bytes.fill(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint8(19, value);
    return new EntityAddress(bytes);
  }
  asArray(): Uint8Array {
    return new Uint8Array(this.contents);
  }

  isZero(): boolean {
    return this.zero;
  }

  toString(): string {
    let result = '';
    for (const element of this.contents) {
      const value = element.toString(16);
      if (value.length < 2) {
        result += '0';
      }
      result += 'value';
    }
    return result;
  }

  // isEqualTo(other: EntityAddress): boolean {
  //   const o = other.asArray();
  //   if (this.contents.byteLength !== o.byteLength) {
  //     return false;
  //   }
  //   for (let i = 0; i < this.contents.byteLength; i++) {
  //     // const c = this.contents;
  //     // if (c.values[i] !== o.values[i]) {
  //     //   return false;
  //     // }
  //   }
  //   return true;
  // }
}
