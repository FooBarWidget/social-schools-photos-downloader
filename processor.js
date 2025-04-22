import { google } from 'googleapis';
import fs from 'fs-extra';
import path from 'path';
import puppeteer from 'puppeteer';
import axios from 'axios';
import inquirer from 'inquirer';

const gmail = google.gmail('v1');

/**
 * Searches Gmail for messages matching the criteria.
 * @param {OAuth2Client} auth An authorized OAuth2 client.
 * @param {object} options CLI options.
 * @param {Set<string>} processedEmailIds Set of already processed email IDs.
 * @returns {Promise<Array<object>>} A list of message objects (containing id and threadId).
 */
async function searchEmails(auth, options, processedEmailIds) {
    console.log('Searching for emails...');
    const queryParts = [];
    queryParts.push(`from:(${options.sender})`); // Search by sender

    if (options.since) {
        // Ensure date format is YYYY/MM/DD for Gmail query
        const dateParts = options.since.split('-');
        if (dateParts.length === 3) {
            const queryDate = `${dateParts[0]}/${dateParts[1]}/${dateParts[2]}`;
            queryParts.push(`after:${queryDate}`);
            console.log(`Filtering emails received after: ${queryDate}`);
        } else {
            console.warn(`Invalid date format for --since: ${options.since}. Expected YYYY-MM-DD. Ignoring date filter.`);
        }
    }

    // Add query part to potentially exclude already processed emails
    // Note: Gmail search doesn't have a direct "NOT IN (id1, id2...)" syntax.
    // We'll fetch a list and filter locally if necessary, or fetch page by page.
    // For simplicity now, fetch a batch and filter. Fetch more if needed.
    const query = queryParts.join(' ');
    console.log(`Using Gmail query: ${query}`);

    let messages = [];
    let nextPageToken = null;
    const maxResultsPerPage = 100; // Fetch in batches

    try {
        do {
            const res = await gmail.users.messages.list({
                userId: 'me',
                auth: auth,
                q: query,
                maxResults: maxResultsPerPage,
                pageToken: nextPageToken,
            });

            if (res.data.messages) {
                messages.push(...res.data.messages);
            }
            nextPageToken = res.data.nextPageToken;
            // Add a condition to stop fetching too many pages if needed, e.g., based on total results
            // console.log(`Fetched page, total messages so far: ${messages.length}`);

        } while (nextPageToken); // Fetch all pages for now

        console.log(`Found ${messages.length} potential emails matching query.`);

        // Filter out already processed emails if not using --force
        if (!options.force) {
            const newMessages = messages.filter(msg => !processedEmailIds.has(msg.id));
            console.log(`Found ${newMessages.length} new emails to process.`);
            return newMessages;
        } else {
            console.log('--force used, processing all found emails.');
            return messages;
        }

    } catch (err) {
        console.error('Error searching Gmail:', err);
        throw new Error(`Failed to search Gmail: ${err.message}`);
    }
}

/**
 * Fetches the full details of a single email message.
 * @param {OAuth2Client} auth An authorized OAuth2 client.
 * @param {string} messageId The ID of the message to fetch.
 * @returns {Promise<object|null>} The message resource object or null if error.
 */
async function getEmailDetails(auth, messageId) {
    try {
        const res = await gmail.users.messages.get({
            userId: 'me',
            auth: auth,
            id: messageId,
            format: 'full', // Get headers and full body payload
        });
        return res.data;
    } catch (err) {
        console.error(`Error fetching email details for ID ${messageId}:`, err);
        return null;
    }
}

/**
 * Decodes Base64 URL encoded string.
 * @param {string} encodedString The Base64 URL encoded string.
 * @returns {string} The decoded string.
 */
function base64UrlDecode(encodedString) {
    if (!encodedString) return '';
    // Replace URL-safe characters and add padding if needed
    let base64 = encodedString.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64').toString('utf-8');
}


/**
 * Finds the Social Schools post link within an email's body.
 * Prefers HTML body parts.
 * @param {object} message The Gmail message resource object.
 * @returns {string|null} The found URL or null.
 */
