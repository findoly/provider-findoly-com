"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  applySecretValues,
  buildSignedRequest,
  loadAwsSecrets,
  parseSecretPayload,
  requiredBootstrapConfig,
} = require("../config/load-aws-secrets");

function bootstrapEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    PORT: "3100",
    PROVIDER_SECRETS_REGION: "ap-south-1",
    PROVIDER_SECRETS_SECRET_ID: "findoly/provider/production",
    PROVIDER_SECRETS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    PROVIDER_SECRETS_SECRET_ACCESS_KEY: "example-secret-access-key",
    ...overrides,
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("signed request targets AWS Secrets Manager without exposing credentials", () => {
  const request = buildSignedRequest({
    region: "ap-south-1",
    secretId: "findoly/provider/production",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "example-secret-access-key",
    now: new Date("2026-08-01T04:30:00.000Z"),
  });

  assert.equal(
    request.endpoint,
    "https://secretsmanager.ap-south-1.amazonaws.com/",
  );
  assert.equal(request.body, '{"SecretId":"findoly/provider/production"}');
  assert.equal(
    request.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260801/ap-south-1/secretsmanager/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target, Signature=20c9149af81467ceae100d60979262540a70556f2ff7439c5389661bb7d398b3",
  );
  assert.match(
    request.headers.authorization,
    /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target/,
  );
  assert.doesNotMatch(request.body, /example-secret-access-key/);
});

test("secret values overwrite app env while Hostinger bootstrap values stay protected", () => {
  const env = bootstrapEnv({ MONGODB_URI: "old-value" });
  const result = applySecretValues(
    {
      MONGODB_URI: "mongodb://new-value",
      JWT_SECRET: "x".repeat(40),
      MONGO_MAX_POOL_SIZE: 30,
      RAZORPAY_REVIEW_LOGIN_ENABLED: false,
      NODE_ENV: "development",
      PORT: 9999,
      PROVIDER_SECRETS_REGION: "us-east-1",
    },
    env,
  );

  assert.equal(env.MONGODB_URI, "mongodb://new-value");
  assert.equal(env.JWT_SECRET, "x".repeat(40));
  assert.equal(env.MONGO_MAX_POOL_SIZE, "30");
  assert.equal(env.RAZORPAY_REVIEW_LOGIN_ENABLED, "false");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.PORT, "3100");
  assert.equal(env.PROVIDER_SECRETS_REGION, "ap-south-1");
  assert.deepEqual(result, { loaded: 4, protectedCount: 3 });
});

test("loader fetches one JSON secret and applies it before startup", async () => {
  const env = bootstrapEnv();
  let fetchCall;
  const result = await loadAwsSecrets({
    env,
    now: () => new Date("2026-08-01T04:30:00.000Z"),
    fetchImpl: async (url, options) => {
      fetchCall = { url, options };
      return response(200, {
        SecretString: JSON.stringify({
          MONGODB_URI: "mongodb://findoly-provider",
          JWT_SECRET: "s".repeat(40),
          APP_NAME: "Findoly Provider",
        }),
      });
    },
  });

  assert.equal(
    fetchCall.url,
    "https://secretsmanager.ap-south-1.amazonaws.com/",
  );
  assert.equal(fetchCall.options.method, "POST");
  assert.equal(
    fetchCall.options.headers["x-amz-target"],
    "secretsmanager.GetSecretValue",
  );
  assert.equal(env.MONGODB_URI, "mongodb://findoly-provider");
  assert.equal(env.JWT_SECRET, "s".repeat(40));
  assert.equal(result.loaded, 3);
  assert.equal(result.skipped, false);
});

test("development can use local dotenv values when no provider secret is configured", async () => {
  const env = { NODE_ENV: "development", MONGODB_URI: "mongodb://local" };
  const result = await loadAwsSecrets({
    env,
    fetchImpl: async () => assert.fail("must not fetch"),
  });

  assert.deepEqual(result, { loaded: 0, protectedCount: 0, skipped: true });
  assert.equal(env.MONGODB_URI, "mongodb://local");
});

test("production requires the provider secret identifier", () => {
  assert.throws(
    () => requiredBootstrapConfig({ NODE_ENV: "production" }),
    /PROVIDER_SECRETS_SECRET_ID is required in production/,
  );
});

test("invalid secret values fail atomically without partial env changes", () => {
  assert.throws(
    () => parseSecretPayload({ SecretString: "not-json" }),
    /must contain valid JSON/,
  );

  const env = { MONGODB_URI: "mongodb://original" };
  assert.throws(
    () =>
      applySecretValues(
        {
          MONGODB_URI: "mongodb://new",
          INVALID_NESTED_VALUE: { value: "not-supported" },
        },
        env,
      ),
    /must be a string, number, or boolean/,
  );
  assert.equal(env.MONGODB_URI, "mongodb://original");
  assert.equal(env.INVALID_NESTED_VALUE, undefined);
});

test("AWS access failures stop startup without applying configuration", async () => {
  const env = bootstrapEnv();
  await assert.rejects(
    loadAwsSecrets({
      env,
      fetchImpl: async () =>
        response(403, {
          __type: "AccessDeniedException",
          message: "User is not authorised",
        }),
    }),
    /AccessDeniedException.*not authorised/,
  );
  assert.equal(env.MONGODB_URI, undefined);
});

