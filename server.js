const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

var http = require("http");
var HttpDispatcher = require("httpdispatcher");
var WebSocketServer = require("websocket").server;

var dispatcher = new HttpDispatcher();
var wsserver = http.createServer(handleRequest);

const accountSid = "AC...";
const authToken = "...";
const flowSid = "FW...";

const openai = new OpenAI({
  apiKey: "sk-...",
});

const mulawHeader = Buffer.from([
  0x52,
  0x49,
  0x46,
  0x46,
  0x62,
  0xb8,
  0x00,
  0x00,
  0x57,
  0x41,
  0x56,
  0x45,
  0x66,
  0x6d,
  0x74,
  0x20,
  0x12,
  0x00,
  0x00,
  0x00,
  0x07,
  0x00,
  0x01,
  0x00,
  0x40,
  0x1f,
  0x00,
  0x00,
  0x80,
  0x3e,
  0x00,
  0x00,
  0x02,
  0x00,
  0x04,
  0x00,
  0x00,
  0x00,
  0x66,
  0x61,
  0x63,
  0x74,
  0x04,
  0x00,
  0x00,
  0x00,
  0xc5,
  0x5b,
  0x00,
  0x00,
  0x64,
  0x61,
  0x74,
  0x61,
  0x00,
  0x00,
  0x00,
  0x00, // Those last 4 bytes are the data length
]);

const HTTP_SERVER_PORT = 8080;
const REPEAT_THRESHOLD = 50;

var mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

function log(message, ...args) {
  console.log(new Date(), message, ...args);
}

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

  var readStream = fs.createReadStream(filePath);
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
    //this.callSid = "";
    this.hasSeenMedia = false;
    this.messages = [];
    this.repeatCount = 0;

    this.wstream = fs.createWriteStream("./audio.wav", {
      encoding: "binary",
    });
    this.wstream.write(mulawHeader);
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
            log(`From Twilio: ${this.messages.length} omitted media messages`);
            await this.repeat();
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
      //this.connection.close(1000, "Repeated 7 times");

      this.wstream.write("", () => {
        let fd = fs.openSync(this.wstream.path, "r+"); // `r+` mode is needed in order to write to arbitrary position
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

      await this.transcribe();
    }
  }

  async transcribe() {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream("audio.wav"),
      model: "whisper-1",
    });

    console.log(transcription.text);

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

    log("completition: ", completion);
    log("choice: ", completion.choices[0].message);
    const json = JSON.stringify(
      completion.choices[0].message.content.replaceAll("\n", "")
    );
    let { name, age } = JSON.parse(completion.choices[0].message.content);

    log("Name, age: ", name, age);

    if (name && age) {
      log("Have name & age: ", name, age);
      await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${this.callSid}.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
          },
          body: encodeURIComponent(
            `Twiml=<Response><Say>Returning you back to the Studio Flow</Say><Redirect>https://webhooks.twilio.com/v1/Accounts/${accountSid}/Flows/${flowSid}?FlowEvent=return&name=${name}&age=${age}</Redirect></Response>`
          ),
        }
      );
    } else {
      log("Name and age not identified");
    }
  }

  close() {
    log("Server: Closed");
  }
}

wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
