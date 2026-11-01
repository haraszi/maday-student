// Order handling for maday.ae deep dive purchases.
//
// Flow: the checkout form posts to /api/checkout -> we save the order and ask
// Ziina for a payment page -> the student pays -> we confirm the payment with
// Ziina (when they land on the thank-you page, and every 5 minutes as a backup)
// -> we email the assessment link (and booking link) to the student and the
// order details to Ildi. Everything else on the site is plain static files.

const PRODUCTS = {
  report: { name: "Deep dive report", fils: 18700, assessment: true, debrief: false },
  bundle: { name: "Deep dive + debrief", fils: 34900, assessment: true, debrief: true },
  debrief: { name: "Debrief session", fils: 21700, assessment: false, debrief: true },
};
const LANGS = { en: "English", ar: "Arabic" };
// Arabic wording for orders placed on maday.ae/ar
const AR = {
  products: { report: "تقرير التعمّق", bundle: "التعمّق + جلسة شخصية", debrief: "جلسة شخصية" },
  langs: { en: "الإنجليزية", ar: "العربية" },
  serverError: "صار خطأ من جهتنا. جرّب مرة ثانية، أو راسلنا على hello@maday.ae.",
  formError: "لو سمحت تأكد من البيانات في النموذج وجرّب مرة ثانية.",
};
const ZIINA_API = "https://api-v2.ziina.com/api";
const ORDER_TTL = 60 * 60 * 24 * 365 * 2; // keep orders 2 years, then KV deletes them

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/checkout" && request.method === "POST") return await checkout(request, env);
      if (url.pathname === "/api/confirm" && request.method === "POST") return await confirm(request, env);
    } catch (err) {
      console.error(err);
      // While in test mode, show the technical reason to help set things up.
      const detail = env.ZIINA_TEST === "true"
        ? String(err.message || err).replace(/Bearer\s+\S+/g, "Bearer ***") +
          ` | key lengths: ziina=${cleanKey(env.ZIINA_API_KEY).length}, resend=${cleanKey(env.RESEND_API_KEY).length}`
        : undefined;
      const ar = (request.headers.get("Referer") || "").includes("/ar/");
      return json({ error: ar ? AR.serverError : "Something went wrong on our side. Please try again, or email hello@maday.ae.", detail }, 500);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },

  // Backup: every 5 minutes, check orders that are still waiting for payment,
  // in case the student closed the browser before reaching the thank-you page.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkPending(env));
  },
};

async function checkout(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Please fill in the form." }, 400);
  if (body.website) return json({ error: "Please try again." }, 400); // spam trap field, hidden from people

  const clean = (v, max = 2000) => String(v ?? "").trim().slice(0, max);
  const order = {
    product: clean(body.product, 20),
    lang: clean(body.lang, 5),
    ui: body.ui === "ar" ? "ar" : "en", // which version of the site they ordered from
    name: clean(body.name, 120),
    email: clean(body.email, 200).toLowerCase(),
    q1: clean(body.q1),
    q2: clean(body.q2),
    q3: clean(body.q3),
    style: clean(body.style, 40),
    under18: body.under18 === true,
    parentEmail: clean(body.parentEmail, 200).toLowerCase(),
    parentConsent: body.parentConsent === true,
    agreedTerms: body.agreedTerms === true,
  };

  const errors = [];
  const product = PRODUCTS[order.product];
  if (!product) errors.push("Choose an option.");
  if (!LANGS[order.lang]) errors.push("Choose a language.");
  if (!order.name) errors.push("Add your name.");
  if (!isEmail(order.email)) errors.push("Check your email address.");
  if (!order.q1 || !order.q2 || !order.q3) errors.push("Answer the three questions.");
  if (order.under18 && !isEmail(order.parentEmail)) errors.push("Add your parent or guardian's email.");
  if (order.under18 && !order.parentConsent) errors.push("Confirm your parent or guardian agrees.");
  if (!order.agreedTerms) errors.push("Tick the box to accept the terms and refund policy.");
  if (errors.length) return json({ error: order.ui === "ar" ? AR.formError : errors.join(" ") }, 400);

  order.id = crypto.randomUUID();
  order.createdAt = new Date().toISOString();
  order.status = "pending";
  order.amount = product.fils / 100;

  const site = env.SITE_URL + (order.ui === "ar" ? "/ar" : "");
  const message = order.ui === "ar"
    ? `${AR.products[order.product]}${product.assessment ? ` (${AR.langs[order.lang]})` : ""} · maday.ae`
    : `${product.name}${product.assessment ? ` (${LANGS[order.lang]})` : ""} · maday.ae`;
  const intent = await ziina(env, "POST", "/payment_intent", {
    amount: product.fils,
    currency_code: "AED",
    message,
    success_url: `${site}/thank-you.html?order=${order.id}`,
    cancel_url: `${site}/deep-dive.html?p=${order.product}&cancelled=1`,
    failure_url: `${site}/deep-dive.html?p=${order.product}&failed=1`,
    test: env.ZIINA_TEST === "true",
  });
  if (!intent.id || !intent.redirect_url) throw new Error("Ziina did not return a payment page: " + JSON.stringify(intent));

  order.intentId = intent.id;
  await saveOrder(env, order);
  await env.ORDERS.put(`pending:${order.id}`, "1", { expirationTtl: 60 * 60 * 48 });
  return json({ redirect: intent.redirect_url });
}

