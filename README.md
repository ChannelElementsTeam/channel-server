# channel-server
This is a complete reference implementation of a Channel Elements service provider.

The full details and specifications for the Channel Elements Server can be found in the Wiki.

To run this reference server, 

1. Clone or download this project

2. Download and install [MongoDb](https://www.mongodb.com/download-center#community), or you can update the configuration (config.json) to point to an external Mongo server.

3. Run **mongod** to start Mongo running

4. Download and install [NodeJs](https://nodejs.org/en)

5. Install typescript:  **npm install -g typescript**

5. Install ts-node:  **npm install -g ts-node**

7. Update the **config.json** file in the root folder of this project, if you need something special

8. Run the server:  **ts-node --project ./**

Your server should now be running.  You should be able to connect to it with any ChannelElements-compatible client.
