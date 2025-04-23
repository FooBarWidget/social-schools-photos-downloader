import path from "node:path";
import fs from "node:fs";
import * as puppeteer from "puppeteer";
import axios from "axios";
import { SocialSchoolsLink } from "./lib/types";
import { asyncFind, pathExists } from "./lib/utils";

interface SocialSchoolsLinkWithMediaSources extends SocialSchoolsLink {
  mediaSources: string[];
}

async function main() {
  if (!(await pathExists("links.json"))) {
    console.error(
      `Error: Links file not found at links.json. Please run 'npx tsx extract-links.ts' first.`
    );
    process.exit(1);
  }

  const links = loadLinks();
  const browser = await puppeteer.launch({ headless: false });
  let exitStatus = 0;

  try {
    try {
      const page = await browser.newPage();
      await loginSocialSchools(page);

      for (const link of links) {
        await scrapePostForImages(page, link);
      }

      for (const link of links) {
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

async function scrapePostForImages(page: puppeteer.Page, link: SocialSchoolsLinkWithMediaSources) {
  console.log(`\n### Scraping images for ${link.subject} ${link.href}`);

  // Load post
  console.log('Waiting for post to load...');
  await page.goto(link.href, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForSelector('textarea[placeholder="Reageer op dit bericht"]', { timeout: 10000 });
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
  const outputDir = path.join("downloaded_photos", `${isoDateOnly} ${link.messageId} ${link.subject}`.replace(/ *$/, ''));
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
    const filePath = path.join(outputDir, path.basename(urlParts.pathname));

    if (fs.existsSync(filePath)) {
      console.log(`File already exists: ${filePath}`);
      continue;
    }

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    console.log(`Downloaded: ${filePath}`);
  }
}

void main();
