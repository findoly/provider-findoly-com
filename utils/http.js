async function fetchJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } catch (error) {
    if (error.name === "AbortError") {
      throw Object.assign(new Error("External service timed out"), {
        status: 504,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchJson };
