import {
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
} from "openai";
import { describe, expect, it } from "vitest";
import { ProviderNotConfiguredError, classifyProviderError, getOpenAI } from "./openai/client.js";

// Mocked provider errors (no network). Constructed the way the SDK builds them.
const headers = new Headers({ "x-request-id": "req_abc" });

describe("classifyProviderError", () => {
  it("maps a missing model to model_unavailable with the model name", () => {
    const err = new NotFoundError(404, { message: "The model does not exist" }, "The model does not exist", headers);
    const c = classifyProviderError(err, { model: "gpt-5.6-luna" });
    expect(c.code).toBe("model_unavailable");
    expect(c.message).toContain("gpt-5.6-luna");
    expect(c.requestId).toBe("req_abc");
  });

  it("never retries a timed-out request and flags the outcome as unknown", () => {
    const c = classifyProviderError(new APIConnectionTimeoutError());
    expect(c.code).toBe("timeout");
    expect(c.safeToRetry).toBe(false);
    expect(c.outcomeUnknown).toBe(true);
  });

  it("distinguishes quota exhaustion from rate limiting", () => {
    const quota = new RateLimitError(429, { code: "insufficient_quota", message: "quota" }, "You exceeded your current quota", headers);
    expect(classifyProviderError(quota).code).toBe("quota_exceeded");
    const rate = new RateLimitError(429, { message: "slow down" }, "Rate limit reached", headers);
    expect(classifyProviderError(rate)).toMatchObject({ code: "rate_limited", safeToRetry: true });
  });

  it("maps auth, invalid parameters, safety refusals, and server errors", () => {
    expect(classifyProviderError(new AuthenticationError(401, {}, "bad key", headers)).code).toBe("auth");
    const bad = new BadRequestError(400, { param: "size" }, "Invalid size", headers);
    expect(classifyProviderError(bad).code).toBe("invalid_request");
    const policy = new BadRequestError(400, { code: "content_policy_violation" }, "rejected by safety system", headers);
    expect(classifyProviderError(policy).code).toBe("content_policy");
    expect(classifyProviderError(new InternalServerError(500, {}, "oops", headers))).toMatchObject({ code: "server", outcomeUnknown: true });
  });

  it("reports a missing key as a setup state, never as a fake result", () => {
    expect(() => getOpenAI(undefined)).toThrow(ProviderNotConfiguredError);
    expect(classifyProviderError(new ProviderNotConfiguredError()).code).toBe("not_configured");
  });
});
