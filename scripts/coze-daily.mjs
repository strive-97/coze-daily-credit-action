import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { notifyFailure, notifyResult } from "./notifications.mjs";
import { cookieExpiryInfo, cookieExpiryLine, cookieRenewalHint } from "./cookie-health.mjs";

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, "artifacts");
const STORAGE_STATE_PATH = path.join(ARTIFACT_DIR, "storage_state.json");
const UPDATED_STORAGE_STATE_PATH = path.join(ARTIFACT_DIR, "storage_state.updated.json");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "failure.png");
const NOTIFICATION_SENT_PATH = path.join(ARTIFACT_DIR, "notification.sent");

const DEFAULT_TARGET_URL = "https://www.coze.cn/home";
const targetUrl = process.env.COZE_TARGET_URL || DEFAULT_TARGET_URL;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "";

const DEFAULT_CLICK_TEXTS = [
  "领取",
  "签到",
  "免费积分",
  "每日",
  "去领取",
  "立即领取",
  "Get",
  "Claim"
];

const CONFIRM_TEXTS = ["立即领取", "确认领取", "确认", "Claim", "Get"];
const CLAIMED_MARKERS = [
  "已签到",
  "今日已签到",
  "已领取",
  "今日已领",
  "明日再来",
  "明天再来",
  "明日可领"
];

// Elements worth looking at when the claim entry is not on the landing page.
const CANDIDATE_PATTERN = "积分|签到|领取|任务|权益|额度|credit|point|check.?in";
const STRONG_TEXT_PATTERN = "领取|签到|Claim|Get";
const FOLLOWUP_TEXT_PATTERN = "领取|签到";
const CREDIT_LINE_PATTERN = "积分|签到|领取|额度|权益";
// Never click these: they open payment / upsell flows.
const AVOID_TEXT_PATTERN = "增购|购买|充值|续费|支付|付款|开票|订单|开通|升级|订阅|剩余|积分管理|积分单位";
const EXPAND_TEXTS = ["查看全部任务", "全部任务", "更多任务", "任务中心"];
// A click that opens one of these stops the confirm stage outright.
const PAYMENT_PATTERN = /支付|扣款|付款|购买|订单|开通|发票|\d+\s*元|¥/;
// https://www.coze.cn/ lands on an account-specific /session/<id> page that carries the
// "积分剩余 100%" entry, which opens the credit management page.
const CREDIT_PAGE_URL = "https://www.coze.cn/subscription/manage";
const EXTRA_PROBE_URLS = ["https://www.coze.cn/", "https://www.coze.cn/overview"];

