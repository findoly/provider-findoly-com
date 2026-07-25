function notFound(req, res) {
  if (req.originalUrl.startsWith("/api")) {
    return res.status(404).json({
      success: false,
      code: "API_ROUTE_NOT_FOUND",
      message: "API route not found",
      requestId: req.requestId,
    });
  }
  return res.status(404).render("404", { title: "Page not found" });
}

function errorHandler(error, req, res, next) {
  const status = Math.min(
    599,
    Math.max(400, Number(error.status || error.statusCode || 500)),
  );
  const publicMessage =
    status >= 500 && process.env.NODE_ENV === "production"
      ? "Something went wrong"
      : error.message || "Something went wrong";

  console.error({
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    status,
    code: error.code,
    message: error.message,
    stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
  });

  if (res.headersSent) return next(error);

  if (req.originalUrl.startsWith("/api")) {
    return res.status(status).json({
      success: false,
      code: error.code || "REQUEST_FAILED",
      message: publicMessage,
      requestId: req.requestId,
    });
  }

  return res.status(status).render("error", {
    title: "Error",
    message: publicMessage,
    requestId: req.requestId,
  });
}

module.exports = { notFound, errorHandler };
