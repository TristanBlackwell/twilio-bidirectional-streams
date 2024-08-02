const z = require("zod");

const sidLength = { len: 34, message: "SID must be 34 characters in length" };

const sidRegex = (prefix) => {
  return new RegExp(`${prefix}[a-fA-F0-9]{32}`);
};
const invalidSidRegexMessage = "Invalid SID pattern";

const envSchema = z.object({
  TWILIO_ACCOUNT_SID: z
    .string()
    .startsWith("AC", "Account SID must start with AC")
    .length(sidLength.len, sidLength.message)
    .regex(sidRegex("AC"), invalidSidRegexMessage),
  TWILIO_AUTH_TOKEN: z.string().length(32),
  TWILIO_FLOW_SID: z
    .string()
    .startsWith("FW", "Flow SID must start with FW")
    .length(sidLength.len, sidLength.message)
    .regex(sidRegex("FW"), invalidSidRegexMessage),
  OPENAI_API_KEY: z.string().startsWith("sk-"),
});

const validateAndRetrieveEnv = () => {
  const env = envSchema.safeParse(process.env);

  if (!env.success) {
    throw new Error(
      `Invalid server configuration. Check your environment variables and try again. \n\n ${env.error}`
    );
  }

  return env.data;
};

function log(message, ...args) {
  console.log("\n", new Date(), message, ...args);
}

module.exports = { log, validateAndRetrieveEnv };
