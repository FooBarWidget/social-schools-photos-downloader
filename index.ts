#!/usr/bin/env node

import { Command } from "commander";
import path from "path";
import { authorize } from "./googleAuth";
import { Options } from "./types";
import { base64UrlDecode, ensureDirExists, pathExists } from "./utils";
import { google, Auth, gmail_v1 } from "googleapis";
import { GaxiosResponse } from "googleapis-common";
import fs from "node:fs";
import * as puppeteer from "puppeteer";
import axios from "axios";
import inquirer from "inquirer";

const SOCIAL_SCHOOLS_SENDER_EMAIL = "noreply@socialschools.eu";
const GOOGLE_OAUTH_CLIENT_CREDENTIALS_PATH = "oauth_client_credentials.json";
const GOOGLE_OAUTH_TOKEN_PATH = "oauth_token.json";

const program = new Command();
program
  .name("social-schools-downloader")
  .description("Downloads photos from Social Schools posts linked in Gmail.");
program.requiredOption(
  "-o, --output <directory>",
  "Output directory for downloaded photos",
  process.env.DEFAULT_OUTPUT_DIR || "./downloaded_photos"
);
program.parse(process.argv);
const options: Options = program.opts() as Options;

const gmail = google.gmail("v1");

async function main() {
  console.log("Starting Social Schools Downloader...");
  console.log("Options:", options);

  if (!(await pathExists(GOOGLE_OAUTH_CLIENT_CREDENTIALS_PATH))) {
    console.error(
      `Error: Credentials file not found at ${GOOGLE_OAUTH_CLIENT_CREDENTIALS_PATH}.`
    );
    process.exit(1);
  }

  await ensureDirExists(options.output);
  console.log(`Output directory set to: ${path.resolve(options.output)}`);

  console.log("Authorizing Google API access...");
  const auth = await authorize(
    GOOGLE_OAUTH_CLIENT_CREDENTIALS_PATH,
    GOOGLE_OAUTH_TOKEN_PATH
  );

  const messages = await searchEmails(auth);
  if (messages.length === 0) {
    console.log("No new emails found to process.");
    return;
  }

  console.log(`Processing ${messages.length} emails...`);
  const browser = await puppeteer.launch({ headless: true }); // Set headless: false for debugging
  try {
    const page = await browser.newPage();
    await processEmails(auth, messages, page, options);
  } finally {
    await browser.close();
  }
}

export async function processEmails(
  auth: Auth.OAuth2Client,
  messages: gmail_v1.Schema$Message[],
  page: puppeteer.Page,
  options: Options
): Promise<void> {
  let processedCount = 0;
  for (const message of messages) {
    console.log(`\nProcessing email ID: ${message.id}`);
    try {
      // 1. Fetch full email content
      const emailDetails = await getEmailDetails(auth, message.id!);
      if (!emailDetails) {
        console.warn(`Skipping email ${message.id} due to fetch error.`);
        continue;
      }

      // Extract date for potential filename prefix later
      const internalDate = emailDetails.internalDate!; // Milliseconds since epoch
      const emailDate = new Date(parseInt(internalDate));

      // 2. Parse email body to find Social Schools link
      const socialSchoolsLink = findSocialSchoolsLink(emailDetails);

      if (!socialSchoolsLink) {
        console.log(
          `No Social Schools post/album link found in email ${message.id}.`
        );
        continue;
      }

      console.log(
        `Found link for email ${message.id}: ${socialSchoolsLink}`
      );

      // 3. Scrape post for image URLs using Puppeteer
      let imageUrls: string[] = [];
      try {
        imageUrls = await scrapePostForImages(page, socialSchoolsLink, options);
      } catch (scrapeError: any) {
        console.error(
          `Failed to scrape images for email ${message.id}: ${scrapeError.message}`
        );
        continue;
      }

      if (imageUrls.length === 0) {
        console.log(
          `No images found on the post page for email ${message.id}.`
        );
        continue;
      }

      // 4. Download Images
      let downloadSuccessCount = 0;
      for (const imageUrl of imageUrls) {
        try {
          await downloadImage(imageUrl, options.output, emailDate);
          downloadSuccessCount++;
        } catch (downloadError: any) {
          console.error(
            `Failed to download image ${imageUrl}: ${downloadError.message}`
          );
          // Continue to the next image
        }
      }

      const processingSuccessful =
        downloadSuccessCount === imageUrls.length && imageUrls.length > 0; // Consider successful if all found images downloaded, or if no images were found but scraping succeeded
      if (imageUrls.length > 0 && downloadSuccessCount === 0) {
        console.warn(
          `No images were successfully downloaded for email ${message.id}.`
        );
      } else if (
        imageUrls.length > 0 &&
        downloadSuccessCount < imageUrls.length
      ) {
        console.warn(
          `Only ${downloadSuccessCount}/${imageUrls.length} images were successfully downloaded for email ${message.id}.`
        );
      } else if (imageUrls.length === 0) {
        console.log(
          `No images found to download for email ${message.id}.`
        );
      } else {
        console.log(
          `Successfully downloaded ${downloadSuccessCount}/${imageUrls.length} images for email ${message.id}.`
        );
      }

    } catch (error: any) {
      console.error(
        `An unexpected error occurred processing email ${message.id}:`,
        error
      );
      // Continue to the next email
    }
  }

  console.log(
    `\nFinished processing emails. Successfully processed ${processedCount} new emails.`
  );
}

