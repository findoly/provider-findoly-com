async function fetchJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let requestStarted = false;

  try {
    requestStarted = true;
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        ...(options.headers || {}),
      },
    });
    const rawBody = await response.text().catch(() => "");
    let body = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch (_error) {
        body = { message: rawBody.slice(0, 1000) };
      }
    }
    return { response, body, rawBody };
  } catch (error) {
    if (error.name === "AbortError") {
      throw Object.assign(new Error("External service timed out"), {
        status: 504,
        requestMayHaveSucceeded: requestStarted,
      });
    }
    throw Object.assign(error, {
      requestMayHaveSucceeded: requestStarted,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchJson };
