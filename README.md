# Social Schools photos downloader

Automates downloading photos from Social Schools.

## Setup

- `npm install`
- Create an OAuth consent screen in Google Cloud for the Gmail domain. Download the client credentials JSON file and store it in `google_oauth_client_credentials.json`.

## Run

1. `npx tsx extract-links.ts` to fetch Social Schools email from Gmail inbox. Extracts all Social Schools post links to links.json.
2. `npx tsx download-photos.ts` to download photos.
   - In the automated browser, make sure to login manually.
   - Photos are downloaded to `downloaded_photos/`, grouped by date and post subject.
   - EXIF dates are automatically added to downloaded photos if necessary.
   - Only job remaining is to delete irrelevant photos and adding locations.
