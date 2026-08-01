#!/usr/bin/env node
"use strict";

require("dotenv").config();

const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { loadAwsSecrets } = require("../config/load-aws-secrets");
const { createCloudWatchLogger } = require("../services/logging/cloudwatch-logger");

const cloudwatchLogger = createCloudWatchLogger({
  service: "provider-maintenance",
  credentialPrefix: "PROVIDER_SECRETS_",
  defaultLogGroup: "/findoly/provider/production",
});
cloudwatchLogger.install();

function resolveTarget(argument) {
  const target = String(argument || "").trim();
  if (!target) {
    throw new Error(
      "Usage: node scripts/run-with-runtime.js <script-path> [arguments...]",
    );
  }

  const root = path.resolve(__dirname, "..");
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Runtime script must be inside the provider portal project");
  }

  return resolved;
}

function forwardChildStream(stream, output, level, source) {
  if (!stream || typeof stream.on !== "function") return;
  const decoder = new StringDecoder("utf8");
  let pending = "";

  const captureLines = (text, flush = false) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = flush ? "" : lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) cloudwatchLogger.capture(level, [line], { source });
    }
    if (flush && pending.trim()) {
      cloudwatchLogger.capture(level, [pending], { source });
      pending = "";
    }
  };

  stream.on("data", (chunk) => {
    output.write(chunk);
    captureLines(decoder.write(chunk));
  });
  stream.on("end", () => captureLines(decoder.end(), true));
}

async function run({
  argv = process.argv.slice(2),
  loadSecrets = loadAwsSecrets,
  spawnImpl = spawn,
} = {}) {
  const [targetArgument, ...scriptArguments] = argv;
  const target = resolveTarget(targetArgument);
  const secretResult = await loadSecrets();
  cloudwatchLogger.configureFromEnv();

  if (!secretResult.skipped) {
    console.log(
      `Provider configuration loaded from AWS Secrets Manager (${secretResult.loaded} values)`,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [target, ...scriptArguments], {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    forwardChildStream(child.stdout, process.stdout, "info", "maintenance-stdout");
    forwardChildStream(child.stderr, process.stderr, "error", "maintenance-stderr");

    child.once("error", reject);
    child.once("exit", async (code, signal) => {
      await cloudwatchLogger.flush({ timeoutMs: 2000 });
      if (signal) {
        reject(new Error(`Runtime script terminated by signal ${signal}`));
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

if (require.main === module) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
      await cloudwatchLogger.flush({ timeoutMs: 2000 });
    });
}

module.exports = { cloudwatchLogger, forwardChildStream, resolveTarget, run };
