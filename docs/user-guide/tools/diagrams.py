"""Draws the user-guide flow diagrams in the church palette.

    python3 docs/user-guide/tools/diagrams.py

Writes docs/user-guide/images/diagram-*.png using headless Google Chrome.
Edit the boxes below when a flow changes, then rebuild the guide
(npm run docs:guide).
"""
import html, os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGES = os.path.join(HERE, '..', 'images')
WORK = tempfile.mkdtemp(prefix='guide-diagrams-')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
NAVY="#265784"; SKY="#4280cf"; SOFT="#eef4fa"; LINE="#c9d6e4"; INK="#1b2430"; GREEN="#2b7353"; GSOFT="#e9f5ef"; RED="#a84646"; RSOFT="#fbe9e7"; AMBER="#8a5a12"; ASOFT="#fff2df"
STY={"step":(SOFT,NAVY,INK),"start":(NAVY,NAVY,"#fff"),"good":(GSOFT,GREEN,GREEN),"bad":(RSOFT,RED,RED),"warn":(ASOFT,AMBER,AMBER),"q":("#fff",SKY,NAVY)}
def box(x,y,w,h,text,kind="step"):
    fill,stroke,color=STY[kind]; lines=text.split("\n"); lh=19; y0=y+h/2-(len(lines)-1)*lh/2+6
    shape=(f'<polygon points="{x+w/2},{y} {x+w},{y+h/2} {x+w/2},{y+h} {x},{y+h/2}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>' if kind=="q"
           else f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
    t="".join(f'<text x="{x+w/2}" y="{y0+i*lh}" text-anchor="middle" font-size="15" font-weight="{700 if kind in ("start","q") else 600}" fill="{color}">{html.escape(l)}</text>' for i,l in enumerate(lines))
    return shape+t
def arrow(x1,y1,x2,y2,label=None,lx=None,ly=None):
    s=f'<path d="M{x1},{y1} L{x2},{y2}" stroke="{SKY}" stroke-width="2.2" fill="none" marker-end="url(#a)"/>'
    if label: s+=f'<text x="{lx if lx is not None else (x1+x2)/2+6}" y="{ly if ly is not None else (y1+y2)/2-6}" font-size="13" font-weight="700" fill="{SKY}">{html.escape(label)}</text>'
    return s
def elbow(pts,label=None,lx=0,ly=0):
    d="M"+" L".join(f"{x},{y}" for x,y in pts)
    s=f'<path d="{d}" stroke="{SKY}" stroke-width="2.2" fill="none" marker-end="url(#a)"/>'
    if label: s+=f'<text x="{lx}" y="{ly}" font-size="13" font-weight="700" fill="{SKY}">{html.escape(label)}</text>'
    return s
def page(name,w,h,body,title):
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{SKY}"/></marker></defs>
<rect width="{w}" height="{h}" fill="#ffffff"/><text x="28" y="40" font-size="19" font-weight="800" fill="{NAVY}">{html.escape(title)}</text>{body}</svg>'''
    open(os.path.join(WORK, f"{name}.html"),"w").write(f'<!doctype html><html><body style="margin:0;background:#fff">{svg}</body></html>')
    return (name,w,h)
out=[]
# 1 Booking request flow
b=""; b+=box(28,90,170,70,"You fill in the\nbooking form","start")+arrow(198,125,238,125)
b+=box(240,90,170,70,"Receipt email\narrives")+arrow(410,125,450,125)
b+=box(452,70,150,110,"Is the room\nfree?","q")
b+=elbow([(527,180),(527,250)],"No",535,220)+box(442,252,170,70,"\"Unavailable\" email:\npick another time","bad")
b+=arrow(602,125,652,125,"Yes",612,115)+box(654,90,180,70,"Church Office\nreviews it")
b+=elbow([(834,110),(880,110),(880,70),(900,70)])+box(902,35,210,70,"Approved: email +\nadded to calendar","good")
b+=elbow([(834,140),(880,140),(880,180),(900,180)])+box(902,145,210,70,"Rejected: email\nwith the reason","bad")
out.append(page("diagram-booking-flow",1140,345,b,"What happens after you request a room"))
# 2 Change / cancel flow
b=""; b+=box(28,120,190,64,"Approval or reminder\nemail","start")
b+=elbow([(218,140),(250,140),(250,90),(270,90)])+box(272,60,180,60,"Request Changes")
b+=elbow([(218,164),(250,164),(250,250),(270,250)])+box(272,220,180,60,"Cancel Booking")
b+=arrow(452,90,492,90)+box(494,40,150,100,"New time\nfree?","q")
b+=arrow(644,90,694,90,"Yes",652,80)+box(696,60,180,60,"Church Office\nreviews it")
b+=elbow([(569,140),(569,175),(694,175)],"No",577,165)+box(696,150,180,50,"Declined automatically","bad")
b+=elbow([(876,80),(906,80),(906,50),(926,50)])+box(928,20,220,56,"Approved: booking and\ncalendar updated","good")
b+=elbow([(876,100),(906,100),(906,130),(926,130)])+box(928,104,220,56,"Declined: original\nbooking kept","bad")
b+=arrow(452,250,492,250)+box(494,220,150,60,"Confirm")+arrow(644,250,694,250)+box(696,220,250,60,"Cancelled straight away,\nno approval needed","good")
out.append(page("diagram-change-flow",1180,310,b,"Changing or cancelling your booking"))
# 3 Reminder timeline
b=f'<path d="M150,150 L1030,150" stroke="{LINE}" stroke-width="6" stroke-linecap="round"/>'
pts=[(150,"Booking approved","Approval email with\nchange and cancel buttons","step"),(443,"2 days before","Reminder with\nchange and cancel buttons","step"),(736,"2 hours before","Reminder. Online changes\nnow closed","warn"),(1030,"Meeting","Enjoy your event!","good")]
for x,t,d,k in pts:
    fill,stroke,color=STY[k]
    b+=f'<circle cx="{x}" cy="150" r="13" fill="{stroke}"/><text x="{x}" y="112" text-anchor="middle" font-size="16" font-weight="800" fill="{NAVY}">{html.escape(t)}</text>'
    b+=box(x-122,180,244,62,d,k)
out.append(page("diagram-reminders",1180,270,b,"When booking emails and reminders arrive"))
# 4 Admin access
b=""; steps=[("Create an account","start"),("Verify your\nemail","step"),("Fill in the\nregistration form","step"),("Head Administrator\napproves your role","step"),("Sign in to the\ndashboard","good")]
x=28
for i,(t,k) in enumerate(steps):
    b+=box(x,80,185,70,t,k)
    if i<len(steps)-1: b+=arrow(x+185,115,x+215,115)
    x+=215
out.append(page("diagram-admin-access",1100,180,b,"Getting admin access"))
# 5 Approval decision
b=""; b+=box(28,80,180,66,"New request\n(Pending)","start")+arrow(208,113,244,113)
b+=box(246,80,190,66,"Open it in Bookings\nor from the email")+arrow(436,113,472,113)
b+=box(474,48,180,130,"Overlaps another\npending request?","q")
b+=elbow([(564,178),(564,222),(620,222)],"Yes",572,204)+box(622,195,240,56,"Tick to confirm you've\nchecked, then approve","warn")
b+=arrow(654,113,700,113,"No",662,103)+box(702,80,180,66,"Approve or Reject\n(+ optional note)")
b+=arrow(882,113,918,113)+box(920,80,210,66,"Calendar updated,\nrequester emailed","good")
b+=elbow([(862,223),(1025,223),(1025,148)])
out.append(page("diagram-approval",1160,275,b,"Approving a booking request"))
for name, w, h in out:
    target = os.path.join(IMAGES, f"{name}.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                    f"--window-size={w},{h}", f"--screenshot={target}", "file://" + os.path.join(WORK, f"{name}.html")],
                   check=True, capture_output=True)
    print("wrote", os.path.relpath(target))
