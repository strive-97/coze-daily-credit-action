import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { notifyFailure, notifyResult } from "./notifications.mjs";

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

async function main() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await materializeStorageState();

  const launchOptions = {
    headless: process.env.HEADLESS !== "false"
  };
  if (process.env.PLAYWRIGHT_CHANNEL) {
    launchOptions.channel = process.env.PLAYWRIGHT_CHANNEL;
  }

  const browser = await chromium.launch(launchOptions);

  let context;
  try {
    context = await browser.newContext({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      storageState: STORAGE_STATE_PATH
    });

    const page = await context.newPage();
    page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000));

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page);
    await assertLoggedIn(page);

    const report = await claimDaily(page);
    await settle(page);
    await assertLoggedIn(page);
    await classifyClaimState(page, report);

    await context.storageState({ path: UPDATED_STORAGE_STATE_PATH });

    console.log("Claim report:", JSON.stringify(report, null, 2));
    console.log(`Coze daily visit completed: ${targetUrl}`);
    console.log(`Updated storage state written to ${UPDATED_STORAGE_STATE_PATH}`);

    if (report.outcome === "unknown" && process.env.COZE_CLAIM_STRICT !== "0") {
      const unknownError = new Error(
        "签到结果未知：页面既没有可点击的领取入口，也没有“已领取/已签到”标记。" +
        "可能是 Coze 页面改版（选择器失效）或登录态异常。请下载本次运行的 coze-failure 截图/HTML 核对，" +
        "确认为误报后可在仓库变量把 COZE_CLAIM_STRICT 设为 0。"
      );
      await captureFailure(context, unknownError);
      throw unknownError;
    }

    if (process.env.COZE_NOTIFY_SUCCESS !== "0") {
      const notified = await notifyResult({
        title: report.outcome === "already-claimed" ? "Coze每日积分：今日已领取过" : "Coze每日积分：已执行",
        content: buildSuccessMessage(report)
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
      repository: process.env.GITHUB_REPOSITORY
    });
    if (notified) {
      await fs.writeFile(NOTIFICATION_SENT_PATH, new Date().toISOString(), "utf8").catch(() => {});
    }
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
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

  if (typeof cookie.expires === "number") {
    normalized.expires = cookie.expires;
  } else if (typeof cookie.expirationDate === "number") {
    normalized.expires = cookie.expirationDate;
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
    throw new Error(`Login appears expired; current URL is ${url}`);
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
    claimedMarkers: [],
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
    return report;
  }

  const configuredTexts = (process.env.COZE_CLICK_TEXTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const texts = configuredTexts.length ? configuredTexts : DEFAULT_CLICK_TEXTS;

  for (const text of texts) {
    const locator = page.getByText(text, { exact: false }).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    await locator.click({ timeout: 5000 }).catch(() => {});
    report.clicked.push(text);
    console.log(`Clicked possible claim control: ${text}`);
    await page.waitForTimeout(2000);

    for (const confirmText of CONFIRM_TEXTS) {
      const confirm = page.getByText(confirmText, { exact: false }).first();
      const confirmVisible = await confirm.isVisible().catch(() => false);
      if (!confirmVisible) continue;
      await confirm.click({ timeout: 5000 }).catch(() => {});
      report.clicked.push(confirmText);
      console.log(`Clicked follow-up control: ${confirmText}`);
      await page.waitForTimeout(2000);
      break;
    }
    break;
  }

  if (!report.clicked.length) {
    console.log("No claim-like control found on first pass.");
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
    /积分\D{0,12}([\d,]+(?:\.\d+)?)/,
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

function buildSuccessMessage(report) {
  const outcomeLabels = {
    clicked: "已尝试点击领取入口",
    "already-claimed": "页面显示今日已领取",
    unknown: "结果未知（未发现领取入口或已领取标记）"
  };
  return [
    `结果：${outcomeLabels[report.outcome] || report.outcome}`,
    report.clicked.length ? `点击：${report.clicked.join(" -> ")}` : "",
    report.claimedMarkers.length ? `已领取标记：${report.claimedMarkers.join("、")}` : "",
    report.balance ? `识别到积分余额：${report.balance}` : "未识别到积分余额（仅供参考，不代表未领取）",
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
