"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  actorId,
  actorType,
  morganCloudWatchStream,
  requestLoggingMiddleware,
  requestPath,
  responseBytes,
} = require("../middleware/request-logging");

function captureConsole(method, work) {
  const original = console[method];
  const calls = [];
  console[method] = (...args) => calls.push(args);
  try {
    work(calls);
  } finally {
    console[method] = original;
  }
  return calls;
}

test("request logging strips query strings and records provider actor details after completion", () => {
  const req = {
    requestId: "request-1",
    method: "GET",
    originalUrl: "/lead/enquiry-1?secret=value",
  };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = true;
  res.getHeader = (name) => name === "content-length" ? "42" : undefined;

  const calls = captureConsole("info", () => {
    requestLoggingMiddleware(req, res, () => {
      req.provider = { providerId: "provider-1" };
      res.emit("finish");
    });
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0].event, "http_request_started");
  assert.equal(calls[0][0].path, "/lead/enquiry-1");
  assert.equal(calls[1][0].event, "http_response_completed");
  assert.equal(calls[1][0].actorId, "provider-1");
  assert.equal(calls[1][0].actorType, "provider");
  assert.equal(calls[1][0].responseBytes, 42);
  assert.ok(Number.isFinite(calls[1][0].durationMs));
});

test("request logging records the safe internal CRM action actor without request bodies", () => {
  const req = {
    requestId: "request-2",
    method: "POST",
    originalUrl: "/api/internal/whatsapp/lead-unlock?token=must-not-log",
    internalActor: { type: "crm_whatsapp_action", providerId: "provider-2" },
    body: { providerWhatsapp: "9999999999" },
  };
  const res = new EventEmitter();
  res.statusCode = 401;
  res.writableEnded = true;
  res.getHeader = () => undefined;

  const calls = captureConsole("info", () => {
    requestLoggingMiddleware(req, res, () => res.emit("finish"));
  });
  const serialized = JSON.stringify(calls);
  assert.equal(calls[1][0].actorId, "provider-2");
  assert.equal(calls[1][0].actorType, "crm_whatsapp_action");
  assert.equal(calls[1][0].path, "/api/internal/whatsapp/lead-unlock");
  assert.doesNotMatch(serialized, /9999999999|must-not-log/);
});

test("request logging helpers and Morgan stream keep structured logging deterministic", () => {
  assert.equal(requestPath({ url: "/wallet?cursor=abc" }), "/wallet");
  assert.equal(actorId({ internalActor: { providerId: "provider-3" } }), "provider-3");
  assert.equal(actorType({ internalActor: { type: "crm_whatsapp_action" } }), "crm_whatsapp_action");
  assert.equal(responseBytes({ getHeader: () => "invalid" }), null);

  const calls = captureConsole("info", () => {
    morganCloudWatchStream().write("GET / 200\n");
  });
  assert.deepEqual(calls, [["GET / 200"]]);
});
