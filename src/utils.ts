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

}