async function main() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await materializeStorageState();

  const cookieInfo = cookieExpiryInfo();
  console.log(`Cookie expiry check: ${JSON.stringify(cookieInfo)}`);
  console.log(cookieExpiryLine(cookieInfo));

  const launchOptions = {
    headless: process.env.HEADLESS !== "false"
  };
  if (process.env.PLAYWRIGHT_CHANNEL) {
    launchOptions.channel = process.env.PLAYWRIGHT_CHANNEL;
  }

  // A persistent profile lets the same script run on a real machine and keep the login
  // across days instead of relying on an exported cookie blob.
  const profileDir = process.env.COZE_PROFILE_DIR?.trim();
  let browser = null;
  let context = null;
  try {
    if (profileDir) {
      await fs.mkdir(profileDir, { recursive: true });
      context = await chromium.launchPersistentContext(profileDir, {
        ...launchOptions,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai"
      });
    } else {
      browser = await chromium.launch(launchOptions);
      context = await browser.newContext({
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        storageState: STORAGE_STATE_PATH
      });
    }

    const page = await context.newPage();
    page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000));

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page);
    await assertLoggedIn(page);

    const report = await claimDaily(page);
    await settle(page);
    await assertLoggedIn(page);
    await classifyClaimState(page, report);

    if (report.outcome === "unknown") {
      await probeAlternateEntries(page, report);
      await settle(page);
      await classifyClaimState(page, report);
    }

    await openCreditPage(page, report);

    await context.storageState({ path: UPDATED_STORAGE_STATE_PATH });

    const creditPageReadable = Boolean(report.creditPage?.finalUrl) &&
      !/login|passport|sso|signin/i.test(report.creditPage.finalUrl);
    if (report.outcome === "unknown" && (report.balance || creditPageReadable)) {
      report.outcome = "no-entry";
    }

    console.log("Claim report:", JSON.stringify(report, null, 2));
    console.log(`Coze daily visit completed: ${targetUrl}`);
    console.log(`Updated storage state written to ${UPDATED_STORAGE_STATE_PATH}`);

    if (report.outcome === "unknown" && process.env.COZE_CLAIM_STRICT !== "0") {
      const preview = (report.candidates || [])
        .slice(0, 5)
        .map((item) => item.text)
        .filter(Boolean)
        .join("、") || "无";
      const unknownError = new Error(
        `签到结果未知：落地页 ${report.url || targetUrl}（标题：${report.pageTitle || "无"}）` +
        `既没有可点击的领取入口，也没有“已领取/已签到”标记，而且积分管理页也读不到余额（可能已掉登录）。` +
        `疑似入口元素：${preview}。页面积分相关文本：${(report.creditLines || []).slice(0, 4).join(" / ") || "无"}。` +
        `完整清单见运行日志的 Claim report，页面截图在 coze-failure artifact 里。`
      );
      await captureFailure(context, unknownError);
      throw unknownError;
    }

    if (process.env.COZE_NOTIFY_SUCCESS !== "0") {
      const expiringSoon = cookieInfo.daysLeft !== null && cookieInfo.daysLeft <= 2;
      const notified = await notifyResult({
        title: `${expiringSoon ? `【登录态只剩 ${cookieInfo.daysLeft} 天】` : ""}${notificationTitle(report)}`,
        content: buildSuccessMessage(report, cookieInfo)
      });
      if (notified) {
        await fs.writeFile(NOTIFICATION_SENT_PATH, new Date().toISOString(), "utf8").catch(() => {});
      }
    }
  } catch (error) {
    await captureFailure(context, error);
    const notified = await notifyFailure({
      error,
      runUrl,
      repository: process.env.GITHUB_REPOSITORY,
      extra: cookieRenewalHint(error, cookieInfo)
    });
    if (notified) {
      await fs.writeFile(NOTIFICATION_SENT_PATH, new Date().toISOString(), "utf8").catch(() => {});
    }
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function materializeStorageState() {
  const storageStateJson = process.env.COZE_STORAGE_STATE_JSON?.trim();
  const cookiesJson = process.env.COZE_COOKIES_JSON?.trim();

  if (storageStateJson) {
    const storageState = JSON.parse(storageStateJson);
    validateStorageState(storageState);
    await fs.writeFile(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2), "utf8");
    return;
  }

  if (!cookiesJson) {
    if (process.env.COZE_PROFILE_DIR?.trim()) {
      // Local mode keeps its login in the browser profile, so an empty state is fine.
      await fs.writeFile(STORAGE_STATE_PATH, JSON.stringify({ cookies: [], origins: [] }, null, 2), "utf8");
      return;
    }
    throw new Error("Missing COZE_STORAGE_STATE_JSON or COZE_COOKIES_JSON secret.");
  }

  const rawCookies = JSON.parse(cookiesJson);
  const cookies = Array.isArray(rawCookies) ? rawCookies : rawCookies.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("COZE_COOKIES_JSON must be a non-empty cookie array or a storage state object with cookies.");
  }

  const normalizedCookies = cookies
    .map(normalizeCookie)
    .filter((cookie) => cookie.name && cookie.value && isCozeCookieDomain(cookie.domain));
  if (normalizedCookies.length === 0) {
    throw new Error("COZE_COOKIES_JSON did not contain usable Coze cookies.");
  }

  const storageState = {
    cookies: normalizedCookies,
    origins: Array.isArray(rawCookies.origins) ? rawCookies.origins : []
  };
  await fs.writeFile(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2), "utf8");
}

function validateStorageState(storageState) {
  if (!storageState || !Array.isArray(storageState.cookies) || storageState.cookies.length === 0) {
    throw new Error("COZE_STORAGE_STATE_JSON must be a Playwright storage_state object with cookies.");
  }
}

function normalizeCookie(cookie) {
  const normalized = {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: cookie.domain || ".coze.cn",
    path: cookie.path || "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite)
  };

  // Playwright reports session cookies with expires === -1; writing that back would mean
  // "already expired", so the field is only kept for real expiry timestamps.
  const expiry = Number(cookie.expires ?? cookie.expirationDate);
  if (Number.isFinite(expiry) && expiry > 0) {
    normalized.expires = expiry;
  }

  return normalized;
}

function isCozeCookieDomain(domain) {
  return /coze\.cn|volcengine\.com|volccloudidentity\.com/i.test(String(domain || ""));
}

function normalizeSameSite(value) {
  if (["Strict", "Lax", "None"].includes(value)) {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "strict") return "Strict";
    if (lower === "lax") return "Lax";
    if (lower === "none" || lower === "no_restriction") return "None";
  }
  return "Lax";
}

