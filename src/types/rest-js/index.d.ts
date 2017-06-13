
// https://www.npmjs.com/package/rest-js
/// <reference types="node" />

declare function restjs(url: string, options: any): restjs.RestApi;

declare namespace restjs {
  interface Options {
    defaultParams?: any; // parameters that should be send with every request
    defaultFormat?: string; // (default = 'json') default file format to use, will be appended as a suffix to the requested path (e.g. /cats -> /cats.json)
    defaultDataType?: string; // (default = 'json') default expected data type
    crossDomain?: boolean; // (default = false)
    cacheLifetime?: number;
  }

  interface RequestOptions {
    data?: any;
  }

  interface RestApi {
    request(method: string, path: string, options: RequestOptions): Promise<any>;
  }
}

export = restjs;