async function searchEmails(auth: Auth.OAuth2Client): Promise<gmail_v1.Schema$Message[]> {
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
    console.error("Error searching Gmail:", err);
    throw new Error(`Failed to search Gmail: ${err.message}`);
  }
}

/**
 * Finds the Social Schools post link within an email's body.
 * Prefers HTML body parts.
 * @param {object} message The Gmail message resource object.
 * @returns {string|null} The found URL or null.
 */
function findSocialSchoolsLink(message: any): string | null {
  if (!message || !message.payload) {
    return null;
  }

  const parts: any[] = [message.payload];
  let bodyData = "";

  while (parts.length > 0) {
    const part = parts.shift();

    if (part.parts) {
      parts.push(...part.parts); // Process nested parts
    }

    // Prefer HTML content
    if (part.mimeType === "text/html" && part.body?.data) {
      bodyData = base64UrlDecode(part.body.data);
      break; // Found HTML, stop searching parts
    }
    // Fallback to plain text if HTML not found yet
    if (!bodyData && part.mimeType === "text/plain" && part.body?.data) {
      bodyData = base64UrlDecode(part.body.data);
      // Continue searching in case HTML is found later
    }
  }

  if (!bodyData) {
    console.warn(
      `Warning: Could not find suitable body content for email ID ${message.id}`
    );
    return null;
  }

  // Basic regex to find a Social Schools URL - adjust as needed!
  // This looks for URLs starting with http(s):// followed by anything.socialschools.nl
  // and captures the full URL.
  const urlRegex = /(https?:\/\/[a-zA-Z0-9.-]+\.socialschools\.nl\/[^\s"'<>]+)/;
  const match = bodyData.match(urlRegex);

  if (match && match[0]) {
    // Clean up potential HTML encoding like &
    const url = match[0].replace(/&/g, "&");
    console.log(`Found potential link: ${url}`);
    // Add more specific checks if needed (e.g., must contain '/post/' or '/album/')
    if (url.includes("/post/") || url.includes("/album/")) {
      // Example refinement
      return url;
    } else {
      console.log(
        `Ignoring link as it doesn't seem to be a post/album: ${url}`
      );
      return null;
    }
  }

  return null;
}

/**
 * Scrapes a Social Schools post page for image URLs using Puppeteer.
 * Handles potential login if required.
 * @param {string} url The URL of the Social Schools post.
 * @param {Options} options CLI options.
 * @returns {Promise<Array<string>>} A list of image URLs found on the page.
 */
async function scrapePostForImages(page: puppeteer.Page, url: string, options: Options): Promise<string[]> {
  console.log(`Navigating to ${url} to scrape images...`);
  try {
    // Optional: Set a longer timeout for navigation
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // --- Check for Login Page ---
    // This part is highly dependent on Social Schools' actual login page structure.
    // You'll need to inspect the page source to find reliable selectors.
    const isLoginPage = await page.evaluate(() => {
      // Example selectors - REPLACE with actual selectors from Social Schools login page
      const loginForm = document.querySelector("form#login-form"); // Example: check for a login form ID
      const usernameField = document.querySelector('input[name="username"]'); // Example: check for username input
      return !!(loginForm || usernameField); // Returns true if either is found
    });

    if (isLoginPage) {
      console.log("Login page detected. Prompting for credentials...");
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "username",
          message: "Enter Social Schools username:",
        },
        {
          type: "password",
          name: "password",
          message: "Enter Social Schools password:",
          mask: "*",
        },
      ]);

      // --- Perform Login ---
      // Again, selectors are examples - REPLACE with actual selectors
      await page.type('input[name="username"]', answers.username); // Type username
      await page.type('input[name="password"]', answers.password); // Type password
      await page.click('button[type="submit"]'); // Click login button (example selector)

      // Wait for navigation after login, or for a specific element on the post page
      await page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      // Optional: Verify successful login by checking for an element on the post page
      const loginSuccess = await page.evaluate(() => {
        // Example: check for a common element on post pages, like a header or post content div
        return !!document.querySelector(".post-content"); // REPLACE with actual selector
      });

      if (!loginSuccess) {
        throw new Error(
          "Social Schools login failed. Please check your credentials."
        );
      }
      console.log("Successfully logged in.");
    }

    // --- Extract Image URLs ---
    // This is also highly dependent on the Social Schools post page structure.
    // You'll need to inspect the page source to find reliable selectors for images within a post.
    const imageUrls = await page.$$eval(".post-content img", (imgs) => {
      // Example selector: images within a .post-content div
      return imgs.map((img) => img.src).filter((src) => src); // Get src attribute and filter out empty ones
    });

    console.log(`Found ${imageUrls.length} image URLs.`);
    return imageUrls;
  } catch (err: any) {
    console.error(`Error scraping post ${url}:`, err);
    throw new Error(`Failed to scrape post: ${err.message}`);
  }
}

