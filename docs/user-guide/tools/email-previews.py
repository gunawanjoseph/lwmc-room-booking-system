"""Renders the booking emails shown in the user guide, using made-up data.

    python3 docs/user-guide/tools/email-previews.py     (needs Pillow and Google Chrome)

Uses the real email templates in convex/emailNotifications.ts, so the
pictures always match what people receive. Nothing is sent. Writes
images/email-approver-request.png and images/email-requester-approved.png;
run optimize.py afterwards.
"""
import json
import os
import subprocess
import tempfile

from PIL import Image, ImageChops

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
IMAGES = os.path.join(ROOT, "docs", "user-guide", "images")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEMP_MODULE = os.path.join(ROOT, "convex", "__emailPreview.tmp.ts")

RENDER = r"""
import './tests/roomops-regression-hooks.mjs';
const m = await import('./convex/__emailPreview.tmp.ts');
const start = Date.UTC(2026, 8, 27, 11, 0);
const booking = { _id: 'b1', _creationTime: start, requesterName: 'Grace Tan', requesterEmail: 'grace@example.org',
  room: 'Ministry Centre A, B & C', startAt: start, endAt: start + 2 * 3600e3, eventName: 'Youth Worship Night Rehearsal',
  purpose: 'Youth Worship Night Rehearsal', ministry: 'Youth', revision: 1, submissionId: '6660377544408809682',
  jotformSubmissionId: '6660377544408809682', submittedAt: start - 5 * 86400e3, updatedAt: start, createdAt: start,
  reviewNote: 'Please return the chairs afterwards.' };
const out = {};
for (const [kind, status] of [['approver_request', 'pending'], ['requester_approved', 'approved']]) {
  out[kind] = m.composeDelivery({ booking: { ...booking, status },
    decisionToken: { _id: 't1', token: 'demo-token', bookingId: 'b1', expiresAt: start },
    delivery: { _id: 'd1', kind, bookingId: 'b1', recipient: 'grace@example.org' }, relatedBookings: [] }).html;
}
console.log(JSON.stringify(out));
"""

# The approval email's change/cancel buttons are added at send time; mirror them.
BUTTON = ('<a href="#" style="display:inline-block;background:#2f6fdd;color:#fff;text-decoration:none;'
          'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;'
          'font-weight:700;line-height:20px;padding:13px 22px;border-radius:10px">{}</a>')
MANAGEMENT = ('<div style="margin-top:24px;padding-top:20px;border-top:1px solid #eef0f4"><table role="presentation" '
              'class="email-actions" cellspacing="0" cellpadding="0" style="margin:24px 0 0 0"><tr><td class="email-action" '
              'style="padding:0 12px 0 0">' + BUTTON.format("Request Changes") + '</td><td class="email-action" style="padding:0">'
              + BUTTON.format("Cancel Booking") + '</td></tr></table><p style="font-size:13px;line-height:1.6;color:#667085">'
              'Request changes or cancel at least two hours before the selected meeting starts. Changes require approval. '
              'Keep these private links to yourself.</p></div>')

source = open(os.path.join(ROOT, "convex", "emailNotifications.ts")).read()
try:
    with open(TEMP_MODULE, "w") as file:
        file.write(source + "\nexport { composeDelivery };\n")
    env = {**os.environ, "GMAIL_CLIENT_ID": "x", "GMAIL_CLIENT_SECRET": "x", "GMAIL_REFRESH_TOKEN": "x",
           "GMAIL_FROM_EMAIL": "rooms@example.org", "APP_BASE_URL": "https://rooms.example.org"}
    result = subprocess.run(["node", "--input-type=module", "-e", RENDER], cwd=ROOT, env=env,
                            capture_output=True, text=True, check=True)
    emails = json.loads(result.stdout.strip().splitlines()[-1])
finally:
    if os.path.exists(TEMP_MODULE):
        os.remove(TEMP_MODULE)

emails["requester_approved"] = emails["requester_approved"].replace("<!--booking-management-->", MANAGEMENT)
work = tempfile.mkdtemp(prefix="guide-emails-")
for kind, markup in emails.items():
    page = os.path.join(work, kind + ".html")
    target = os.path.join(IMAGES, "email-" + kind.replace("_", "-") + ".png")
    open(page, "w").write(markup)
    # Chrome lays out at least ~500px wide; still under the email's 640px phone breakpoint.
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                    "--window-size=500,2600", f"--screenshot={target}", "file://" + page], check=True, capture_output=True)
    image = Image.open(target).convert("RGB")
    background = Image.new("RGB", image.size, image.getpixel((5, image.height - 5)))
    box = ImageChops.difference(image, background).getbbox()
    image.crop((0, 0, image.width, min(image.height, box[3] + 40))).save(target)
    print("wrote", os.path.relpath(target, ROOT))
