import path from "node:path";
import fs from "node:fs";
import * as puppeteer from "puppeteer";
import axios from "axios";
import { exiftool } from "exiftool-vendored";
import { SocialSchoolsLink } from "./lib/types";
import { asyncFind, pathExists } from "./lib/utils";

const DISALLOWED_PATH_CHARS = /[<>:"/\\|?*]/g;

interface SocialSchoolsLinkWithMediaSources extends SocialSchoolsLink {
  mediaSources: string[];
}

async function main() {
  const browser = await puppeteer.launch({ headless: false });
  let exitStatus = 0;

  try {
    try {
      const page = await browser.newPage();
      await loginSocialSchools(page);

      if (!(await pathExists("links.json"))) {
        console.log(
            `Links file not found at links.json. Retrieving links from home page. Or run 'npx tsx extract-links.ts' first.`
        );
        await fetchLinksFromHome(page);
      }

      const links = loadLinks();

      for (const link of links) {
        await scrapePostForImages(page, link);
        await downloadImages(page, link);
      }
    } catch (err: any) {
      console.error(err);
      exitStatus = 1;
    }

  } finally {
    console.log("Press Enter to close the browser...");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    await browser.close();
    process.exit(exitStatus);
  }
}

function loadLinks(): SocialSchoolsLinkWithMediaSources[] {
  const links = JSON.parse(fs.readFileSync("links.json", "utf-8")) as SocialSchoolsLinkWithMediaSources[];
  for (const link of links) {
    link.date = new Date(Date.parse(link.date as unknown as string));
    link.mediaSources = [];
  }
  return links;
}

async function loginSocialSchools(page: puppeteer.Page) {
  await page.goto('https://app.socialschools.eu');
  await page.locator('::-p-text(Agenda voor de komende)').wait();
  console.log("Logged in to Social Schools.");
}

async function fetchLinksFromHome(page: puppeteer.Page) {
  // Fetch the links to the posts from the Social Schools home page.

  // The home page only shows a handful of posts. Scrolling down
  // will load more posts (with a rotating spinner and all).
  // The actual end of the page will have the text
  // "Er zijn niet meer berichten" in this div:
  // <div role="alert" class="fade alert alert-muted show"><span>Er zijn niet meer berichten</span></div>
  // This is the only diff with the class 'fade'.
  // So it is necessary to scroll until that diff is found.

  // Scrolling to the end can take minutes, so set the timeout to 10 minutes.
  // Set the timeout lower for debugging.
  // let timeout = 600000;
  let timeout = 10000;
  const startTime = Date.now();

  while (true) {
    // Check if the element is already present
    const isFadeVisible = await page.$('.fade') !== null;
    if (isFadeVisible) {
      console.log('Element with class "fade" found.');
      break;
    }
    console.log('Element with class "fade" not found, scrolling down.');

    // Scroll down a bit
    await page.evaluate(() => {
      console.log('Window height:', window.innerHeight);
      window.scrollBy(0, window.innerHeight);
      console.log('Window height:', window.innerHeight);
    });

    // Wait a bit to allow content to load.
    await new Promise(resolve => setTimeout(resolve, 300));

    // Check for timeout.
    if (Date.now() - startTime > timeout) {
      console.log('Timeout: Element with class "fade" not found after scrolling.');
      // Just continue with what is already available.
      break;
    }

  }

  // Get all the posts.
  // Not sure how to filter out the ones with images from this view.
  const posts = await page.$$eval('div[role="article"][id^="post_"]', (postDivs) => {

    // Don't know how to abstract this logic away in a function.
    // That gives this error:
    // Error [ReferenceError]: __name is not defined
    return postDivs.map(post => {
      // Written by the toaster.
      // Extract post ID
      const idAttr = post.getAttribute('id');
      const postId = idAttr?.replace('post_', '') ?? null;

      // Extract title from <h3>
      const titleEl = post.querySelector('h3 span.user-text span');
      const title = titleEl?.textContent?.trim() ?? null;

      // Extract raw date string
      const dateAnchor = post.querySelector('a.meta-info span span');
      const rawDate = dateAnchor?.textContent?.trim() ?? null;

      return { postId, rawDate, title };
    });
  });

  console.log(posts);

  // Parse date to standard ISO format
  // Written by the toaster.
  const parsedPosts: SocialSchoolsLink[] = posts.map(({ postId, rawDate, title }) => {
    let parsedDate: Date | null = null;

    if (rawDate) {
      const match = rawDate.match(/^(\d{1,2}) (\w+)(?: om (\d{1,2}:\d{2}))?/);
      if (match) {
        const [_, day, monthDutch, time = '00:00'] = match;
        const monthMap: Record<string, string> = {
          januari: '01', februari: '02', maart: '03', april: '04',
          mei: '05', juni: '06', juli: '07', augustus: '08',
          september: '09', oktober: '10', november: '11', december: '12',
        };
        const month = monthMap[monthDutch.toLowerCase()];
        if (month) {
          const year = new Date().getFullYear();
          const isoString = `${year}-${month}-${day.padStart(2, '0')}T${time}:00`;
          parsedDate = new Date(isoString);
        }
      }
    }

    return {
      messageId: postId ?? '',
      date: parsedDate ?? new Date(0),
      subject: title ?? undefined,
      href: `https://app.socialschools.eu/communityposts/${postId}`,
    };
  });

  console.log(parsedPosts);

  fs.writeFileSync('links.json', JSON.stringify(parsedPosts, null, 2));
  console.log(`${parsedPosts.length} links extracted and saved to links.json`);
}

async function scrapePostForImages(page: puppeteer.Page, link: SocialSchoolsLinkWithMediaSources) {
  console.log(`\n### Scraping images for ${link.subject} ${link.href}`);

  // Load post
  console.log('Waiting for post to load...');
  await page.goto(link.href, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForSelector('main .ss-chat', { timeout: 10000 });
  console.log('Post loaded');

  // Get accessibility tree
  let snapshot = await page.accessibility.snapshot();
  if (!snapshot) {
    throw new Error("Cannot infer accessibility tree.");
  }

  // Find & click on first image preview
  const imagePreview = await findAccessibilityTreeNode(snapshot, (n) => n.role === 'button' && !!n.name?.match(/\.(jpg|png|mp4|mov)/));
  if (!imagePreview) {
    console.warn("No images found in the post.");
    return;
  }

  console.log("Clicking on first image preview");
  (await imagePreview.elementHandle())!.click();

  // Wait for lightbox to open, find right navigation button
  console.log("Waiting for lightbox to open...");
  const lightbox = (await page.waitForSelector('*[class*="LightBox"]', { timeout: 10000 }))!;
  const navButtons = await lightbox.$$('button');
  const navRightButton = await asyncFind(navButtons, async (n) => {
    const html = await (await n.getProperty('innerHTML')).jsonValue();
    return !!html.match(/navigateright/i);
  });
  if (!navRightButton) {
    throw new Error("No right navigation button found in lightbox.");
  }

  // Loop through all media
  let i = 0;
  do {
    console.log(`Inferring URL for media ${i}`);
    const mediaElem = await lightbox.waitForSelector('img,video');
    if (!mediaElem) {
      throw new Error("No media element found in lightbox.");
    }

    // Get image source URL or video source URL
    let src = await (await mediaElem.getProperty('src')).jsonValue();
    if (!src) {
      const sourceElem = (await mediaElem.$('source'));
      if (!sourceElem) {
        throw new Error("Cannot infer image or video source URL.");
      }

      src = await (await (sourceElem.getProperty('src'))).jsonValue();
    }
    link.mediaSources.push(src);

    await navRightButton.click();
    i++;
  } while (!await (await navRightButton.getProperty('disabled')).jsonValue());
}

async function findAccessibilityTreeNode(tree: puppeteer.SerializedAXNode, predicate: (node: puppeteer.SerializedAXNode) => boolean): Promise<puppeteer.SerializedAXNode | undefined> {
  if (predicate(tree)) {
    return tree;
  }
  if (tree.children) {
    for (const child of tree.children) {
      const result = await findAccessibilityTreeNode(child, predicate);
      if (result) {
        return result;
      }
    }
  }
}

async function downloadImages(page: puppeteer.Page, link: SocialSchoolsLinkWithMediaSources) {
  const cookies = await page.browser().cookies();
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

  const isoDateOnly = link.date.toISOString().split("T")[0];
  const group = `${isoDateOnly} ${link.messageId} ${link.subject}`.
    replace(/ *$/, '').
    replaceAll(DISALLOWED_PATH_CHARS, ' ');
  const outputDir = path.join("downloaded_photos", group);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\n### Downloading images for ${link.subject} ${link.href}`);
  for (const mediaSource of link.mediaSources) {
    const response = await axios.get(mediaSource, {
      responseType: "stream",
      headers: {
        Cookie: cookieHeader,
      },
    });


    const urlParts = new URL(mediaSource);
    const filename = path.basename(urlParts.pathname);
    const filePath = path.join(outputDir, filename);

    if (fs.existsSync(filePath)) {
      console.log(`File already exists: ${filename}`);
    } else {
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      console.log(`Downloaded: ${filename}`);
    }
    try {
      await ensureExifDate(filePath, link.date);
    } catch (e) {
      console.error(`!!! Failed to set EXIF date for ${filePath}: ${e}`);
    }
  }
}

async function ensureExifDate(filePath: string, date: Date): Promise<void> {
  const metadata = await exiftool.read(filePath);

  if (metadata.DateTimeOriginal || metadata.CreateDate) {
    console.log(`  File already has EXIF date: ${metadata.DateTimeOriginal || metadata.CreateDate}`);
    return;
  }

  const formattedDate = date.toISOString().replace(/T/, " ").replace(/\..+/, ""); // Format: "YYYY:MM:DD HH:MM:SS"
  await exiftool.write(filePath, {
    DateTimeOriginal: formattedDate,
    CreateDate: formattedDate,
  });
  fs.unlinkSync(`${filePath}_original`);

  console.log(`  Added EXIF date to file`);
}

void main();
