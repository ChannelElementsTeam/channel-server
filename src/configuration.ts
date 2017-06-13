import fs = require('fs');

export class Configuration {
  private data: any = {};
  async load(path: string): Promise<void> {
    console.log("Reading configuration from " + path);
    const data = fs.readFileSync(path, 'utf8');
    this.data = JSON.parse(data);
    if (this.data.mongo && this.data.mongo.mongoUrl) {
      this.data.mongo.mongoUrl = this.data.mongo.mongoUrl.split("{domain}").join(this.data.domain.split(".").join("_"));
    }
  }

  get(key: string, defaultValue?: any): any {
    const parts = key.split('.');
    let data = this.data;
    for (const part of parts) {
      if (data) {
        data = data[part];
      }
    }
    if (typeof data !== 'undefined') {
      return data;
    } else if (typeof defaultValue !== 'undefined') {
      return defaultValue;
    } else {
      return null;
    }
  }

}

const configuration = new Configuration();

export { configuration };
