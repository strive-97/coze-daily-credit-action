// Cookie health helpers, kept free of Playwright imports so they can be unit tested directly.
// They only look at the secret payload that the workflow injects, never at the browser.

// Cookie names that actually carry the Coze / Volcengine login. When the earliest of these
// expires, the daily run stops being able to do anything, so the script reports it in advance.
export const AUTH_COOKIE_PATTERN = /^(sessionid|sid_tt|sid_guard|sid_ucp|uid_tt|ttwid|passport_)/i;

export function readSecretCookies(env = process.env) {
  const raw = (env.COZE_STORAGE_STATE_JSON || env.COZE_COOKIES_JSON || "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
  return Array.isArray(list) ? list.filter((cookie) => cookie && cookie.name && cookie.value) : [];
}

export function cookieExpiryInfo(env = process.env) {
  const nowSeconds = Date.now() / 1000;
  const expiryOf = (cookie) => Number(cookie.expires ?? cookie.expirationDate);
  const cookies = readSecretCookies(env);
  const authCookies = cookies.filter((cookie) => AUTH_COOKIE_PATTERN.test(cookie.name));
  const dated = authCookies
    .filter((cookie) => Number.isFinite(expiryOf(cookie)) && expiryOf(cookie) > 0)
    .sort((a, b) => expiryOf(a) - expiryOf(b));
  const sessionOnly = authCookies
    .filter((cookie) => !(Number.isFinite(expiryOf(cookie)) && expiryOf(cookie) > 0))
    .map((cookie) => cookie.name);
  const first = dated[0] || null;
  return {
    total: cookies.length,
    authCount: authCookies.length,
    sessionOnly,
    name: first ? first.name : "",
    date: first ? new Date(expiryOf(first) * 1000).toISOString().slice(0, 10) : "",
    daysLeft: first ? Math.round((expiryOf(first) - nowSeconds) / 86400) : null
  };
}

export function cookieExpiryLine(info) {
  if (!info.total) return "Cookie：Secret 里读不到任何 Cookie";
  if (!info.authCount) {
    return `Cookie：共 ${info.total} 条，但没有识别到登录条目（sessionid / sid_tt / sid_guard 之类）`;
  }
  if (info.daysLeft === null) {
    return (
      `Cookie：共 ${info.total} 条，登录条目 ${info.authCount} 条均为会话级（无固定到期日，` +
      `由服务端决定何时作废，随时可能掉登录）`
    );
  }
  const state = info.daysLeft <= 0 ? `已过期 ${-info.daysLeft} 天` : `还剩约 ${info.daysLeft} 天`;
  return `Cookie：共 ${info.total} 条，最早过期的登录条目 ${info.name} 在 ${info.date}（${state}）`;
}

export function cookieRenewalHint(error, info) {
  if (!/Login appears expired|signin|passport/i.test(String(error?.message || ""))) return "";
  const detail = !info || !info.authCount
    ? ""
    : info.daysLeft === null
      ? `（当前 Cookie 里的登录条目 ${info.sessionOnly.slice(0, 3).join("、")} 都是会话级，服务端已经把它们作废了）`
      : `（当前 Cookie 最早到期记录：${info.name} ${info.date}，` +
        `${info.daysLeft <= 0 ? `已过期 ${-info.daysLeft} 天` : "理论上还没到期，说明是服务端提前注销了登录态"}）`;
  return (
    "处理办法：在浏览器重新登录 https://www.coze.cn ，用 Cookie-Editor 导出 JSON，" +
    `覆盖 GitHub Secret COZE_COOKIES_JSON，再手动 Run workflow 验证一次。${detail}`
  );
}
