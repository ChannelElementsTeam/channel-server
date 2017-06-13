
export class Utils {
  static sleep(duration: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, duration);
    });
  }
}