async function confirm(request, env) {
  const body = await request.json().catch(() => ({}));
  const order = await getOrder(env, String(body.order || ""));
  if (!order) return json({ status: "unknown" }, 404);
  const status = await settle(env, order).catch((err) => {
    console.error("settle failed", order.id, err);
    return order.status === "paid" ? "paid" : "pending"; // the 5-minute check will retry
  });
  return json({ status, email: status === "paid" ? order.email : undefined });
}

async function checkPending(env) {
  const list = await env.ORDERS.list({ prefix: "pending:" });
  for (const key of list.keys) {
    const order = await getOrder(env, key.name.slice("pending:".length));
    if (order) await settle(env, order).catch((err) => console.error("settle failed", order.id, err));
  }
}

// Asks Ziina whether this order is paid and, the first time it is, sends the emails.
async function settle(env, order) {
  if (order.status !== "paid") {
    const intent = await ziina(env, "GET", `/payment_intent/${order.intentId}`);
    if (intent.status !== "completed") {
      if (["failed", "canceled"].includes(intent.status)) {
        order.status = intent.status;
        await saveOrder(env, order);
        await env.ORDERS.delete(`pending:${order.id}`);
      }
      return intent.status || "pending";
    }
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    await saveOrder(env, order);
  }

  // Each email is recorded as sent straight away, so a retry (if Resend has a
  // hiccup) only sends what is still missing and never emails anyone twice.
  if (!order.customerEmailed) {
    await sendEmail(env, { to: order.email, subject: customerSubject(order), html: customerEmail(env, order) });
    order.customerEmailed = new Date().toISOString();
    await saveOrder(env, order);
  }
  if (!order.ownerEmailed) {
    await sendEmail(env, {
      to: env.OWNER_EMAIL,
      subject: `New order: ${PRODUCTS[order.product].name} · ${order.name}`,
      html: ownerEmail(order),
      replyTo: order.email,
    });
    order.ownerEmailed = new Date().toISOString();
    await saveOrder(env, order);
  }
  await env.ORDERS.delete(`pending:${order.id}`);
  return "paid";
}

// ---------- emails ----------

function customerSubject(order) {
  if (order.ui === "ar") {
    return PRODUCTS[order.product].assessment
      ? "تعمّقك في بوصلة أسلوبك المهني: ابدأ من هني"
      : "احجز جلستك الشخصية";
  }
  return PRODUCTS[order.product].assessment
    ? "Your Career Style Compass deep dive: start here"
    : "Book your DISC career debrief";
}

function customerEmail(env, order) {
  return order.ui === "ar" ? customerEmailAr(env, order) : customerEmailEn(env, order);
}

function customerEmailAr(env, order) {
  const p = PRODUCTS[order.product];
  const link = order.lang === "ar" ? env.ASSESSMENT_LINK_AR : env.ASSESSMENT_LINK_EN;
  const first = esc(order.name.split(" ")[0]);
  const button = (href, label) =>
    `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#E5322D;color:#fff;padding:14px 24px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block">${label}</a></p>`;

  let html = `<div dir="rtl" lang="ar" style="font-family:Tahoma,Arial,sans-serif;font-size:16px;line-height:1.8;color:#1E1033;max-width:560px;text-align:right">
<p>هلا ${first}،</p>
<p>شكرًا لك، تم تأكيد دفعتك بقيمة ${order.amount} درهم. هذي خطوتك الجاية.</p>`;

  if (p.assessment) {
    html += `<h2 style="font-size:20px;margin:28px 0 8px">الخطوة الأولى: سوِّ تقييم DISC</h2>
<p>ياخذ تقريبًا من 15 إلى 20 دقيقة، باللغة ${AR.langs[order.lang]}. اختار وقت هادئ وجاوب بصراحة، ما في جواب صح أو غلط.</p>
${button(link, "ابدأ التقييم")}
<p style="font-size:14px;color:#5B4E6E">هذا الرابط خاص فيك، فلا تشاركه مع أحد لو سمحت.</p>`;
  }
  if (p.debrief) {
    html += `<h2 style="font-size:20px;margin:28px 0 8px">${p.assessment ? "الخطوة الثانية: " : ""}احجز جلستك الشخصية</h2>
<p>${p.assessment ? "بعد ما تخلّص التقييم، اختار" : "اختار"} الوقت اللي يناسبك، بالعربي أو الإنجليزي.</p>
${button(env.CAL_DEBRIEF_URL, "احجز جلستي")}`;
  }

  html += `<p>عندك أي سؤال؟ بس رد على هالإيميل.</p>
<p>إيلدي<br><span style="color:#5B4E6E">maday.ae · من التخمين إلى اليقين.</span></p>
<p style="font-size:12px;color:#5B4E6E;margin-top:32px">رقم الطلب: <span dir="ltr">${esc(order.id.slice(0, 8))}</span> · ${esc(AR.products[order.product])} · ${order.amount} درهم</p>
</div>`;
  return html;
}