test("provider server listens first, then loads secrets, app and database", async () => {
  const { start } = require("../bin/www");
  const events = [];
  const app = Object.assign(() => {}, { set() {} });
  const fakeServer = new EventEmitter();
  fakeServer.listening = false;
  fakeServer.listen = (_port, callback) => {
    events.push("listen");
    fakeServer.listening = true;
    callback();
  };
  fakeServer.close = (callback) => {
    events.push("close");
    fakeServer.listening = false;
    callback();
  };

  let releaseSecrets;
  const secretsReady = new Promise((resolve) => {
    releaseSecrets = resolve;
  });

  const startupPromise = start({
    loadSecrets: async () => {
      events.push("secrets");
      await secretsReady;
      return { loaded: 2, protectedCount: 0, skipped: false };
    },
    loadEnvironment: () => ({
      validateEnvironment() {
        events.push("validate");
      },
    }),
    loadDatabase: () => async () => {
      events.push("database");
    },
    loadApp: () => {
      events.push("app");
      return app;
    },
    loadMongoose: () => ({ connection: { readyState: 0 } }),
    httpModule: { createServer: () => fakeServer },
  });

  assert.deepEqual(events, ["listen"]);
  await Promise.resolve();
  assert.deepEqual(events, ["listen", "secrets"]);
  releaseSecrets();
  await startupPromise;

  assert.deepEqual(events, [
    "listen",
    "secrets",
    "validate",
    "app",
    "database",
  ]);
});

test("temporary startup handler returns a non-cacheable 503 response", () => {
  const { startupRequestHandler } = require("../bin/www");
  const headers = {};
  let body = "";
  const response = {
    statusCode: 0,
    setHeader(name, value) {
      headers[name] = value;
    },
    end(value = "") {
      body = value;
    },
  };

  startupRequestHandler({ method: "GET" }, response);

  assert.equal(response.statusCode, 503);
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["retry-after"], "5");
  assert.equal(JSON.parse(body).error.code, "SERVICE_STARTING");
});

test("secret or database failure closes the bootstrap listener", async () => {
  const { start } = require("../bin/www");
  let appLoaded = false;
  let listenCalled = false;
  let closeCalled = false;

  function createFakeServer() {
    const fakeServer = new EventEmitter();
    fakeServer.listening = false;
    fakeServer.listen = (_port, callback) => {
      listenCalled = true;
      fakeServer.listening = true;
      callback();
    };
    fakeServer.close = (callback) => {
      closeCalled = true;
      fakeServer.listening = false;
      callback();
    };
    return fakeServer;
  }

  await assert.rejects(
    start({
      loadSecrets: async () => {
        throw new Error("secret unavailable");
      },
      loadApp: () => {
        appLoaded = true;
      },
      httpModule: { createServer: createFakeServer },
    }),
    /secret unavailable/,
  );
  assert.equal(listenCalled, true);
  assert.equal(closeCalled, true);
  assert.equal(appLoaded, false);

  listenCalled = false;
  closeCalled = false;

  await assert.rejects(
    start({
      loadSecrets: async () => ({
        loaded: 0,
        protectedCount: 0,
        skipped: true,
      }),
      loadEnvironment: () => ({ validateEnvironment() {} }),
      loadDatabase: () => async () => {
        throw new Error("database unavailable");
      },
      loadApp: () => Object.assign(() => {}, { set() {} }),
      loadMongoose: () => ({ connection: { readyState: 0 } }),
      httpModule: { createServer: createFakeServer },
    }),
    /database unavailable/,
  );
  assert.equal(listenCalled, true);
  assert.equal(closeCalled, true);
});

test("port binding failures reject provider startup", async () => {
  const { start } = require("../bin/www");
  const fakeServer = new EventEmitter();
  fakeServer.listen = () =>
    queueMicrotask(() => fakeServer.emit("error", new Error("address in use")));

  await assert.rejects(
    start({
      loadSecrets: async () => ({
        loaded: 0,
        protectedCount: 0,
        skipped: true,
      }),
      loadEnvironment: () => ({ validateEnvironment() {} }),
      loadDatabase: () => async () => {},
      loadApp: () => ({ set() {} }),
      loadMongoose: () => ({ connection: { readyState: 0 } }),
      httpModule: { createServer: () => fakeServer },
    }),
    /address in use/,
  );
});

test("Express Generator entrypoint structure and runtime scripts are preserved", () => {
  const root = path.join(__dirname, "..");
  const startSource = fs.readFileSync(path.join(root, "start.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "bin", "www"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );

  assert.match(startSource, /require\(["']\.\/bin\/www["']\)\.run\(\)/);
  assert.match(serverSource, /require\(["']dotenv["']\)\.config\(\)/);
  assert.match(serverSource, /await loadSecrets\(\)/);
  assert.doesNotMatch(serverSource, /require\.main/);
  assert.doesNotMatch(serverSource, /^const app = require\(["']\.\.\/app["']\)/m);
  assert.doesNotMatch(appSource, /require\(["']dotenv["']\)/);
  assert.equal(packageJson.scripts.start, "node ./start.js");
  assert.equal(packageJson.scripts.dev, "nodemon ./start.js");

  for (const name of [
    "diagnose:provider",
    "ensure:indexes",
    "cleanup:lead-reservations",
  ]) {
    assert.match(
      packageJson.scripts[name],
      /^node scripts\/run-with-runtime\.js scripts\//,
    );
  }
});

test("maintenance runtime wrapper loads secrets before spawning its target", async () => {
  const { run } = require("../scripts/run-with-runtime");
  const events = [];
  const child = new EventEmitter();

  const resultPromise = run({
    argv: ["scripts/ensure-indexes.js"],
    loadSecrets: async () => {
      events.push("secrets");
      return { loaded: 2, protectedCount: 0, skipped: false };
    },
    spawnImpl: () => {
      events.push("spawn");
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.equal(await resultPromise, 0);
  assert.deepEqual(events, ["secrets", "spawn"]);
});
