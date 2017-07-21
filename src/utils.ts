import * as crypto from "crypto";

const TOKEN_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export class Utils {
  static sleep(duration: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, duration);
    });
  }

  static createToken(length = 24): string {
    let result = '';
    const array = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      const letter = TOKEN_LETTERS.charAt(array[i] % TOKEN_LETTERS.length);
      result += letter;
    }
    return result;
  }

  static cleanPhoneNumber(phoneNumber: string, omitPlus?: boolean): string {
    if (!phoneNumber) {
      return null;
    }
    if (phoneNumber.startsWith('tel:')) {
      phoneNumber = phoneNumber.substring(4);
    }
    if (this.isNorthAmericanPhoneNumber(phoneNumber)) {
      phoneNumber = phoneNumber.replace(/\D/g, '');
      if (phoneNumber.startsWith('+')) {
        phoneNumber = phoneNumber.substr(1);
      }
      if (phoneNumber.startsWith('1')) {
        phoneNumber = phoneNumber.substr(1);
      }
      return (omitPlus ? '' : '+') + '1' + phoneNumber;
    } else {
      phoneNumber = phoneNumber.replace(/\D/g, '');
      if (phoneNumber.startsWith('+')) {
        phoneNumber = phoneNumber.substring(1);
      }
      return (omitPlus ? '' : '+') + phoneNumber;
    }
  }

  static isNorthAmericanPhoneNumber(phoneNumber: string): boolean {
    if (!phoneNumber) {
      return false;
    }
    phoneNumber = phoneNumber.trim();
    const phoneRegex = /^(\+?1\s?)?(\d{10}|\d{3}\-\d{3}\-\d{4}|\(d{3}\)\s?\d{3}\-?\d{4})$/i;
    return phoneRegex.test(phoneNumber);
  }

  static isPhoneNumber(phoneNumber: string): boolean {
    if (!phoneNumber) {
      return false;
    }
    phoneNumber = phoneNumber.trim();
    const phoneRegex = /^\+?\d[\d\-\(\)]+\d$/i;
    return phoneRegex.test(phoneNumber);
  }

  static escapeRegex(value: string): string {
    return value.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
  }
}
