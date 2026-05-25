import { google } from "googleapis";
import { readFile } from "node:fs/promises";

const userResource = String(process.argv[2] || "").trim();

if (!userResource) {
  console.error("Usage: node --env-file=.env scripts/test-people-user.js users/<id>");
  process.exit(1);
}

const credentialsPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
const delegatedAdminEmail = String(process.env.GOOGLE_WORKSPACE_DELEGATED_ADMIN_EMAIL || "").trim();

if (!credentialsPath || !delegatedAdminEmail) {
  console.error("Missing GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_WORKSPACE_DELEGATED_ADMIN_EMAIL");
  process.exit(1);
}

const raw = await readFile(credentialsPath, "utf8");
const credentials = JSON.parse(raw);

const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/user.emails.read",
  ],
  subject: delegatedAdminEmail,
});

await auth.authorize();

const people = google.people({ version: "v1", auth });

try {
  const response = await people.people.get({
    resourceName: userResource.startsWith("people/") ? userResource : `people/${userResource.replace(/^users\//, "")}`,
    personFields: "emailAddresses,names,metadata",
  });

  console.log(JSON.stringify({
    ok: true,
    resourceName: response.data.resourceName || null,
    names: response.data.names || [],
    emailAddresses: response.data.emailAddresses || [],
    metadata: response.data.metadata || null,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    message: error?.message || String(error),
    code: error?.code || null,
    status: error?.status || null,
    errors: error?.errors || null,
  }, null, 2));
  process.exit(1);
}
