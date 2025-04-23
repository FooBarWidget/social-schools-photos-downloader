import fs from "node:fs";
import path from "path";
import { authenticate } from "@google-cloud/local-auth";
import { google, Auth } from "googleapis";
import inquirer from "inquirer"; // Using inquirer for potential prompts if needed, though local-auth handles browser flow
import { ensureDirExists, pathExists } from "./utils";

// Define the necessary scopes for the Gmail API
// readonly is sufficient for searching and reading emails
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

declare module 'googleapis' {
  namespace Auth {
    interface OAuth2Client {
      credentialsPath?: string;
    }
  }
}

/**
 * Reads previously authorized credentials from the save file.
 * @param {string} tokenPath The path to the file storing token data.
 * @returns {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist(tokenPath: string): Promise<Auth.OAuth2Client | null> {
  try {
    const content = await fs.promises.readFile(tokenPath);
    const credentials = JSON.parse(content.toString());
    return google.auth.fromJSON(credentials) as Auth.OAuth2Client;
  } catch (err: any) {
    // If the file doesn't exist or is invalid, return null
    if (err.code === "ENOENT") {
      console.log(`Token file not found at ${tokenPath}. Need to authorize.`);
    } else {
      console.warn(
        `Warning: Could not load token file from ${tokenPath}. Need to re-authorize. Error: ${err.message}`
      );
    }
    return null;
  }
}

/**
 * Serializes credentials to a file compatible with GoogleAUth.fromJSON.
 * @param {string} tokenPath The path to save the token data to.
 * @param {OAuth2Client} client The OAuth2 client instance containing credentials.
 * @returns {Promise<void>}
 */
async function saveCredentials(tokenPath: string, client: Auth.OAuth2Client): Promise<void> {
  try {
    const content = await fs.promises.readFile(client.credentialsPath!); // credentialsPath should be set during authorize
    const keys = JSON.parse(content.toString());
    const key = keys.installed || keys.web; // Handle both client types
    const payload = JSON.stringify({
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    });
    await ensureDirExists(path.dirname(tokenPath));
    await fs.promises.writeFile(tokenPath, payload);
    console.log(`Token saved to ${tokenPath}`);
  } catch (err: any) {
    console.error(`Error saving token to ${tokenPath}:`, err);
    throw new Error(`Failed to save credentials: ${err.message}`);
  }
}

/**
 * Load or request authorization to call APIs.
 * Uses @google-cloud/local-auth to simplify the OAuth flow by
 * automatically opening the browser and starting a local server to catch the redirect.
 * @param {string} credentialsPath Path to the credentials.json file.
 * @param {string} tokenPath Path to store/load the token.json file.
 * @returns {Promise<OAuth2Client>}
 */
async function authorize(
  credentialsPath: string,
  tokenPath: string
): Promise<Auth.OAuth2Client> {
  let client = await loadSavedCredentialsIfExist(tokenPath);
  if (client) {
    // TODO: Add check for token expiry if needed, though googleapis library often handles refresh
    console.log("Using saved credentials.");
    return client;
  }

  console.log("Attempting to authorize via browser flow...");
  try {
    // Ensure credentials file exists before attempting auth
    if (!(await pathExists(credentialsPath))) {
      throw new Error(
        `Credentials file not found at ${credentialsPath}. Please download it from Google Cloud Console.`
      );
    }

    client = await authenticate({
      scopes: SCOPES,
      keyfilePath: credentialsPath,
    });

    // Store the path used for credentials for saving later
    (client as any).credentialsPath = credentialsPath;

    if (client.credentials) {
      await saveCredentials(tokenPath, client);
      console.log("Authorization successful.");
      return client;
    } else {
      throw new Error("Authentication failed: No credentials received.");
    }
  } catch (err: any) {
    console.error("Error during authorization:", err.message);
    console.error(
      'Please ensure you have downloaded the correct credentials.json file for an "OAuth client ID" (Type: Desktop app or Web application) from Google Cloud Console and placed it at the specified path.'
    );
    console.error(
      "Also ensure the Gmail API is enabled for your project in Google Cloud Console."
    );
    process.exit(1); // Exit if authorization fails
  }
}

export { authorize };
