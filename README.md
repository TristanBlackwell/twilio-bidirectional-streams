# Twilio bi-directional streams

## Prerequisites

- Node V20.16.0

## Getting started

### Twilio setup

1. Create a new [TwiML bin](https://console.twilio.com/us1/develop/twiml-bins/twiml-bins?frameUrl=%2Fconsole%2Ftwiml-bins%3Fx-target-region%3Dus1) called _media-stream_. Use the TwiML below and make a note of the bin URL.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  	<Say>Please state your name and age.</Say>
    <Connect>
        <Stream name="Media Stream" url="wss://<SERVER_URL>/streams" />
    </Connect>
</Response>
```

2. Create a new [Studio Flow](https://console.twilio.com/us1/develop/studio/flows?frameUrl=/console/studio/flows), selecting the _Import from JSON_ option. Use the JSON provided in the [basic flow](./studio/basic.json) as the contents. Make note of the Flow SID for later.

3. Update the _redirect\_gather_ widget to point at your previously created TwiMl bin URL. 
   
   ![TwiML redirect Studio widget](/docs/images/twiml-redirect-studio-widget.png) 

### Running the server

1. Run `npm install` to download all the necessary dependencies.
2. Copy the [`.env.example`](.env.example) to a `.env` file and populate the values.
3. Run the server with `npm start`
4. Update the Twiml bin to replace `<SERVER_URL>` with the URL of your server. You may need Ngrok if you are running this locally.