const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const time12 = (hm) => {
  const [h, m] = hm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};
const prettyPhone = (p) => p.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");

// ---------- shop info (same config the agent uses) ----------
fetch("/api/shop").then((r) => r.json()).then((shop) => {
  for (const a of $$("[data-phone-link]")) {
    a.href = `tel:${shop.phone}`;
    if (!a.classList.contains("channel")) a.textContent = prettyPhone(shop.phone);
  }
  for (const t of $$("[data-phone-text]")) t.textContent = prettyPhone(shop.phone);
  $("#address").textContent = shop.address;
  for (const b of $$(".surcharge")) b.textContent = `+$${shop.surcharge}`;

  // Packages, with the large-vehicle surcharge applied by the size toggle.
  let large = false;
  const PHOTOS = ["hand-wash", "interior", "foam", "polish"]; // same order as SERVICES in config.ts
  const extras = () => {
    const card = el("article", "pkg extra");
    const img = Object.assign(el("img"), { src: "/img/dash-brush.jpg", alt: "", loading: "lazy" });
    const body = el("div", "pkg-body");
    const ask = el("button", "btn small", "Request a quote");
    ask.onclick = () => openChat("I'm interested in ceramic coating. Can I get a quote?");
    body.append(el("h3", null, "Ceramic · Paint correction · Odor removal"), el("p", "len", "Quoted in person, after we've seen the car."), ask);
    card.append(img, body);
    return card;
  };
  const renderPackages = () => $("#packages-grid").replaceChildren(...shop.services.map((s, i) => {
    const card = el("article", "pkg");
    const img = Object.assign(el("img"), { src: `/img/${PHOTOS[i] ?? "garage"}.jpg`, alt: "", loading: "lazy" });
    const body = el("div", "pkg-body");
    card.append(img, body);
    body.append(el("span", "num", String(i + 1).padStart(2, "0")), el("h3", null, s.name), el("div", "len", s.minutes >= 60 ? `${s.minutes / 60} hr` : `${s.minutes} min`));
    const price = el("div", "price");
    price.append(el("small", null, "$"), String(s.price + (large ? shop.surcharge : 0)));
    const list = el("ul");
    for (const item of s.includes.split(/, | plus /)) list.append(el("li", null, item.replace(/^the /, "")));
    const book = el("button", "btn small ghost", "Book this");
    book.onclick = () => openChat(`I'd like to book a ${s.name}${large ? " for a large vehicle" : ""}.`);
    body.append(price, list, book);
    return card;
  }), extras());
  for (const b of $$("[data-size]")) b.onclick = () => {
    large = b.dataset.size === "1";
    for (const o of $$("[data-size]")) o.setAttribute("aria-checked", String(o === b));
    renderPackages();
  };
  renderPackages();

  // Shop-local day/time, whatever the visitor's timezone.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: shop.tz, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const today = DAYS.indexOf(parts.weekday) + 1; // 1 = Monday, same as config
  const nowHm = `${parts.hour}:${parts.minute}`;
  $("#hours-table").replaceChildren(...DAYS.map((d, i) => {
    const h = shop.hours[i + 1];
    const tr = el("tr", i + 1 === today ? "today" : "");
    tr.append(el("td", null, d), el("td", null, h ? `${time12(h[0])} – ${time12(h[1])}` : "Closed"));
    return tr;
  }));
  const h = shop.hours[today];
  const open = h && nowHm >= h[0] && nowHm < h[1];
  $("#open-status").textContent = open ? `● Open now · until ${time12(h[1])}` : "Closed now · booking open 24/7";
  $("#open-status").classList.toggle("open", !!open);
}).catch(() => {});

// ---------- process: the step nearest mid-screen picks the looping clip ----------
const clips = [...$$(".screen video")], hero = $(".hero-video");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
let clip = 0, screenVisible = false;
function playClip(i) {
  clips.forEach((v, j) => {
    v.classList.toggle("on", j === i);
    if (j === i && screenVisible && !still) {
      v.preload = "auto";
      v.play().catch(() => {});
    } else v.pause();
  });
  // Warm up the next clip so the switch is instant.
  if (clips[i + 1]) clips[i + 1].preload = "auto";
  $("#clip-num").textContent = String(i + 1).padStart(2, "0");
  $("#clip-bar").style.width = `${((i + 1) / clips.length) * 100}%`;
}
// The step whose middle is closest to the viewport's middle is the active one.
const steps = [...$$(".pstep")];
let queued = false;
function pickStep() {
  queued = false;
  let best = steps[0], bestD = Infinity;
  for (const s of steps) {
    const r = s.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - innerHeight / 2);
    if (d < bestD) [best, bestD] = [s, d];
  }
  if (+best.dataset.clip === clip && best.classList.contains("on")) return;
  clip = +best.dataset.clip;
  for (const s of steps) s.classList.toggle("on", s === best);
  playClip(clip);
}
addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(pickStep); } }, { passive: true });
pickStep();
// Only decode video that's on screen.
new IntersectionObserver(([e]) => { screenVisible = e.isIntersecting; playClip(clip); }).observe($(".screen"));
new IntersectionObserver(([e]) => { e.isIntersecting && !still ? hero.play().catch(() => {}) : hero.pause(); }).observe(hero);
if (still) hero.removeAttribute("autoplay");

