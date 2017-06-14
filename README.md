# channel-server
This is a complete reference implementation of a Channel Elements service provider.

The full details and specifications for the Channel Elements Server can be found in the [Wiki](https://github.com/ChannelElementsTeam/channel-server/wiki).

This server should be able to run on most systems but is primarily tested on MacOS systems.  

It depends on [typescript](https://www.typescriptlang.org/), [npm](https://www.npmjs.com/), [Node.js](https://nodejs.org), and [MongoDb](https://www.mongodb.com).  

To get started:

* [Download MongoDB](https://www.mongodb.com/download-center) and run **./mongod** from its **bin** folder.  Alternatively, you can use an existing mongo server in which case you'll need to configure ChannelElements config.json file with the appropriate **mongo** settings.

* [Download and install npm and Node](https://www.npmjs.com/get-npm)

* Install typescript dependencies

    npm install -g typescript
    npm install -g ts-node

* From the root folder where you downloaded this project, install other dependencies

    npm install

* Run the server

    ts-node --project ./ src/index.ts

* Verify that it is running

    curl "http://localhost:31111/channel-elements.json"

This will return a JSON-encoded structure that describes the server.

You should now be able to connect to this server with any ChannelElements-compatible client.
