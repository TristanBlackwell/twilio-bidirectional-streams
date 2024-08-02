const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const http = require("http");
const HttpDispatcher = require("httpdispatcher");
const { log, validateAndRetrieveEnv } = require("./util");
const {
  MULAW_HEADER,
  HTTP_SERVER_PORT,
  REPEAT_THRESHOLD,
} = require("./constants");
const WebSocketServer = require("websocket").server;

const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest);

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FLOW_SID,
  OPENAI_API_KEY,
} = validateAndRetrieveEnv();

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

dispatcher.onPost("/twiml", function (req, res) {
  log("POST TwiML");

  let filePath = path.join(__dirname + "/templates", "streams.xml");
  let stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": stat.size,
  });

  const readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

mediaws.on("connect", function (connection) {
  log("From Twilio: Connection accepted");
  new MediaStream(connection);
});

class MediaStream {
  constructor(connection) {
    this.connection = connection;
    connection.on("message", async (message) => {
      try {
        await this.processMessage(message);
      } catch (error) {
        console.error("Error processing message:", error);
      }
    });

    connection.on("close", this.close.bind(this));

    this.callSid = "";
    this.hasSeenMedia = false;
    this.messages = [];
    this.repeatCount = 0;
    this.transcribing = false;

    this.wstream = fs.createWriteStream("./audio.wav", {
      encoding: "binary",
    });
    this.wstream.write(MULAW_HEADER);
  }

  /**
   * Takes a websocket message and identifies the appropriate action
   * based of the event.
   * @param {*} message
   */
  async processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      switch (data.event) {
        case "connected":
          log("From Twilio: Connected event received: ", data);
          break;
        case "start":
          log("From Twilio: Start event received: ", data);
          this.callSid = data.start.callSid;
          break;
        case "media":
          if (!this.hasSeenMedia) {
            log("From Twilio: Media event received: ", data);
            log("Server: Suppressing additional messages...");
            this.hasSeenMedia = true;
          }
          // Store media messages
          this.messages.push(data);
          if (this.messages.length >= REPEAT_THRESHOLD) {
            if (!this.transcribing) {
              log(
                `From Twilio: ${this.messages.length} omitted media messages`
              );
            }
            await this.write();
          }
          break;
        case "mark":
          log("From Twilio: Mark event received", data);
          break;
        case "close":
          log("From Twilio: Close event received: ", data);
          this.close();
          break;
      }
    } else if (message.type === "binary") {
      log("From Twilio: binary message received (not supported)");
    }
  }

  /**
   * Sends messages received from Twilio back to the sender
   * causing an _echo_ style communication.
   */
  async repeat() {
    const messages = [...this.messages];
    this.messages = [];
    const streamSid = messages[0].streamSid;

    // Decode each message and store the bytes in an array
    const messageByteBuffers = messages.map((msg) =>
      Buffer.from(msg.media.payload, "base64")
    );
    // Combine all the bytes, and then base64 encode the entire payload.
    const payload = Buffer.concat(messageByteBuffers).toString("base64");
    const message = {
      event: "media",
      streamSid,
      media: {
        payload,
      },
    };
    const messageJSON = JSON.stringify(message);
    const payloadRE = /"payload":"[^"]*"/gi;
    log(
      `To Twilio: A single media event containing the exact audio from your previous ${messages.length} inbound media messages`,
      messageJSON.replace(
        payloadRE,
        `"payload":"an omitted base64 encoded string with length of ${message.media.payload.length} characters"`
      )
    );
    this.connection.sendUTF(messageJSON);

    // Send a mark message
    const markMessage = {
      event: "mark",
      streamSid,
      mark: {
        name: `Repeat message ${this.repeatCount}`,
      },
    };
    log("To Twilio: Sending mark event", markMessage);
    this.connection.sendUTF(JSON.stringify(markMessage));
    this.repeatCount++;

    this.wstream.write(Buffer.concat(messageByteBuffers));

    if (this.repeatCount === 7) {
      log(`Server: Repeated ${this.repeatCount} times...closing`);
      this.connection.close(1000, "Repeated 7 times");
    }
  }

  /**
   * Writes messages received from Twilio to an Array.
   */
  async write() {
    const messages = [...this.messages];
    this.messages = [];

    // Decode each message and store the bytes in an array
    const messageByteBuffers = messages.map((msg) =>
      Buffer.from(msg.media.payload, "base64")
    );

    this.repeatCount++;

    // Add the messages to our write stream.
    this.wstream.write(Buffer.concat(messageByteBuffers));

    if (this.repeatCount === 7) {
      log(
        `Server: Repeated ${this.repeatCount} times. Starting transcription...`
      );

      await this.transcribe();
    }
  }

  async transcribe() {
    this.transcribing = true;
    // Our write streams contains the audio bits received from Twilio. The only thing left to do is
    // add the mulaw header.
    this.wstream.write("", () => {
      let fd = fs.openSync(this.wstream.path, "r+"); // `r+` mode is needed in order to write to an arbitrary position
      let count = this.wstream.bytesWritten;
      count -= 58; // The header itself is 58 bytes long and we only want the data byte length
      fs.writeSync(
        fd,
        Buffer.from([
          count % 256,
          (count >> 8) % 256,
          (count >> 16) % 256,
          (count >> 24) % 256,
        ]),
        0,
        4, // Write 4 bytes
        54 // starts writing at byte 54 in the file
      );
    });

    log("File prepared, passing to Whisper to transcribe...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream("audio.wav"),
      model: "whisper-1",
    });
    log(`Whisper transcription: ${transcription.text}`);

    log("Passing transcription to gpt-3.5 for summarisation");
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a assistant designed to output JSON. When given a user message attempt to extract their name and age returning the respective JSON object that can be parsed in JavaScript. If you cannot identify these, the property should be null",
        },
        { role: "user", content: transcription.text },
      ],
      model: "gpt-3.5-turbo-0125",
      response_format: { type: "json_object" },
    });

    const json = completion.choices[0].message.content.replace(/\n/g, "");
    let { name, age } = JSON.parse(json);

    if (name && age) {
      log(
        "Name & age summarised from transcription. Returning control to Studio..."
      );

      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${this.callSid}.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization:
              "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
          },
          body: `Twiml=<?xml version="1.0" encoding="UTF-8"?><Response><Redirect>https://webhooks.twilio.com/v1/Accounts/${TWILIO_ACCOUNT_SID}/Flows/${TWILIO_FLOW_SID}?FlowEvent=return%26amp%3Bname=${name}%26amp%3Bage=${age}</Redirect></Response>`,
        }
      );

      const body = await res.json();
      if (res.ok) {
        log("Control returned. Websocket connection closing...");
        this.transcribing = false;
      } else {
        log("Bad response from Twilio: ", res.status, body);
        this.connection.close(1000, "Unable to pass control back to Studio.");
        this.transcribing = false;
      }
    } else {
      log("Name and age not identified");
      this.connection.close(1000, "Name and age not identified");
      this.transcribing = false;
    }
  }

  close() {
    log("Server: Closed");
  }
}

wsserver.listen(HTTP_SERVER_PORT, () => {
  log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
