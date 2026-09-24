// Screenshot helper for the user guide. Paste into the browser console on a
// page of the running app (npm run dev, signed in as an admin), with
// tools/receiver.py running. Then, for example:
//
//   await __shot("bookings-desktop", document.body, { width: innerWidth, height: innerHeight })
//   await __shot("public-calendar-phone", document.querySelector(".booking-calendar"))
//
// Before every capture it replaces real people's names, email addresses and
// phone numbers with made-up ones. Screenshots end up in a public repository,
// so never capture without it, and look at every image before committing.
(async () => {
  // Freeze transitions so overlays are captured in their final position.
  if (!document.getElementById("__guide-no-motion")) {
    const style = document.createElement("style");
    style.id = "__guide-no-motion";
    style.textContent = "*,*::before,*::after,::backdrop{transition:none!important;animation:none!important}";
    document.head.appendChild(style);
  }
  if (!window.htmlToImage) {
    await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js"; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }
  const FAKE = ["Grace Tan", "Daniel Lim", "Sarah Ng", "Joshua Lee", "Rachel Koh", "Matthew Ong", "Hannah Goh", "Samuel Chua", "Esther Wong", "Caleb Teo", "Ruth Sim", "Aaron Yeo"];
  window.__names = window.__names || new Map();
  // Names are collected from the places people appear; the church's own
  // account and the logo text are never treated as a person.
  const add = (raw) => {
    const n = (raw || "").split("·")[0].trim();
    if (n && n.length > 2 && n.length < 60 && !/^(Developer|Unspecified|RoomOps|Admin|Shema|Ministry|Board|L1|Office|Counselling)/.test(n) && !/Living Waters|Methodist|Church/i.test(n) && !window.__names.has(n)) {
      window.__names.set(n, FAKE[window.__names.size % FAKE.length]);
    }
  };
  window.__mask = () => {
    document.querySelectorAll(".booking-table tbody td:first-child strong, .recent-main span, .support-thread small, .user-table tbody td:first-child strong, [data-person]").forEach((el) => add(el.textContent));
    const names = [...window.__names.entries()].sort((a, b) => b[0].length - a[0].length);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest(".brand, .church-lockup, .auth-brand, .sidebar-user")) continue;
      let t = node.nodeValue;
      const original = t;
      t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => (m.endsWith("example.org") ? m : "member@example.org"));
      t = t.replace(/\(65\)\s?\d{4}\s?\d{4}|\+\d{1,3}[\d ]{6,}\d/g, "(65) 8123 4567");
      for (const [real, fake] of names) if (t.includes(real)) t = t.split(real).join(fake);
      if (t !== original) node.nodeValue = t;
    }
    document.querySelectorAll("input, textarea").forEach((field) => {
      let v = field.value;
      if (/@/.test(v)) v = "member@example.org";
      for (const [real, fake] of names) if (v.includes(real)) v = v.split(real).join(fake);
      if (v !== field.value) field.value = v;
    });
  };
  window.__shot = async (name, node = document.body, opts = {}) => {
    window.__mask();
    await new Promise((r) => setTimeout(r, 200));
    const png = await htmlToImage.toPng(node, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      filter: (el) => !(el.tagName && ["nextjs-portal", "script"].includes(el.tagName.toLowerCase())),
      ...opts,
    });
    const res = await fetch("http://127.0.0.1:8767/save?name=" + name, { method: "POST", headers: { "Content-Type": "text/plain" }, body: png });
    return `${name}: ${await res.text()} bytes`;
  };
  return "ready";
})();