/**
 * Downloads an image from a URL and saves it to the specified directory.
 * Handles filename conflicts by appending a counter.
 * @param {string} url The URL of the image to download.
 * @param {string} outputDir The directory to save the image to.
 * @param {Date} emailDate The date the email was received (for filename prefix).
 * @returns {Promise<string>} The final path where the image was saved.
 */
async function downloadImage(
  url: string,
  outputDir: string,
  emailDate: Date
): Promise<string> {
  const datePrefix = emailDate.toISOString().split("T")[0]; // YYYY-MM-DD format

  // Attempt to get a filename from the URL
  const urlParts = new URL(url);
  let filename = path.basename(urlParts.pathname);

  // Basic sanitization for filename
  filename = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (!filename || filename.length > 255) {
    // Basic check for empty or too long filename
    filename = `image_${Date.now()}`; // Fallback to a timestamp name
  }

  // Ensure filename has an extension, try to guess from URL if missing
  if (!path.extname(filename)) {
    try {
      const headResponse = await axios.head(url);
      const mimeType = headResponse.headers["content-type"];
      if (mimeType?.startsWith("image/")) {
        const ext = mimeType.split("/")[1].split(";")[0]; // e.g., 'jpeg', 'png'
        filename = `${filename}.${ext}`;
      } else {
        filename = `${filename}.jpg`; // Default to jpg if cannot determine
      }
    } catch (error: any) {
      filename = `${filename}.jpg`; // Default to jpg if cannot determine
    }
  }

  const finalFilename = `${datePrefix}_${filename}`;
  const filePath = path.join(outputDir, finalFilename);
  console.log(`Downloading ${url} to ${filePath}`);

  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });

    const writer = fs.createWriteStream(filePath);

    response.data.pipe(writer);

    return new Promise<string>((resolve, reject) => {
      writer.on("finish", () => {
        console.log(`Saved ${finalFilename}`);
        resolve(filePath);
      });
      writer.on("error", (err: any) => {
        console.error(`Error saving ${finalFilename}:`, err);
        reject(err);
      });
    });
  } catch (err: any) {
    console.error(`Error downloading ${url}:`, err);
    throw new Error(`Failed to download image: ${err.message}`);
  }
}

async function getEmailDetails(
  auth: Auth.OAuth2Client,
  messageId: string
): Promise<gmail_v1.Schema$Message | undefined> {
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      auth: auth,
      id: messageId,
      format: "full", // Get headers and full body payload
    });
    return res.data;
  } catch (err: any) {
    console.error(`Error fetching email details for ID ${messageId}:`, err);
  }
}

void main();
