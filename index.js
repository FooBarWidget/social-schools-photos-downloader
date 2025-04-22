#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { authorize } from './googleAuth.js';
import { processEmails } from './processor.js';

const program = new Command();

// --- Configuration Loading (using direnv/process.env) ---
// Ensure required env vars are loaded by direnv beforehand
const defaultOutputDir = process.env.DEFAULT_OUTPUT_DIR || './downloaded_photos';
const defaultSender = process.env.SOCIAL_SCHOOLS_SENDER_EMAIL; // Should be set in .envrc
const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
const tokenPath = process.env.GOOGLE_TOKEN_PATH || './token.json';
const processedEmailsPath = process.env.PROCESSED_EMAILS_PATH || './processed_emails.json';
const logLevel = process.env.LOG_LEVEL || 'info'; // Basic logging for now

// --- CLI Definition ---
program
  .name('social-schools-downloader')
  .description('Downloads photos from Social Schools posts linked in Gmail.')
  .version('1.0.0'); // Consider reading from package.json

program
  .requiredOption('-o, --output <directory>', 'Output directory for downloaded photos', defaultOutputDir)
  .option('-s, --sender <email>', 'Social Schools sender email address', defaultSender)
  .option('--since <YYYY-MM-DD>', 'Only process emails received on or after this date')
  .option('--force', 'Process all found emails, ignoring previously processed ones', false)
  .option('--credentials <path>', 'Path to Google credentials.json file', credentialsPath)
  .option('--token <path>', 'Path to Google token.json file', tokenPath)
  .option('--processed-list <path>', 'Path to processed emails list file', processedEmailsPath);

program.parse(process.argv);

const options = program.opts();

// --- Main Execution Logic ---
async function main() {
  console.log('Starting Social Schools Downloader...');
  console.log('Options:', options);

  // Validate required options/env vars
  if (!options.sender) {
    console.error('Error: Sender email address is required. Set SOCIAL_SCHOOLS_SENDER_EMAIL in .envrc or use --sender option.');
    process.exit(1);
  }
  if (!await fs.pathExists(options.credentials)) {
     console.error(`Error: Credentials file not found at ${options.credentials}. Set GOOGLE_CREDENTIALS_PATH in .envrc or use --credentials option.`);
     process.exit(1);
  }

  try {
    // 1. Ensure output directory exists
    await fs.ensureDir(options.output);
    console.log(`Output directory set to: ${path.resolve(options.output)}`);

    // 2. Authorize Google API access
    console.log('Authorizing Google API access...');
    const auth = await authorize(options.credentials, options.token);

    // 3. Load processed emails list
    let processedEmailIds = new Set();
    if (!options.force && await fs.pathExists(options.processedList)) {
      try {
        const data = await fs.readJson(options.processedList);
        if (Array.isArray(data?.processedIds)) {
          processedEmailIds = new Set(data.processedIds);
          console.log(`Loaded ${processedEmailIds.size} previously processed email IDs.`);
        } else {
           console.warn(`Warning: Invalid format in ${options.processedList}. Starting with empty list.`);
           await fs.writeJson(options.processedList, { processedIds: [] }); // Initialize/fix the file
        }
      } catch (err) {
        console.warn(`Warning: Could not read ${options.processedList}. Starting with empty list. Error: ${err.message}`);
        await fs.writeJson(options.processedList, { processedIds: [] }); // Initialize the file
      }
    } else if (!options.force) {
        console.log(`Processed emails list (${options.processedList}) not found. Will create it.`);
        await fs.ensureFile(options.processedList);
        await fs.writeJson(options.processedList, { processedIds: [] }); // Initialize the file
    } else {
        console.log('--force flag used, ignoring processed emails list.');
    }


    // 4. Process emails (Search, Parse, Scrape, Download)
    console.log('Starting email processing...');
    await processEmails(auth, options, processedEmailIds);

    // 5. Save updated processed emails list (if not forced)
    if (!options.force) {
        // The processed list is now saved within processEmails after each successful email (or at the end).
        // No need to save it here anymore.
    }


    console.log('Social Schools Downloader finished successfully.');

  } catch (error) {
    console.error('An error occurred during execution:', error);
    process.exit(1);
  }
}

// --- Add ES Module top-level await support check if needed ---
// (async () => {
//   await main();
// })();
// Or just call main directly if top-level await is supported (Node.js v14.8+)
main();