// ---------- panel (chat + talk tabs) ----------
const panel = $("#panel"), dock = $("#dock");
function show(view) {
  panel.hidden = false;
  dock.hidden = true;
  for (const t of $$(".tabs [data-view]")) t.setAttribute("aria-selected", String(t.dataset.view === view));
  for (const v of $$(".view")) v.hidden = v.dataset.view !== view;
}
for (const t of $$(".tabs [data-view]")) t.onclick = () => show(t.dataset.view);
$("#panel-close").onclick = () => { panel.hidden = true; dock.hidden = false; };

// ---------- chat (same /chat agent as before) ----------
const store = sessionStorage;
const sessionId = store.getItem("sessionId") || crypto.randomUUID();
store.setItem("sessionId", sessionId);
const history = JSON.parse(store.getItem("chat") || "[]");
const log = $("#chat-log"), input = $("#chat-input");
let busy = false;

function add(cls, text, save = true) {
  const p = el("div", `msg ${cls}`, text);
  log.append(p);
  log.scrollTop = log.scrollHeight;
  if (save) {
    history.push([cls, text]);
    store.setItem("chat", JSON.stringify(history));
  }
  return p;
}
if (history.length) for (const [cls, text] of history) add(cls, text, false);
else add("agent", "Hi! I'm Cedar Lane's AI receptionist. I can book, move or cancel an appointment, or answer questions about prices, hours and prep. Anything I can't handle goes to the owner.", false);

function openChat(prefill) {
  show("chat");
  if (prefill) send(prefill);
  else input.focus();
}
for (const b of $$("[data-open-chat]")) b.onclick = () => openChat();
for (const b of $$("[data-ask]")) b.onclick = () => openChat(b.dataset.ask);

async function send(message) {
  if (busy || !message) return;
  busy = true;
  input.disabled = true;
  add("you", message);
  const typing = add("typing", "Typing…", false);
  try {
    const r = await fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message }) });
    const data = await r.json();
    data.reply !== undefined ? add("agent", data.reply) : add("err", "Sorry, something went wrong. Please try again or call us.");
  } catch {
    add("err", "Can't reach the shop right now. Please try again or call us.");
  } finally {
    typing.remove();
    busy = false;
    input.disabled = false;
    input.focus();
  }
}
$("#chat-form").onsubmit = (e) => {
  e.preventDefault();
  const m = input.value.trim();
  input.value = "";
  send(m);
};

// ---------- talk (Vapi web call, same assistant as the phone line) ----------
const orb = $("#orb"), callStatus = $("#call-status"), captions = $("#captions"), callBtn = $("#call-btn"), muteBtn = $("#mute-btn");
let vapi, inCall = false;
orb.classList.add("idle");

function setCall(on) {
  inCall = on;
  callBtn.textContent = on ? "End call" : "Start call";
  callBtn.disabled = false;
  muteBtn.hidden = !on;
  orb.classList.toggle("idle", !on);
  if (!on) orb.style.setProperty("--level", 0);
}

async function startCall() {
  callBtn.disabled = true;
  callStatus.textContent = "Connecting…";
  captions.replaceChildren();
  try {
    const r = await fetch("/api/voice", { method: "POST" });
    if (!r.ok) throw new Error("Voice calls aren't available right now. Try the chat, or call us.");
    const { publicKey, assistantId } = await r.json();
    if (!vapi) {
      // Loaded on first use only, so the page stays light.
      const mod = await import("https://esm.sh/@vapi-ai/web@3.1.0");
      const Vapi = mod.default?.default ?? mod.default;
      vapi = new Vapi(publicKey);
      vapi.on("call-start", () => { setCall(true); callStatus.textContent = "Connected. Go ahead and talk."; });
      vapi.on("call-end", () => { setCall(false); callStatus.textContent = "Call ended. Thanks for calling!"; });
      vapi.on("speech-start", () => { callStatus.textContent = "Receptionist is speaking…"; });
      vapi.on("speech-end", () => { callStatus.textContent = "Listening…"; });
      vapi.on("volume-level", (v) => orb.style.setProperty("--level", v));
      vapi.on("message", (m) => {
        if (m.type !== "transcript" || m.transcriptType !== "final") return;
        const p = el("p");
        p.append(el("b", null, m.role === "user" ? "You" : "Cedar Lane"), m.transcript);
        captions.append(p);
        captions.scrollTop = captions.scrollHeight;
      });
      vapi.on("error", (e) => { console.error(e); setCall(false); callStatus.textContent = "The call dropped. Please try again."; });
    }
    await vapi.start(assistantId);
  } catch (e) {
    setCall(false);
    callStatus.textContent = e.message || "Couldn't start the call. Check microphone access and try again.";
  }
}
callBtn.onclick = () => (inCall ? vapi.stop() : startCall());
muteBtn.onclick = () => {
  vapi.setMuted(!vapi.isMuted());
  muteBtn.textContent = vapi.isMuted() ? "Unmute" : "Mute";
};
for (const b of $$("[data-talk]")) b.onclick = () => { show("talk"); if (!inCall) startCall(); };

if (location.hash === "#chat") openChat(); // shareable "book online" link
if (location.hash === "#talk") show("talk");
