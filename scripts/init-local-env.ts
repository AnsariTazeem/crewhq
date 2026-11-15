import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const content = [
  "NODE_ENV=development",
  "APP_ORIGIN=http://localhost:3000",
  "HOST=127.0.0.1",
  "PORT=3001",
  "MONGODB_URI=mongodb://127.0.0.1:27027/?replicaSet=rs0&directConnection=true",
  "MONGODB_DATABASE=h4h_local",
  `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}`,
  `INVITATION_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}`,
  "GOOGLE_CLIENT_ID=",
  "GOOGLE_CLIENT_SECRET=",
  "DEMO_EVENT_ID=8ce60ac2-e914-4eaf-a02c-51e854827dcc",
  "DEMO_MIN_SIZE=2",
  "DEMO_MAX_SIZE=4",
  `DEMO_ADMISSIONS_CLOSES_AT=${new Date(Date.now() + 7 * 86_400_000).toISOString()}`,
  `DEMO_EVENT_STARTS_AT=${new Date(Date.now() + 8 * 86_400_000).toISOString()}`,
  `DEMO_EVENT_ENDS_AT=${new Date(Date.now() + 9 * 86_400_000).toISOString()}`,
  "",
].join("\n");
try {
  await writeFile(".env", content, { flag: "wx", mode: 0o600 });
  console.log(
    "Created private .env with distinct random secrets; configure Google OAuth locally. Secret values are not printed.",
  );
} catch (error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  )
    console.log("Existing .env retained without changes.");
  else throw error;
}
