import { authorize } from "./lib/googleAuth";
import { SocialSchoolsLink } from "./lib/types";
import { base64UrlDecode, ensureDirExists, pathExists } from "./lib/utils";
import { google, Auth, gmail_v1 } from "googleapis";
import { GaxiosResponse } from "googleapis-common";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const SOCIAL_SCHOOLS_SENDER_EMAIL = "noreply@socialschools.eu";
const GOOGLE_OAUTH_CLIENT_CREDENTIALS_PATH = "google_oauth_client_credentials.json";
const GOOGLE_OAUTH_TOKEN_PATH = "google_oauth_token.json";

async function main() {
  console.log("Starting Social Schools Downloader...");

  if (!(await pathExists(GOOGLE_OAUTH_CLIENT_CREDENTIALS_PATH))) {
    console.error(
      `Error: Credentials file not found at ${GOOGLE_OAUTH_CLIENT_CREDENTIALS_PATH}.`
    );
    process.exit(1);
  }

  console.log("Authorizing Google API access...");
  const auth = await authorize(
    GOOGLE_OAUTH_CLIENT_CREDENTIALS_PATH,
    GOOGLE_OAUTH_TOKEN_PATH
  );

  const gmail = google.gmail("v1");
  const messageListing = await searchEmails(gmail, auth);
  if (messageListing.length === 0) {
    console.log("No new emails found to process.");
    return;
  }

  const emails = await fetchDetailedEmails(gmail, auth, messageListing);
  const links = await extractSocialSchoolsLinksFromEmails(emails);
  if (links.length === 0) {
    console.log("No emails with Social Schools links found.");
    return;
  }

  fs.writeFileSync('links.json', JSON.stringify(links, null, 2));
  console.log(`${links.length} links extracted and saved to links.json`);
}

async function searchEmails(gmail: gmail_v1.Gmail, auth: Auth.OAuth2Client): Promise<gmail_v1.Schema$Message[]> {
  console.log("Searching for emails...");
  const query = `in:inbox from:(${SOCIAL_SCHOOLS_SENDER_EMAIL})`;
  console.log(`Using Gmail query: ${query}`);

  let messages: gmail_v1.Schema$Message[] = [];
  let nextPageToken: string | undefined = undefined;
  const maxResultsPerPage = 100;

  try {
    do {
      const res: GaxiosResponse<gmail_v1.Schema$ListMessagesResponse> =
        await gmail.users.messages.list({
          userId: "me",
          auth: auth,
          q: query,
          maxResults: maxResultsPerPage,
          pageToken: nextPageToken,
        });

      if (res.data?.messages) {
        messages.push(...res.data.messages);
      }
      nextPageToken = res.data?.nextPageToken ?? undefined;
    } while (nextPageToken);

    console.log(`Found ${messages.length} emails matching query.`);
    return messages;
  } catch (err: any) {
    throw new Error(`Error searching Gmail: ${err.message}`, { cause: err });
  }
}

interface DetailedEmail {
  id: string;
  date: Date;
  subject?: string;
  payload: gmail_v1.Schema$MessagePart;
}

async function fetchDetailedEmails(gmail: gmail_v1.Gmail, auth: Auth.OAuth2Client, messageListing: gmail_v1.Schema$Message[]): Promise<DetailedEmail[]> {
  const results: DetailedEmail[] = [];
  for (const listItem of messageListing) {
    try {
      const res = await gmail.users.messages.get({
        userId: "me",
        auth: auth,
        id: listItem.id!,
        format: "full", // Get headers and full body payload
      });
      results.push({
        id: listItem.id!,
        date: new Date(parseInt(res.data.internalDate!)),
        subject: res.data.payload?.headers?.find((h) => h.name === "Subject")?.value?.replace(/^IKC Het Talent - /, '') ?? undefined,
        payload: res.data.payload!,
      });
    } catch (err: any) {
      throw new Error(`Error fetching email details for ID ${listItem.id}:`, { cause: err });
    }
  }
  return results;
}

export async function extractSocialSchoolsLinksFromEmails(emails: DetailedEmail[]): Promise<SocialSchoolsLink[]> {
  const links: SocialSchoolsLink[] = [];

  for (const email of emails) {
    const link = findSocialSchoolsLink(email);
    if (link) {
      links.push({
        messageId: email.id,
        date: email.date,
        subject: email.subject,
        href: link
      });
    }
  }

  return links;
}

function findSocialSchoolsLink(message: gmail_v1.Schema$Message): string | null {
  if (!message || !message.payload) {
    return null;
  }

  const parts: gmail_v1.Schema$MessagePart[] = [message.payload];
  let bodyData = "";

  while (parts.length > 0) {
    const part = parts.shift()!;

    if (part.parts) {
      parts.push(...part.parts); // Process nested parts
    }

    if (part.mimeType === "text/html" && part.body?.data) {
      bodyData = base64UrlDecode(part.body.data);
      break; // Found HTML, stop searching parts
    }
  }

  if (!bodyData) {
    console.warn(
      `Warning: Could not find suitable body content for email ID ${message.id}`
    );
    return null;
  }

  // Parse HTML content using JSDOM
  const dom = new JSDOM(bodyData);
  const links = dom.window.document.querySelectorAll("a");

  for (const link of links) {
    if (link.textContent?.includes("Bekijk de foto's in Social Schools")) {
      return link.href;
    }
  }

  return null;
}

void main();