async function assertLoggedIn(page) {
  const url = page.url();
  if (/login|passport|sso|signin/i.test(url)) {
    // The full Volcengine SSO URL is huge and swallows the pushplus message, so only
    // origin + path is quoted.
    let shownUrl = url;
    try {
      const parsed = new URL(url);
      shownUrl = `${parsed.origin}${parsed.pathname}`;
    } catch {
      shownUrl = url.slice(0, 120);
    }
    throw new Error(`Login appears expired; current URL is ${shownUrl}`);
  }

  const loginControls = await page
    .getByText(/登录|注册|Sign in|Log in/i)
    .count()
    .catch(() => 0);

  const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, 2000);
  const hasLoggedOutHint = /请登录|未登录|登录后|Sign in|Log in/i.test(bodyText);
  if (loginControls > 0 && hasLoggedOutHint) {
    throw new Error("Login appears expired; login text was detected on the page.");
  }
}

async function claimDaily(page) {
  const report = {
    outcome: "unknown",
    clicked: [],
    clickDetails: [],
    claimedMarkers: [],
    candidates: [],
    probed: [],
    creditLines: [],
    creditPage: null,
    balance: null,
    pageTitle: "",
    url: "",
    beijingTime: new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false
    })
  };

  await classifyClaimState(page, report);
  if (report.claimedMarkers.length) {
    report.outcome = "already-claimed";
    console.log("Already-claimed markers found; skip clicking.");
    report.creditLines = await extractCreditLines(page);
    return report;
  }

  report.candidates = await harvestClaimCandidates(page);
  await clickClaimControls(page, report);
  report.creditLines = await extractCreditLines(page);
  return report;
}

async function clickClaimControls(page, report, texts) {
  const configuredTexts = (process.env.COZE_CLICK_TEXTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const clickTexts = texts || (configuredTexts.length ? configuredTexts : DEFAULT_CLICK_TEXTS);
  const avoid = new RegExp(AVOID_TEXT_PATTERN, "i");

  for (const text of clickTexts) {
    const locator = page.getByText(text, { exact: false }).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    const elementText = await locator.innerText().catch(() => "");
    if (avoid.test(elementText)) {
      console.log(`Skipped "${text}": "${elementText.replace(/\s+/g, " ").slice(0, 60)}" looks like a payment entry.`);
      continue;
    }

    const html = await describeElement(locator);
    await locator.click({ timeout: 5000 }).catch(() => {});
    recordClick(report, text, html, page.url());
    console.log(`Clicked possible claim control: ${text}`);
    await page.waitForTimeout(2000);
    report.creditLines = await extractCreditLines(page);

    const dialogText = await getDialogText(page);
    if (PAYMENT_PATTERN.test(dialogText)) {
      console.log(`A payment-looking dialog is open ("${dialogText.slice(0, 80)}"); refusing to confirm anything.`);
      report.paymentGuard = dialogText.slice(0, 200);
      break;
    }

    for (const confirmText of CONFIRM_TEXTS) {
      const confirm = page.getByText(confirmText, { exact: false }).first();
      const confirmVisible = await confirm.isVisible().catch(() => false);
      if (!confirmVisible) continue;
      const confirmHtml = await describeElement(confirm);
      await confirm.click({ timeout: 5000 }).catch(() => {});
      recordClick(report, confirmText, confirmHtml, page.url());
      console.log(`Clicked follow-up control: ${confirmText}`);
      await page.waitForTimeout(2000);
      report.creditLines = await extractCreditLines(page);
      break;
    }
    break;
  }

  if (!report.clicked.length) {
    console.log("No claim-like control found on this page.");
  }
  return report;
}

function recordClick(report, text, html, url) {
  report.clicked.push(text);
  report.clickDetails = report.clickDetails || [];
  report.clickDetails.push({ text, url, html });
  if (html) {
    console.log(`  clicked element: ${html.slice(0, 160)}`);
  }
}

async function describeElement(locator) {
  return locator
    .evaluate((el) => el.outerHTML.replace(/\s+/g, " ").trim().slice(0, 200))
    .catch(() => "");
}

async function getDialogText(page) {
  return page
    .evaluate(() => {
      const scopes = document.querySelectorAll(
        '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"], [class*="drawer"]'
      );
      let text = "";
      for (const el of scopes) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          text += " " + (el.innerText || "");
        }
      }
      return text.replace(/\s+/g, " ").trim().slice(0, 3000);
    })
    .catch(() => "");
}

