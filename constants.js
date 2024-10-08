const MULAW_HEADER = Buffer.from([
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
