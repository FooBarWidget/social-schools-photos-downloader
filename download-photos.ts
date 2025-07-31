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


async function gotoArchive(page: puppeteer.Page) {
  // TODO: Do something useful with this function.
  // TODO: Use archive number as parameter, or loop over all archives or so.

  // Going directly to an archived page will lead to this error:
  //   FoutTypeError: can't access property 123456, Y.archived is undefined
  //   Code:0x8rfk3l
  // It is necessary to first go to the main archive page:
  await page.goto('https://app.socialschools.eu/archive');

  // And then click on a link like this:
  // <a class="d-block list-group-item list-group-item-action" href="/archive/177932"><div class="AvatarWithText__Wrapper-sc-h5fkaa-0 ehWgDD"><div color="[object Object]" class="ColorBlock-sc-1vftsp1-0 kQxKWC color-block"></div><div class="AvatarWithText__TextWrapper-sc-h5fkaa-1 jXra-Db avatar-text"><span>Groep 4 B (2023–2024)</span></div></div></a>
  await page.waitForSelector("a[href='/archive/123456']", {visible: true});
  await page.click("a[href='/archive/123456']");
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