async function extractCreditLines(page) {
  const bodyText = (await page.locator("body").innerText({ timeout: 8000 }).catch(() => "")).slice(0, 40000);
  const pattern = new RegExp(CREDIT_LINE_PATTERN, "i");
  const lines = bodyText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && line.length <= 90 && pattern.test(line));
  const unique = [...new Set(lines)].slice(0, 12);
  if (unique.length) {
    console.log(`Credit-related text on ${page.url()}:`);
    for (const line of unique) {
      console.log(`  - ${line}`);
    }
  } else {
    console.log(`No credit-related text found on ${page.url()}.`);
  }
  return unique;
}

async function harvestClaimCandidates(page) {
  const found = await page
    .evaluate((pattern) => {
      const re = new RegExp(pattern, "i");
      const seen = new Set();
      const items = [];
      for (const el of document.querySelectorAll('a, button, [role="button"]')) {
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
        const rawHref = el.getAttribute("href") || "";
        if (!text && !rawHref) continue;
        if (!re.test(text) && !re.test(rawHref)) continue;
        const rect = el.getBoundingClientRect();
        const key = `${text}|${rawHref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          text,
          href: rawHref.slice(0, 140),
          visible: rect.width > 0 && rect.height > 0
        });
        if (items.length >= 25) break;
      }
      return items;
    }, CANDIDATE_PATTERN)
    .catch(() => []);

  if (found.length) {
    console.log(`Claim-like elements on ${page.url()}:`);
    for (const item of found) {
      console.log(`  - [${item.visible ? "v" : "h"}] "${item.text}" -> ${item.href || "(no href)"}`);
    }
  } else {
    console.log(`No claim-like elements found on ${page.url()}.`);
  }
  return found;
}

async function probeAlternateEntries(page, report) {
  const followUp = new RegExp(FOLLOWUP_TEXT_PATTERN);
  const avoid = new RegExp(AVOID_TEXT_PATTERN, "i");
  const urls = EXTRA_PROBE_URLS.filter((url) => url && url !== page.url());

  for (const url of urls) {
    if (report.clicked.length || report.claimedMarkers.length) break;

    console.log(`Probing entry page: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await settle(page);

    if (/login|passport|sso|signin/i.test(page.url())) {
      report.probed.push({ url, finalUrl: page.url(), note: "redirected to login" });
      console.log(`Probe bounced to login: ${page.url()}`);
      continue;
    }

    const candidates = await harvestClaimCandidates(page);
    const entry = pickClaimTarget(candidates, [STRONG_TEXT_PATTERN]);
    report.probed.push({
      url,
      finalUrl: page.url(),
      entry: entry ? entry.text : "",
      candidates: candidates.slice(0, 12)
    });

    if (!entry) {
      report.creditLines = await extractCreditLines(page);
      continue;
    }

    console.log(`Claim-like element found on ${page.url()}: "${entry.text}"`);
    await clickClaimControls(page, report, [entry.text]);

    if (report.clicked.length) {
      await settle(page);
      const inside = await harvestClaimCandidates(page);
      const target = inside.find(
        (item) => item.visible && item.text !== entry.text && followUp.test(item.text) && !avoid.test(item.text)
      );
      if (target && !report.clicked.includes(target.text)) {
        console.log(`Second-stage control after opening "${entry.text}": "${target.text}"`);
        await clickClaimControls(page, report, [target.text]);
        report.creditLines = await extractCreditLines(page);
      }
      report.probed.push({ url, finalUrl: page.url(), stage: "after entry click", candidates: inside.slice(0, 12) });
    }

    if (report.clicked.length) break;
  }

  return report;
}

// Try the patterns in order so a real claim button always wins over a task description.
function pickClaimTarget(candidates, patterns) {
  const avoid = new RegExp(AVOID_TEXT_PATTERN, "i");
  for (const pattern of patterns) {
    const re = new RegExp(pattern, "i");
    const hit = candidates.find((item) => item.visible && re.test(item.text) && !avoid.test(item.text));
    if (hit) return hit;
  }
  return null;
}

// The credit management page holds the balance and the task list, so it doubles as the
// verification step: reading it proves the session still works even when nothing is claimable.
async function openCreditPage(page, report) {
  const credit = { url: CREDIT_PAGE_URL, finalUrl: "", expanded: "", candidates: [], creditLines: [], clicked: [] };
  report.creditPage = credit;

  console.log(`Opening credit page: ${CREDIT_PAGE_URL}`);
  await page.goto(CREDIT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await settle(page);
  credit.finalUrl = page.url();

  if (/login|passport|sso|signin/i.test(credit.finalUrl)) {
    console.log(`Credit page bounced to login: ${credit.finalUrl}`);
    return report;
  }

  for (const text of EXPAND_TEXTS) {
    const locator = page.getByText(text, { exact: false }).first();
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ timeout: 5000 }).catch(() => {});
    credit.expanded = text;
    console.log(`Expanded the task list via: ${text}`);
    await page.waitForTimeout(2500);
    break;
  }

  credit.candidates = await harvestClaimCandidates(page);
  credit.creditLines = await extractCreditLines(page);
  await classifyClaimState(page, report);

  // The credit page also lists monthly streak tasks whose text contains "积分"; those are
  // awarded automatically, so only a real claim button is worth clicking here.
  const target = pickClaimTarget(credit.candidates, [STRONG_TEXT_PATTERN]);
  if (target) {
    const before = report.clicked.length;
    console.log(`Claim-like control on the credit page: "${target.text}"`);
    await clickClaimControls(page, report, [target.text]);
    if (report.clicked.length > before) {
      credit.clicked = report.clicked.slice(before);
    }
    credit.creditLines = await extractCreditLines(page);
    await classifyClaimState(page, report);
  } else {
    console.log("No claim-like control on the credit page.");
  }

  return report;
}

async function classifyClaimState(page, report) {
  const bodyText = (await page.locator("body").innerText({ timeout: 8000 }).catch(() => "")).slice(0, 20000);

  report.claimedMarkers = CLAIMED_MARKERS.filter((marker) => bodyText.includes(marker));

  if (report.clicked.length) {
    report.outcome = "clicked";
  } else if (report.claimedMarkers.length) {
    report.outcome = "already-claimed";
  } else {
    report.outcome = "unknown";
  }

  const balance = extractBalance(bodyText);
  if (balance) {
    report.balance = balance;
  }
  report.pageTitle = await page.title().catch(() => "");
  report.url = page.url();
  report.beijingTime = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false
  });
  return report;
}