function findSocialSchoolsLink(message) {
    if (!message || !message.payload) {
        return null;
    }

    const parts = [message.payload];
    let bodyData = '';

    while (parts.length > 0) {
        const part = parts.shift();

        if (part.parts) {
            parts.push(...part.parts); // Process nested parts
        }

        // Prefer HTML content
        if (part.mimeType === 'text/html' && part.body?.data) {
            bodyData = base64UrlDecode(part.body.data);
            break; // Found HTML, stop searching parts
        }
        // Fallback to plain text if HTML not found yet
        if (!bodyData && part.mimeType === 'text/plain' && part.body?.data) {
             bodyData = base64UrlDecode(part.body.data);
             // Continue searching in case HTML is found later
        }
    }

    if (!bodyData) {
        console.warn(`Warning: Could not find suitable body content for email ID ${message.id}`);
        return null;
    }

    // Basic regex to find a Social Schools URL - adjust as needed!
    // This looks for URLs starting with http(s):// followed by anything.socialschools.nl
    // and captures the full URL.
    const urlRegex = /(https?:\/\/[a-zA-Z0-9.-]+\.socialschools\.nl\/[^\s"'<>]+)/;
    const match = bodyData.match(urlRegex);

    if (match && match[0]) {
        // Clean up potential HTML encoding like &
        const url = match[0].replace(/&/g, '&');
        console.log(`Found potential link: ${url}`);
        // Add more specific checks if needed (e.g., must contain '/post/' or '/album/')
        if (url.includes('/post/') || url.includes('/album/')) { // Example refinement
             return url;
        } else {
            console.log(`Ignoring link as it doesn't seem to be a post/album: ${url}`);
            return null;
        }
    }

    return null;
}

/**
 * Scrapes a Social Schools post page for image URLs using Puppeteer.
 * Handles potential login if required.
 * @param {string} url The URL of the Social Schools post.
 * @param {object} options CLI options.
 * @returns {Promise<Array<string>>} A list of image URLs found on the page.
 */
async function scrapePostForImages(url, options) {
    console.log(`Navigating to ${url} to scrape images...`);
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true }); // Set headless: false for debugging
        const page = await browser.newPage();

        // Optional: Set a longer timeout for navigation
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // --- Check for Login Page ---
        // This part is highly dependent on Social Schools' actual login page structure.
        // You'll need to inspect the page source to find reliable selectors.
        const isLoginPage = await page.evaluate(() => {
            // Example selectors - REPLACE with actual selectors from Social Schools login page
            const loginForm = document.querySelector('form#login-form'); // Example: check for a login form ID
            const usernameField = document.querySelector('input[name="username"]'); // Example: check for username input
            return !!(loginForm || usernameField); // Returns true if either is found
        });

        if (isLoginPage) {
            console.log('Login page detected. Prompting for credentials...');
            const answers = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'username',
                    message: 'Enter Social Schools username:',
                },
                {
                    type: 'password',
                    name: 'password',
                    message: 'Enter Social Schools password:',
                    mask: '*',
                },
            ]);

            // --- Perform Login ---
            // Again, selectors are examples - REPLACE with actual selectors
            await page.type('input[name="username"]', answers.username); // Type username
            await page.type('input[name="password"]', answers.password); // Type password
            await page.click('button[type="submit"]'); // Click login button (example selector)

            // Wait for navigation after login, or for a specific element on the post page
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });

            // Optional: Verify successful login by checking for an element on the post page
            const loginSuccess = await page.evaluate(() => {
                 // Example: check for a common element on post pages, like a header or post content div
                 return !!document.querySelector('.post-content'); // REPLACE with actual selector
            });

            if (!loginSuccess) {
                throw new Error('Social Schools login failed. Please check your credentials.');
            }
            console.log('Successfully logged in.');
        }

        // --- Extract Image URLs ---
        // This is also highly dependent on the Social Schools post page structure.
        // You'll need to inspect the page source to find reliable selectors for images within a post.
        const imageUrls = await page.$$eval('.post-content img', (imgs) => { // Example selector: images within a .post-content div
            return imgs.map(img => img.src).filter(src => src); // Get src attribute and filter out empty ones
        });

        console.log(`Found ${imageUrls.length} image URLs.`);
        return imageUrls;

    } catch (err) {
        console.error(`Error scraping post ${url}:`, err);
        throw new Error(`Failed to scrape post: ${err.message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
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
async function downloadImage(url, outputDir, emailDate) {
    const datePrefix = emailDate.toISOString().split('T')[0]; // YYYY-MM-DD format

    // Attempt to get a filename from the URL
    const urlParts = new URL(url);
    let filename = path.basename(urlParts.pathname);

    // Basic sanitization for filename
    filename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!filename || filename.length > 255) { // Basic check for empty or too long filename
        filename = `image_${Date.now()}`; // Fallback to a timestamp name
    }

    // Ensure filename has an extension, try to guess from URL if missing
    if (!path.extname(filename)) {
        const mimeType = (await axios.head(url).catch(() => ({}))).headers['content-type'];
        if (mimeType && mimeType.startsWith('image/')) {
            const ext = mimeType.split('/')[1].split(';')[0]; // e.g., 'jpeg', 'png'
            filename = `${filename}.${ext}`;
        } else {
             filename = `${filename}.jpg`; // Default to jpg if cannot determine
        }
    }

    let finalFilename = `${datePrefix}_${filename}`;
    let filePath = path.join(outputDir, finalFilename);
    let counter = 1;

    // Handle filename conflicts
    while (await fs.pathExists(filePath)) {
        const ext = path.extname(filename);
        const name = path.basename(filename, ext);
        finalFilename = `${datePrefix}_${name}-(${counter})${ext}`;
        filePath = path.join(outputDir, finalFilename);
        counter++;
    }

    console.log(`Downloading ${url} to ${filePath}`);

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(filePath);

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`Saved ${finalFilename}`);
                resolve(filePath);
            });
            writer.on('error', (err) => {
                console.error(`Error saving ${finalFilename}:`, err);
                reject(err);
            });
        });
    } catch (err) {
        console.error(`Error downloading ${url}:`, err);
        throw new Error(`Failed to download image: ${err.message}`);
    }
}


/**
 * Main function to process emails: search, parse, scrape, download.
 * @param {OAuth2Client} auth An authorized OAuth2 client.


/**
 * Main function to process emails: search, parse, scrape, download.
 * @param {OAuth2Client} auth An authorized OAuth2 client.
 * @param {object} options CLI options.
 * @param {Set<string>} processedEmailIds Set of already processed email IDs.
 */
async function processEmails(auth, options, processedEmailIds) {
    const messagesToProcess = await searchEmails(auth, options, processedEmailIds);

    if (messagesToProcess.length === 0) {
        console.log('No new emails found to process.');
        return;
    }

    console.log(`Processing ${messagesToProcess.length} emails...`);

    let processedCount = 0;
    for (const messageHeader of messagesToProcess) {
        console.log(`\nProcessing email ID: ${messageHeader.id}`);
        try {
            // 1. Fetch full email content
            const emailDetails = await getEmailDetails(auth, messageHeader.id);
            if (!emailDetails) {
                console.warn(`Skipping email ${messageHeader.id} due to fetch error.`);
                continue; // Skip to next email
            }

            // Extract date for potential filename prefix later
            const internalDate = emailDetails.internalDate; // Milliseconds since epoch
            const emailDate = new Date(parseInt(internalDate));

            // 2. Parse email body to find Social Schools link
            const socialSchoolsLink = findSocialSchoolsLink(emailDetails);

            if (!socialSchoolsLink) {
                console.log(`No Social Schools post/album link found in email ${messageHeader.id}.`);
                // Mark as processed even if no link found, unless --force is used
                if (!options.force) {
                    processedEmailIds.add(messageHeader.id);
                }
                continue; // Skip to next email
            }

            console.log(`Found link for email ${messageHeader.id}: ${socialSchoolsLink}`);

            // 3. Scrape post for image URLs using Puppeteer
            let imageUrls = [];
            try {
                imageUrls = await scrapePostForImages(socialSchoolsLink, options);
            } catch (scrapeError) {
                console.error(`Failed to scrape images for email ${messageHeader.id}: ${scrapeError.message}`);
                // Decide if we should skip this email or mark as processed anyway
                if (!options.force) {
                     processedEmailIds.add(messageHeader.id); // Mark as processed even if scraping failed
                     try {
                        await fs.writeJson(options.processedList, { processedIds: Array.from(processedEmailIds) });
                        console.log(`Marked email ${messageHeader.id} as processed after scraping failure.`);
                    } catch (err) {
                        console.error(`Error saving updated processed emails list after scraping failure for ${messageHeader.id}: ${err}`);
                    }
                }
                continue; // Skip to next email
            }

            if (imageUrls.length === 0) {
                 console.log(`No images found on the post page for email ${messageHeader.id}.`);
                 if (!options.force) {
                    processedEmailIds.add(messageHeader.id); // Mark as processed if no images found
                     try {
                        await fs.writeJson(options.processedList, { processedIds: Array.from(processedEmailIds) });
                        console.log(`Marked email ${messageHeader.id} as processed (no images found).`);
                    } catch (err) {
                        console.error(`Error saving updated processed emails list after finding no images for ${messageHeader.id}: ${err}`);
                    }
                }
                 continue; // Skip to next email
            }

            // 4. & 5. Download Images
            let downloadSuccessCount = 0;
            for (const imageUrl of imageUrls) {
                try {
                    await downloadImage(imageUrl, options.output, emailDate);
                    downloadSuccessCount++;
                } catch (downloadError) {
                    console.error(`Failed to download image ${imageUrl}: ${downloadError.message}`);
                    // Continue to the next image
                }
            }

            const processingSuccessful = downloadSuccessCount === imageUrls.length && imageUrls.length > 0; // Consider successful if all found images downloaded, or if no images were found but scraping succeeded
            if (imageUrls.length > 0 && downloadSuccessCount === 0) {
                 console.warn(`No images were successfully downloaded for email ${messageHeader.id}.`);
            } else if (imageUrls.length > 0 && downloadSuccessCount < imageUrls.length) {
                 console.warn(`Only ${downloadSuccessCount}/${imageUrls.length} images were successfully downloaded for email ${messageHeader.id}.`);
            } else if (imageUrls.length === 0) {
                 console.log(`No images found to download for email ${messageHeader.id}.`);
            } else {
                 console.log(`Successfully downloaded ${downloadSuccessCount}/${imageUrls.length} images for email ${messageHeader.id}.`);
            }

            // --- Steps 6 & 7: Update processed list ---
            // This block now runs if scraping was successful (even if no images were found)
            // The actual download success/failure should refine 'processingSuccessful'
            if (processingSuccessful && !options.force) {
                processedEmailIds.add(messageHeader.id);
                processedCount++;
                // Save after each successful email processing (including scraping)
                try {
                    await fs.writeJson(options.processedList, { processedIds: Array.from(processedEmailIds) });
                    console.log(`Successfully processed email ${messageHeader.id}. Updated processed list.`);
                } catch (err) {
                    console.error(`Error saving updated processed emails list after processing ${messageHeader.id}: ${err}`);
                    // Decide if we should stop or continue
                }
            } else if (processingSuccessful && options.force) {
                 console.log(`Processed email ${messageHeader.id} (--force enabled, not updating list).`);
            } else {
                 // This case should ideally be handled by the specific error catches above
                 console.warn(`Processing failed for email ${messageHeader.id}. Not marking as processed.`);
            }

        } catch (error) {
            console.error(`An unexpected error occurred processing email ${messageHeader.id}:`, error);
            // Continue to the next email
        }
    }

    console.log(`\nFinished processing emails. Successfully processed ${processedCount} new emails.`);
    // Final save of the list (optional, if not saving after each email)
    // if (!options.force) { ... }
}

export { processEmails };