function customerEmailEn(env, order) {
  const p = PRODUCTS[order.product];
  const link = order.lang === "ar" ? env.ASSESSMENT_LINK_AR : env.ASSESSMENT_LINK_EN;
  const first = esc(order.name.split(" ")[0]);
  const button = (href, label) =>
    `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#E5322D;color:#fff;padding:14px 24px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block">${label}</a></p>`;

  let html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.55;color:#1E1033;max-width:560px">
<p>Hi ${first},</p>
<p>Thank you, your payment of ${order.amount} AED is confirmed. Here's your next step.</p>`;

  if (p.assessment) {
    html += `<h2 style="font-size:20px;margin:28px 0 8px">Step 1: Take your DISC assessment</h2>
<p>It takes about 15 to 20 minutes, in ${LANGS[order.lang]}. Find a quiet moment and answer honestly: there are no right or wrong answers.</p>
${button(link, "Start my assessment")}
<p style="font-size:14px;color:#5B4E6E">This link is just for you, so please don't share it.</p>`;
  }
  if (p.debrief) {
    html += `<h2 style="font-size:20px;margin:28px 0 8px">${p.assessment ? "Step 2: " : ""}Book your one-to-one debrief</h2>
<p>${p.assessment ? "Once you've taken the assessment, pick" : "Pick"} a time that suits you, in English or Arabic.</p>
${button(env.CAL_DEBRIEF_URL, "Book my debrief")}`;
  }

  html += `<p>Any questions? Just reply to this email.</p>
<p>Ildi<br><span style="color:#5B4E6E">maday.ae · From guessing to SURE.</span></p>
<p style="font-size:12px;color:#5B4E6E;margin-top:32px">Order reference: ${esc(order.id.slice(0, 8))} · ${esc(p.name)} · ${order.amount} AED</p>
</div>`;
  return html;
}

function ownerEmail(order) {
  const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;color:#5B4E6E;vertical-align:top">${k}</td><td style="padding:6px 0">${v}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1E1033">
<h2 style="margin:0 0 12px">New paid order</h2>
<table style="border-collapse:collapse">
${row("Product", esc(PRODUCTS[order.product].name) + " · " + order.amount + " AED")}
${row("Assessment language", LANGS[order.lang])}
${row("Ordered on", order.ui === "ar" ? "Arabic site (maday.ae/ar)" : "English site")}
${row("Name", esc(order.name))}
${row("Email", esc(order.email))}
${row("Quiz style", esc(order.style || "not given"))}
${row("Under 18", order.under18 ? "Yes · parent/guardian: " + esc(order.parentEmail) + " (consent ticked)" : "No")}
${row("Paid", esc(order.paidAt))}
${row("Order ref", esc(order.id))}
</table>
<h3 style="margin:24px 0 4px">If you get the clarity you want from the assessment, what will be different for you in 12 months?</h3>
<p style="white-space:pre-wrap;margin:0">${esc(order.q1)}</p>
<h3 style="margin:20px 0 4px">What is the one thing standing between you and that great result right now?</h3>
<p style="white-space:pre-wrap;margin:0">${esc(order.q2)}</p>
<h3 style="margin:20px 0 4px">What made you look into this now, instead of next term?</h3>
<p style="white-space:pre-wrap;margin:0">${esc(order.q3)}</p>
<p style="margin-top:24px;color:#5B4E6E">The student has been emailed automatically. Reply to this email to write to them.</p>
</div>`;
}

// ---------- helpers ----------

async function ziina(env, method, path, body) {
  const res = await fetch(ZIINA_API + path, {
    method,
    headers: { Authorization: `Bearer ${cleanKey(env.ZIINA_API_KEY)}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Ziina ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

async function sendEmail(env, { to, subject, html, replyTo }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cleanKey(env.RESEND_API_KEY)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html, reply_to: replyTo || env.OWNER_EMAIL }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
}

async function getOrder(env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return env.ORDERS.get(`order:${id}`, "json");
}

function saveOrder(env, order) {
  return env.ORDERS.put(`order:${order.id}`, JSON.stringify(order), { expirationTtl: ORDER_TTL });
}

// Keys pasted into the dashboard sometimes carry spaces, quotes or "Bearer".
function cleanKey(v) {
  return String(v ?? "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