function extractBalance(bodyText) {
  const patterns = [
    /剩余积分[\s:：]*([\d,]+(?:\.\d+)?)/,
    /([\d,]+(?:\.\d+)?)\s*积分即将过期/,
    /积分(?!剩余)[^\d%]{0,12}([\d,]+(?:\.\d+)?)(?!%)/,
    /([\d,]+(?:\.\d+)?)\s*积分/
  ];
  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) {
      return match[1].replace(/,/g, "");
    }
  }
  return null;
}

function notificationTitle(report) {
  const titles = {
    clicked: "Coze每日积分：已执行领取",
    "already-claimed": "Coze每日积分：今日已领取过",
    "no-entry": "Coze每日积分：未见领取入口（余额已读到）",
    unknown: "Coze每日积分：结果未知"
  };
  return titles[report.outcome] || `Coze每日积分：${report.outcome}`;
}

function buildSuccessMessage(report, cookieInfo = cookieExpiryInfo()) {
  const outcomeLabels = {
    clicked: "已尝试点击领取入口",
    "already-claimed": "页面显示今日已领取",
    "no-entry": "积分管理页可读，但今天没有可点的领取入口",
    unknown: "结果未知（未发现领取入口或已领取标记）"
  };
  const clicked = (report.clickDetails || []).map((item) => item.text);
  const tasks = (report.creditPage?.candidates || [])
    .filter((item) => item.visible && /积分|任务/.test(item.text))
    .slice(0, 4)
    .map((item) => item.text);
  return [
    `结果：${outcomeLabels[report.outcome] || report.outcome}`,
    clicked.length ? `点击：${clicked.join(" -> ")}` : "",
    report.claimedMarkers.length ? `已领取标记：${report.claimedMarkers.join("、")}` : "",
    report.balance ? `积分余额：${report.balance}` : "未识别到积分余额（仅供参考，不代表未领取）",
    tasks.length ? `积分页任务：${tasks.join(" / ")}` : "",
    report.creditPage?.finalUrl ? `积分页：${report.creditPage.finalUrl}` : "",
    report.creditLines?.length ? `页面积分文本：${report.creditLines.slice(0, 3).join(" / ")}` : "",
    cookieExpiryLine(cookieInfo),
    cookieInfo.daysLeft !== null && cookieInfo.daysLeft <= 2
      ? "提醒：登录态快到期了，提前重新登录并更新 COZE_COOKIES_JSON，否则明天开始就会漏领。"
      : "",
    `时间：${report.beijingTime}`,
    `页面：${report.pageTitle}`
  ].filter(Boolean).join("\n");
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 5000));
}

async function captureFailure(context, error) {
  const page = context?.pages()?.[0];
  if (!page) return;

  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(path.join(ARTIFACT_DIR, "failure.html"), html, "utf8").catch(() => {});
  }
  console.error(error);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
