# Room Booking user guide

A plain-language guide for requesters and admins, with screenshots and diagrams.

| File | What it is |
| --- | --- |
| `USER_GUIDE.md` | The guide's text. **Edit this**, not the Word file |
| `RoomOps-User-Guide.docx` | The Word version to share, built from `USER_GUIDE.md` |
| `images/` | Screenshots (`.jpg`) and diagrams (`diagram-*.png`) |
| `build.mjs` | Builds the Word file |
| `tools/` | Helpers for refreshing the screenshots, emails and diagrams |

## Updating the guide when a feature changes

Do this in the same pull request as the feature, so the guide never falls behind.

1. **Edit the text** in `USER_GUIDE.md`. Keep it plain: no code, settings or integration details.
2. **Add a row** to the top of the *What's new* table (date, change, status). Change the status from *Coming soon* to *Live* once it's deployed. Update the "Last updated" date near the top.
3. **Refresh pictures** that no longer match the app (steps below).
4. **Rebuild the Word file:** `npm run docs:guide`
5. Open `RoomOps-User-Guide.docx` in Word, check the new pages, and commit the Markdown, images and `.docx` together.

The Markdown supports: `#`/`##`/`###` headings, `**bold**`, `*italic*`, `- ` and `1. ` lists, pipe tables, images (two images on one line appear side by side, which suits phone screenshots), `> ` tip boxes and `<!-- pagebreak -->`.

## Refreshing pictures

**Diagrams:** edit the boxes in `tools/diagrams.py`, then run `python3 docs/user-guide/tools/diagrams.py`.

**Emails:** run `python3 docs/user-guide/tools/email-previews.py`. It renders the real email templates with made-up data; nothing is sent.

**App screenshots:**

1. Start the app (`npm run dev`), sign in as an admin, and run `python3 docs/user-guide/tools/receiver.py` in another terminal.
2. Set the browser window to 1280×800 for computer shots, or 390×844 (device mode) for phone shots.
3. Paste `tools/capture-helper.js` into the browser console, then take each shot, for example:
   `await __shot("bookings-desktop", document.body, { width: innerWidth, height: innerHeight })`
4. Run `python3 docs/user-guide/tools/optimize.py` to shrink the new screenshots.

**Privacy:** this repository is shared, so screenshots must never show real church members. The capture helper swaps real names, email addresses and phone numbers for made-up ones before every capture. Still look at every image before committing, and retake any that show a real person.

The tools need Python 3 with Pillow (`pip install pillow`) and Google Chrome.
