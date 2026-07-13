/**
 * Minimal operator UI for runtime Langdock + Masumi configuration.
 *
 * Credentials submitted here are saved to .env and applied to the running
 * process. Configure SETUP_USERNAME plus SETUP_PASSWORD_HASH or SETUP_PASSWORD
 * before exposing this app beyond localhost.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentProfileConfig,
  InputSchemaField,
  MasumiNetwork,
  PaymentApiAuthHeader,
  PaymentMode,
  PriceAmount,
} from "../config.js";
import { findAgentProfile, loadConfig, normalizeAgentSlug } from "../config.js";
import type { BridgeContext } from "./bridgeContext.js";
import { createLangdockStartJobHandler } from "../services/langdockStartJob.js";
import {
  completeChat,
  extractAssistantContent,
  LangdockApiError,
} from "../services/langdock.js";
import {
  MasumiPaymentClient,
  MasumiPaymentError,
  type RegistryAgent,
  type RegistryExampleOutput,
} from "../services/masumiPayment.js";
import { getReadinessReport } from "../services/readiness.js";
import {
  adminCredentialsConfigured,
  loginAdmin,
  logoutUser,
  verifyAdminCredentials,
  verifyToken,
  type AuthenticatedUser,
} from "../services/auth.js";
import { constantTimeEqual } from "../services/opaqueTokens.js";
import { checkRateLimit } from "../services/rateLimit.js";
import { loginHtml } from "./loginHtml.js";
import { MAINNET_USDCX_UNIT, PREPROD_TUSDM_UNIT } from "../services/sokosumiTokens.js";

type SetupConfigBody = {
  langdockBaseUrl?: unknown;
  langdockApiKey?: unknown;
  langdockAgentId?: unknown;
  paymentMode?: unknown;
  paymentServiceUrl?: unknown;
  paymentApiKey?: unknown;
  paymentApiAuthHeader?: unknown;
  network?: unknown;
  agentIdentifier?: unknown;
  sellerVKey?: unknown;
  priceAmounts?: unknown;
};

type LangdockTestBody = {
  prompt?: unknown;
};

type RegistrySetupBody = {
  agentSlug?: unknown;
  langdockAgentId?: unknown;
  agentName?: unknown;
  agentDescription?: unknown;
  agentApiBaseUrl?: unknown;
  capabilityName?: unknown;
  capabilityVersion?: unknown;
  authorName?: unknown;
  authorContactEmail?: unknown;
  authorContactOther?: unknown;
  authorOrganization?: unknown;
  tags?: unknown;
  pricing?: unknown;
  pricingAmount?: unknown;
  pricingUnit?: unknown;
  exampleOutputs?: unknown;
  legalPrivacyPolicy?: unknown;
  legalTerms?: unknown;
  legalOther?: unknown;
};

type EnvPatch = {
  updates: Map<string, string>;
  deletes: Set<string>;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizePaymentMode(value: unknown): PaymentMode | undefined {
  const raw = str(value)?.toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "direct" || raw === "masumi") return raw;
  throw new Error("PAYMENT_MODE must be direct or masumi.");
}

function normalizeNetwork(value: unknown): MasumiNetwork | undefined {
  const raw = str(value);
  if (raw === undefined || raw === "") return undefined;
  if (raw === "Preprod" || raw === "Mainnet") return raw;
  throw new Error("NETWORK must be exactly Preprod or Mainnet.");
}

function normalizeAuthHeader(
  value: unknown,
): PaymentApiAuthHeader | undefined {
  const raw = str(value);
  if (raw === undefined || raw === "") return undefined;
  if (raw === "token" || raw === "x-api-key") return raw;
  throw new Error("PAYMENT_API_AUTH_HEADER must be token or x-api-key.");
}

function normalizeJsonEnv(value: unknown, envName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return JSON.stringify(value);
  const raw = str(value);
  if (raw === undefined || raw === "") return undefined;
  try {
    JSON.parse(raw) as unknown;
    return raw;
  } catch {
    throw new Error(`${envName} must be valid JSON.`);
  }
}

function normalizeRegistryExampleOutputs(
  value: unknown,
): RegistryExampleOutput[] | undefined {
  if (value === undefined || value === null) return undefined;

  const raw = str(value);
  if (raw !== undefined && raw === "") return undefined;

  let parsed: unknown;
  if (Array.isArray(value)) {
    parsed = value;
  } else if (raw !== undefined) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(
        "Example outputs must be valid JSON array of {name, url, mimeType}.",
      );
    }
  } else {
    throw new Error(
      "Example outputs must be valid JSON array of {name, url, mimeType}.",
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      "Example outputs must be a JSON array of {name, url, mimeType}.",
    );
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Example output ${index + 1} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const name = str(record.name);
    const url = str(record.url);
    const mimeType = str(record.mimeType);
    if (!name || !url || !mimeType) {
      throw new Error(
        `Example output ${index + 1} requires name, url, and mimeType.`,
      );
    }
    return { name, url, mimeType };
  });
}

function normalizeRegistryPricing(
  pricingValue: unknown,
  pricingAmountValue: unknown,
  pricingUnitValue: unknown,
  network: MasumiNetwork,
): PriceAmount[] {
  const rawPricing = str(pricingValue);
  if (
    Array.isArray(pricingValue) ||
    (rawPricing !== undefined && rawPricing !== "")
  ) {
    let parsed: unknown;
    if (Array.isArray(pricingValue)) {
      parsed = pricingValue;
    } else {
      try {
        parsed = JSON.parse(rawPricing ?? "[]") as unknown;
      } catch {
        throw new Error("Pricing must be valid JSON array of {amount, unit}.");
      }
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Pricing must include at least one {amount, unit} row.");
    }

    return parsed.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Pricing row ${index + 1} must be an object.`);
      }
      const record = item as Record<string, unknown>;
      const amount = str(record.amount);
      const unit = str(record.unit);
      if (!amount || !/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
        throw new Error(
          `Pricing row ${index + 1} amount must be a positive integer raw token amount.`,
        );
      }
      if (unit === undefined) {
        throw new Error(`Pricing row ${index + 1} unit must be a string.`);
      }
      return { amount, unit };
    });
  }

  const pricingAmount = requireString(pricingAmountValue, "Price amount");
  if (!/^[0-9]+$/.test(pricingAmount) || BigInt(pricingAmount) <= 0n) {
    throw new Error("Price amount must be a positive integer raw token amount.");
  }
  return [
    {
      amount: pricingAmount,
      unit: str(pricingUnitValue) || defaultPricingUnit(network),
    },
  ];
}

function splitCsv(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return (str(value) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireString(value: unknown, label: string): string {
  const normalized = str(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function defaultPricingUnit(network: MasumiNetwork): string {
  return network === "Mainnet" ? MAINNET_USDCX_UNIT : PREPROD_TUSDM_UNIT;
}

function configuredPaymentClient(): MasumiPaymentClient {
  const config = loadConfig();
  return new MasumiPaymentClient({
    baseUrl: config.paymentServiceUrl,
    apiKey: config.paymentApiKey,
    authHeader: config.paymentApiAuthHeader,
    network: config.masumiNetwork,
  });
}

function setupEnvPath(): string {
  return path.resolve(process.env.SETUP_ENV_PATH || path.join(process.cwd(), ".env"));
}

function setPatchValue(
  patch: EnvPatch,
  envName: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  if (value === "") return;
  patch.deletes.delete(envName);
  patch.updates.set(envName, value);
}

function setOptionalPatchValue(
  patch: EnvPatch,
  envName: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  if (value === "") {
    patch.updates.delete(envName);
    patch.deletes.add(envName);
    return;
  }
  patch.deletes.delete(envName);
  patch.updates.set(envName, value);
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}

async function persistEnvPatch(patch: EnvPatch): Promise<void> {
  const envPath = setupEnvPath();
  let raw = "";
  try {
    raw = await readFile(envPath, "utf8");
  } catch (e) {
    if (!isNotFoundError(e)) throw e;
  }

  const seen = new Set<string>();
  const lines = raw ? raw.split(/\r?\n/) : [];
  const output: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      output.push(line);
      continue;
    }

    const key = match[1]!;
    if (patch.deletes.has(key)) {
      seen.add(key);
      continue;
    }
    if (patch.updates.has(key)) {
      seen.add(key);
      output.push(`${key}=${quoteEnvValue(patch.updates.get(key)!)}`);
      continue;
    }
    output.push(line);
  }

  for (const [key, value] of patch.updates) {
    if (!seen.has(key)) output.push(`${key}=${quoteEnvValue(value)}`);
  }

  while (output.length > 1 && output[output.length - 1] === "") {
    output.pop();
  }

  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(envPath, `${output.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(envPath, 0o600);
}

function applyEnvPatch(patch: EnvPatch): void {
  for (const key of patch.deletes) {
    delete process.env[key];
  }
  for (const [key, value] of patch.updates) {
    process.env[key] = value;
  }
}

function tokenFromRequest(request: FastifyRequest): string {
  const headerToken = request.headers["x-setup-token"];
  if (typeof headerToken === "string") return headerToken;

  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return "";
}

function basicCredentialsFromRequest(request: FastifyRequest): {
  username: string;
  password: string;
} | undefined {
  const headerUsername = request.headers["x-setup-username"];
  const headerPassword = request.headers["x-setup-password"];
  if (typeof headerUsername === "string" && typeof headerPassword === "string") {
    return { username: headerUsername, password: headerPassword };
  }

  const auth = request.headers.authorization;
  if (!auth?.startsWith("Basic ")) return undefined;
  try {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function setupAccessConfigured(): boolean {
  return Boolean(
    process.env.SETUP_ACCESS_TOKEN?.trim() ||
      adminCredentialsConfigured(),
  );
}

async function requestCanConfigure(request: FastifyRequest): Promise<boolean> {
  const expectedToken = process.env.SETUP_ACCESS_TOKEN?.trim();
  if (expectedToken && constantTimeEqual(tokenFromRequest(request), expectedToken)) {
    return true;
  }

  const credentials = basicCredentialsFromRequest(request);
  if (credentials && await verifyAdminCredentials(credentials.username, credentials.password)) {
    return true;
  }

  return false;
}

function clientIdentifier(request: FastifyRequest, suffix = ""): string {
  return suffix ? `${request.ip}:${suffix}` : request.ip;
}

function applyRateLimit(
  reply: import("fastify").FastifyReply,
  scope: string,
  identifier: string,
  limit: number,
  windowMs: number,
): boolean {
  const result = checkRateLimit({ scope, identifier, limit, windowMs });
  reply.header("x-ratelimit-limit", String(result.limit));
  reply.header("x-ratelimit-remaining", String(result.remaining));
  reply.header("x-ratelimit-reset", String(Math.ceil(result.resetAt / 1000)));

  if (result.allowed) return true;

  reply.header("retry-after", String(result.retryAfterSeconds));
  void reply.status(429).send({
    error: "RATE_LIMITED",
    message: "Too many requests. Try again later.",
  });
  return false;
}

function requestOriginAllowed(request: FastifyRequest): boolean {
  const secFetchSite = request.headers["sec-fetch-site"];
  if (secFetchSite === "cross-site") return false;

  const origin = request.headers.origin;
  if (!origin) return true;

  const host = request.headers.host;
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function rejectCrossOriginPost(
  request: FastifyRequest,
  reply: import("fastify").FastifyReply,
): boolean {
  if (requestOriginAllowed(request)) return false;
  void reply.status(403).send({
    error: "INVALID_ORIGIN",
    message: "Cross-origin state-changing requests are not allowed.",
  });
  return true;
}

function redactConfigState(): Record<string, unknown> {
  const config = loadConfig();
  const report = getReadinessReport(config);
  return {
    ready: report.status === "ready",
    report,
    networkDetails: report.networkDetails,
    setupAccessRequired: setupAccessConfigured(),
    accessMethods: {
      hash: Boolean(process.env.SETUP_ACCESS_TOKEN?.trim()),
      password: adminCredentialsConfigured(),
    },
    configured: {
      langdockBaseUrl: config.langdockBaseUrl,
      langdockApiKey: config.langdockApiKey.length > 0,
      langdockAgentId: config.langdockAgentId.length > 0,
      agentsCount: config.agents.length,
      paymentMode: config.paymentMode,
      paymentServiceUrl: config.paymentServiceUrl,
      paymentApiKey: config.paymentApiKey.length > 0,
      paymentApiAuthHeader: config.paymentApiAuthHeader,
      network: config.masumiNetwork,
      agentIdentifier: config.agentIdentifier.length > 0,
      sellerVKey: config.sellerVKey.length > 0,
      priceAmountsCount: config.priceAmounts.length,
      setupEnvPath: setupEnvPath(),
    },
    agents: config.agents.map((agent) => ({
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      apiBaseUrl: agent.apiBaseUrl,
      langdockAgentId: agent.langdockAgentId,
      agentIdentifier: Boolean(agent.agentIdentifier),
      priceAmountsCount: agent.priceAmounts.length,
    })),
    registry: {
      agentApiBaseUrl: process.env.REGISTRY_AGENT_API_BASE_URL ?? "",
      agentName: process.env.REGISTRY_AGENT_NAME ?? "",
      agentDescription: process.env.REGISTRY_AGENT_DESCRIPTION ?? "",
      capabilityName: process.env.REGISTRY_CAPABILITY_NAME ?? "",
      capabilityVersion: process.env.REGISTRY_CAPABILITY_VERSION ?? "",
      authorName: process.env.REGISTRY_AUTHOR_NAME ?? "",
      authorContactEmail: process.env.REGISTRY_AUTHOR_CONTACT_EMAIL ?? "",
      authorContactOther: process.env.REGISTRY_AUTHOR_CONTACT_OTHER ?? "",
      authorOrganization: process.env.REGISTRY_AUTHOR_ORGANIZATION ?? "",
      tags: process.env.REGISTRY_TAGS ?? "",
      pricingAmount: process.env.REGISTRY_PRICING_AMOUNT ?? "",
      pricingUnit: process.env.REGISTRY_PRICING_UNIT ?? "",
      exampleOutputs: process.env.REGISTRY_EXAMPLE_OUTPUTS ?? "",
      legalPrivacyPolicy: process.env.REGISTRY_LEGAL_PRIVACY_POLICY ?? "",
      legalTerms: process.env.REGISTRY_LEGAL_TERMS ?? "",
      legalOther: process.env.REGISTRY_LEGAL_OTHER ?? "",
    },
  };
}

function buildEnvPatch(body: SetupConfigBody): EnvPatch {
  const paymentMode = normalizePaymentMode(body.paymentMode);
  const network = normalizeNetwork(body.network);
  const rawAuthHeader = str(body.paymentApiAuthHeader);
  const authHeader = normalizeAuthHeader(body.paymentApiAuthHeader);
  const rawPriceAmounts = str(body.priceAmounts);
  const priceAmounts = normalizeJsonEnv(body.priceAmounts, "PRICE_AMOUNTS");
  const patch: EnvPatch = { updates: new Map(), deletes: new Set() };

  setPatchValue(patch, "LANGDOCK_BASE_URL", str(body.langdockBaseUrl));
  setPatchValue(patch, "LANGDOCK_API_KEY", str(body.langdockApiKey));
  setPatchValue(patch, "LANGDOCK_AGENT_ID", str(body.langdockAgentId));
  setPatchValue(patch, "PAYMENT_MODE", paymentMode);
  setPatchValue(patch, "PAYMENT_SERVICE_URL", str(body.paymentServiceUrl));
  setPatchValue(patch, "PAYMENT_API_KEY", str(body.paymentApiKey));
  if (rawAuthHeader === "") patch.deletes.add("PAYMENT_API_AUTH_HEADER");
  else setPatchValue(patch, "PAYMENT_API_AUTH_HEADER", authHeader);
  setPatchValue(patch, "NETWORK", network);
  setPatchValue(patch, "AGENT_IDENTIFIER", str(body.agentIdentifier));
  setPatchValue(patch, "SELLER_VKEY", str(body.sellerVKey));
  if (rawPriceAmounts === "") patch.deletes.add("PRICE_AMOUNTS");
  else setPatchValue(patch, "PRICE_AMOUNTS", priceAmounts);

  return patch;
}

function registryEnvPatch(
  body: RegistrySetupBody,
  exampleOutputs: RegistryExampleOutput[] | undefined,
): EnvPatch {
  const patch: EnvPatch = { updates: new Map(), deletes: new Set() };
  setOptionalPatchValue(patch, "REGISTRY_AGENT_NAME", str(body.agentName));
  setOptionalPatchValue(patch, "REGISTRY_AGENT_DESCRIPTION", str(body.agentDescription));
  setOptionalPatchValue(patch, "REGISTRY_AGENT_API_BASE_URL", str(body.agentApiBaseUrl));
  setOptionalPatchValue(patch, "REGISTRY_CAPABILITY_NAME", str(body.capabilityName));
  setOptionalPatchValue(patch, "REGISTRY_CAPABILITY_VERSION", str(body.capabilityVersion));
  setOptionalPatchValue(patch, "REGISTRY_AUTHOR_NAME", str(body.authorName));
  setOptionalPatchValue(patch, "REGISTRY_AUTHOR_CONTACT_EMAIL", str(body.authorContactEmail));
  setOptionalPatchValue(patch, "REGISTRY_AUTHOR_CONTACT_OTHER", str(body.authorContactOther));
  setOptionalPatchValue(patch, "REGISTRY_AUTHOR_ORGANIZATION", str(body.authorOrganization));
  setOptionalPatchValue(patch, "REGISTRY_TAGS", splitCsv(body.tags).join(","));
  setOptionalPatchValue(patch, "REGISTRY_PRICING_AMOUNT", str(body.pricingAmount));
  setOptionalPatchValue(patch, "REGISTRY_PRICING_UNIT", str(body.pricingUnit));
  if (body.exampleOutputs !== undefined) {
    setOptionalPatchValue(
      patch,
      "REGISTRY_EXAMPLE_OUTPUTS",
      exampleOutputs ? JSON.stringify(exampleOutputs) : "",
    );
  }
  setOptionalPatchValue(patch, "REGISTRY_LEGAL_PRIVACY_POLICY", str(body.legalPrivacyPolicy));
  setOptionalPatchValue(patch, "REGISTRY_LEGAL_TERMS", str(body.legalTerms));
  setOptionalPatchValue(patch, "REGISTRY_LEGAL_OTHER", str(body.legalOther));
  return patch;
}

type StoredAgentProfile = {
  slug: string;
  name: string;
  description: string;
  apiBaseUrl: string;
  langdockAgentId: string;
  agentIdentifier: string;
  priceAmounts: Array<{ amount: string; unit: string }>;
  inputSchema?: InputSchemaField[];
};

function isStoredInputSchemaField(item: unknown): item is InputSchemaField {
  if (!item || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    ["string", "number", "boolean", "option", "none"].includes(
      typeof record.type === "string" ? record.type : "",
    )
  );
}

function readStoredAgentProfiles(): StoredAgentProfile[] {
  const raw = process.env.AGENTS_JSON;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        slug: normalizeAgentSlug(str(item.slug) ?? str(item.name) ?? ""),
        name: str(item.name) ?? "",
        description: str(item.description) ?? "",
        apiBaseUrl: str(item.apiBaseUrl) ?? "",
        langdockAgentId: str(item.langdockAgentId) ?? "",
        agentIdentifier: str(item.agentIdentifier) ?? "",
        priceAmounts: Array.isArray(item.priceAmounts)
          ? item.priceAmounts
              .filter(
                (amount): amount is { amount: string; unit: string } =>
                  Boolean(amount) &&
                  typeof amount === "object" &&
                  typeof (amount as { amount?: unknown }).amount === "string" &&
                  typeof (amount as { unit?: unknown }).unit === "string",
              )
              .map((amount) => ({
                amount: amount.amount,
                unit: amount.unit,
              }))
          : [],
        inputSchema: Array.isArray(item.inputSchema)
          ? item.inputSchema.filter(isStoredInputSchemaField)
          : undefined,
      }))
      .filter((item) => item.slug && item.langdockAgentId);
  } catch {
    return [];
  }
}

function agentProfileEnvPatch(
  body: RegistrySetupBody,
  agentIdentifier?: string,
): EnvPatch {
  const rawSlug = str(body.agentSlug);
  const rawLangdockAgentId = str(body.langdockAgentId);
  if (!rawSlug && !rawLangdockAgentId) {
    return { updates: new Map(), deletes: new Set() };
  }

  const slug = normalizeAgentSlug(rawSlug || str(body.agentName) || "");
  if (!slug) throw new Error("Agent route slug is required for multi-agent setup.");
  const langdockAgentId = requireString(body.langdockAgentId, "Langdock Agent ID");
  // Pricing is stored on-chain in the registry; keep the profile clean.
  // const pricingAmount = str(body.pricingAmount);
  // const pricingUnit = str(body.pricingUnit) || defaultPricingUnit(loadConfig().masumiNetwork);
  // const nextPriceAmounts =
  //   pricingAmount && /^[0-9]+$/.test(pricingAmount)
  //     ? [{ amount: pricingAmount, unit: pricingUnit }]
  //     : undefined;

  const existing = readStoredAgentProfiles();
  const index = existing.findIndex((item) => item.slug === slug);
  const previous = index >= 0 ? existing[index] : undefined;
  const next: StoredAgentProfile = {
    slug,
    name: str(body.agentName) || previous?.name || slug,
    description: str(body.agentDescription) || previous?.description || "",
    apiBaseUrl: str(body.agentApiBaseUrl) || previous?.apiBaseUrl || "",
    langdockAgentId,
    agentIdentifier: agentIdentifier || previous?.agentIdentifier || "",
    // Fixed pricing is stored on-chain in the registry; do NOT mirror it
    // here or registerSale will send RequestedFunds and get a 400.
    priceAmounts: [],
    inputSchema: previous?.inputSchema,
  };

  if (index >= 0) existing[index] = next;
  else existing.push(next);

  const patch: EnvPatch = { updates: new Map(), deletes: new Set() };
  patch.updates.set("AGENTS_JSON", JSON.stringify(existing, null, 2));
  return patch;
}

function persistAgentProfileIdentifier(slug: string, agentIdentifier: string): Promise<void> {
  const existing = readStoredAgentProfiles();
  const normalizedSlug = normalizeAgentSlug(slug);
  const index = existing.findIndex((item) => item.slug === normalizedSlug);
  if (index < 0) return Promise.resolve();
  existing[index] = {
    ...existing[index],
    agentIdentifier,
  };
  return persistEnvPatch({
    updates: new Map([["AGENTS_JSON", JSON.stringify(existing, null, 2)]]),
    deletes: new Set(),
  }).then(() => {
    process.env.AGENTS_JSON = JSON.stringify(existing, null, 2);
  });
}

function matchRegisteredAgent(assets: RegistryAgent[]): RegistryAgent | undefined {
  const identifier = process.env.AGENT_IDENTIFIER?.trim();
  const name = process.env.REGISTRY_AGENT_NAME?.trim();
  const apiBaseUrl = process.env.REGISTRY_AGENT_API_BASE_URL?.trim();

  return assets.find((asset) => {
    if (identifier && asset.agentIdentifier === identifier) return true;
    if (name && apiBaseUrl) {
      return asset.name === name && asset.apiBaseUrl === apiBaseUrl;
    }
    if (name) return asset.name === name;
    return false;
  });
}

function matchRegisteredAgentForProfile(
  assets: RegistryAgent[],
  profile: AgentProfileConfig,
): RegistryAgent | undefined {
  return assets.find((asset) => {
    if (profile.agentIdentifier && asset.agentIdentifier === profile.agentIdentifier) {
      return true;
    }
    if (profile.name && profile.apiBaseUrl) {
      return asset.name === profile.name && asset.apiBaseUrl === profile.apiBaseUrl;
    }
    if (profile.apiBaseUrl) return asset.apiBaseUrl === profile.apiBaseUrl;
    if (profile.name) return asset.name === profile.name;
    return false;
  });
}

async function persistAgentIdentifier(agentIdentifier: string): Promise<void> {
  const patch: EnvPatch = {
    updates: new Map([["AGENT_IDENTIFIER", agentIdentifier]]),
    deletes: new Set(),
  };
  await persistEnvPatch(patch);
  applyEnvPatch(patch);
}

function setupHtml(user?: AuthenticatedUser | null): string {
  const userBadge = user
    ? `<div class="user-badge">
        <a href="/admin" class="logout-btn secondary" style="text-decoration:none;display:inline-flex;align-items:center;">Operator dashboard</a>
        <span class="user-avatar" aria-hidden="true">${escSetupHtml((user.displayName || user.username).charAt(0).toUpperCase())}</span>
        <span class="user-name">${escSetupHtml(user.displayName || user.username)}</span>
        <button type="button" id="logoutButton" class="logout-btn secondary">Sign out</button>
      </div>`
    : '';
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Langdock Masumi Setup</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f4;
      --panel: #ffffff;
      --panel-soft: #f1f3ef;
      --text: #1c1c1a;
      --muted: #5b605a;
      --border: #d9ddd5;
      --accent: #0f6a5f;
      --accent-soft: #e4f4f1;
      --accent-text: #ffffff;
      --danger: #a63636;
      --ok: #1f7a4d;
      --warn: #8a5d00;
      --shadow: 0 1px 2px rgba(20, 24, 20, 0.05);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #131512;
        --panel: #1d1f1b;
        --panel-soft: #252821;
        --text: #eeeeea;
        --muted: #b9bbb3;
        --border: #3a3b35;
        --accent: #38b7a6;
        --accent-soft: #153b35;
        --accent-text: #08221e;
        --danger: #f07d7d;
        --ok: #74d59f;
        --warn: #e0b54b;
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .app-shell {
      width: min(1280px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: center;
      margin-bottom: 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }
    .brand-mark {
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 850;
      box-shadow: var(--shadow);
      flex: 0 0 auto;
    }
    h1 {
      margin: 0;
      font-size: clamp(24px, 3vw, 34px);
      line-height: 1.12;
      letter-spacing: 0;
    }
    h2, h3, p { margin-top: 0; }
    h2 { margin-bottom: 6px; font-size: 20px; }
    h3 { margin-bottom: 6px; font-size: 15px; }
    p { color: var(--muted); }
    .subtitle {
      margin: 4px 0 0;
      max-width: 68ch;
      font-size: 14px;
    }
    .top-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .metric {
      min-height: 92px;
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      padding: 14px;
      box-shadow: var(--shadow);
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric strong {
      display: block;
      margin-top: 8px;
      font-size: 18px;
      line-height: 1.2;
    }
    .metric small {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .workspace {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr) 360px;
      gap: 14px;
      align-items: start;
    }
    .section-nav,
    .content-panel,
    .status-panel {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .section-nav {
      position: sticky;
      top: 16px;
      display: grid;
      gap: 6px;
      padding: 8px;
    }
    .nav-item {
      width: 100%;
      min-height: 48px;
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 8px 10px;
      background: transparent;
      color: var(--muted);
      text-align: left;
      font-size: 14px;
      font-weight: 750;
    }
    .nav-item span {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--panel-soft);
      color: var(--muted);
      font-size: 12px;
      font-weight: 850;
    }
    .nav-item[aria-selected="true"] {
      background: var(--accent-soft);
      color: var(--text);
      border-color: color-mix(in srgb, var(--accent), transparent 65%);
    }
    .nav-item[aria-selected="true"] span {
      background: var(--accent);
      color: var(--accent-text);
    }
    .content-panel,
    .status-panel {
      padding: 20px;
    }
    .panel-section {
      display: grid;
      gap: 18px;
    }
    .panel-section[hidden] {
      display: none;
    }
    .panel-heading {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      border-bottom: 1px solid var(--border);
      padding-bottom: 14px;
    }
    .panel-heading p {
      margin-bottom: 0;
      max-width: 72ch;
      font-size: 14px;
    }
    form, fieldset, .stack {
      display: grid;
      gap: 16px;
    }
    fieldset {
      border: 0;
      padding: 0;
      margin: 0;
    }
    legend {
      width: 100%;
      padding: 0 0 4px;
      font-weight: 700;
      border-bottom: 1px solid var(--border);
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 14px;
      font-weight: 650;
    }
    input, select, textarea, button {
      font: inherit;
      border-radius: 6px;
    }
    input, select, textarea {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel), var(--bg) 20%);
      color: var(--text);
      padding: 10px 12px;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out, background-color 120ms ease-out;
    }
    input::placeholder,
    textarea::placeholder {
      color: color-mix(in srgb, var(--muted), transparent 25%);
    }
    textarea {
      min-height: 92px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--accent), transparent 45%);
      outline-offset: 2px;
    }
    button {
      min-height: 44px;
      border: 1px solid transparent;
      padding: 10px 14px;
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 700;
      cursor: pointer;
      transition: background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out, transform 80ms ease-out;
    }
    @media (hover: hover) {
      button:hover {
        transform: translateY(-1px);
      }
      button.secondary:hover,
      .slot-card:hover,
      .nav-item:hover {
        border-color: color-mix(in srgb, var(--accent), transparent 55%);
      }
    }
    button:active { transform: translateY(0); }
    button.secondary {
      background: transparent;
      color: var(--text);
      border-color: var(--border);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.65;
    }
    .row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .three-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .segmented {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .segmented label {
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 750;
    }
    .segmented input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 1px;
      height: 1px;
    }
    .segmented label:has(input:checked) {
      background: var(--accent);
      color: var(--accent-text);
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }
    .notice {
      display: grid;
      gap: 8px;
      border: 1px solid color-mix(in srgb, var(--warn), transparent 55%);
      background: color-mix(in srgb, var(--warn), transparent 90%);
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13px;
    }
    .notice strong { color: var(--text); }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      padding-top: 2px;
    }
    .hidden { display: none !important; }
    .agent-slots {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .slot-card {
      min-height: auto;
      display: grid;
      gap: 4px;
      padding: 10px;
      text-align: left;
      background: color-mix(in srgb, var(--panel), var(--bg) 18%);
      color: var(--text);
      border-color: var(--border);
      font-weight: 650;
    }
    .slot-card[aria-pressed="true"] {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent), transparent 75%);
    }
    .slot-card small {
      color: var(--muted);
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      border-radius: 999px;
      border: 1px solid var(--border);
      padding: 4px 10px;
      font-size: 13px;
      font-weight: 750;
      white-space: nowrap;
    }
    .status.ready { color: var(--ok); }
    .status.not-ready { color: var(--danger); }
    .setup-guide {
      display: grid;
      gap: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      background: var(--panel-soft);
    }
    .setup-guide h3 {
      margin: 0;
      font-size: 16px;
    }
    .setup-guide dl {
      display: grid;
      gap: 10px;
      margin: 0;
    }
    .setup-guide dt {
      font-size: 13px;
      font-weight: 800;
    }
    .setup-guide dd {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .setup-guide a {
      color: var(--accent);
      font-weight: 750;
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
    }
    .error {
      color: var(--danger);
      font-size: 14px;
      font-weight: 650;
    }
    .success {
      color: var(--ok);
      font-size: 14px;
      font-weight: 650;
    }
    .message {
      min-height: 24px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 650;
    }
    .message.error { color: var(--danger); }
    .message.success { color: var(--ok); }
    pre {
      overflow: auto;
      min-height: 96px;
      max-height: 420px;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel), var(--bg) 45%);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    details.output-block {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel), var(--bg) 18%);
      overflow: hidden;
    }
    details.output-block summary {
      min-height: 44px;
      display: flex;
      align-items: center;
      padding: 10px 12px;
      cursor: pointer;
      font-weight: 750;
    }
    details.output-block pre {
      margin: 0;
      border: 0;
      border-top: 1px solid var(--border);
      border-radius: 0;
      background: transparent;
    }
    details.output-block summary:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--accent), transparent 45%);
      outline-offset: -3px;
    }
    ul {
      padding-left: 20px;
      color: var(--muted);
    }
    li + li { margin-top: 6px; }
    .issue-list {
      margin: 10px 0 0;
      padding-left: 0;
      list-style: none;
    }
    .issue-list li {
      border-left: 3px solid var(--warn);
      padding: 8px 10px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--warn), transparent 91%);
      color: var(--text);
      font-size: 13px;
    }
    .issue-list li.danger {
      border-left-color: var(--danger);
      background: color-mix(in srgb, var(--danger), transparent 91%);
    }
    .issue-list li.ok {
      border-left-color: var(--ok);
      background: color-mix(in srgb, var(--ok), transparent 92%);
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .user-badge {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--panel);
    }
    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--accent-text);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 14px;
    }
    .user-name {
      font-size: 14px;
      font-weight: 650;
    }
    .logout-btn {
      font-size: 12px;
      padding: 6px 10px;
      min-height: 32px;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
      }
    }
    @media (max-width: 1120px) {
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .workspace {
        grid-template-columns: minmax(0, 1fr) 340px;
      }
      .section-nav {
        position: static;
        grid-column: 1 / -1;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    @media (max-width: 820px) {
      .app-shell { width: min(100% - 24px, 720px); padding-top: 18px; }
      .topbar, .workspace, .row, .three-row, .agent-slots {
        grid-template-columns: 1fr;
        display: grid;
      }
      .top-actions { justify-content: flex-start; }
      .section-nav { grid-template-columns: 1fr; }
      .summary-grid { grid-template-columns: 1fr; }
      .panel-heading { display: grid; }
    }
    @media (max-width: 480px) {
      .app-shell { width: min(100% - 20px, 420px); }
      .brand { align-items: flex-start; }
      .brand-mark { width: 40px; height: 40px; }
      .content-panel, .status-panel { padding: 16px; }
      .metric { min-height: auto; }
    }
  </style>
</head>
<body>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">LM</div>
        <div>
          <h1>Langdock Masumi Setup</h1>
          <p class="subtitle">Configure Langdock execution, Masumi payments, registry metadata, and live job testing from one operator console.</p>
        </div>
      </div>
      <div class="top-actions">
        ${userBadge}
        <button id="refreshStateTop" type="button" class="secondary">Refresh</button>
      </div>
    </header>

    <section class="summary-grid" aria-label="Wrapper summary">
      <div class="metric">
        <span>Readiness</span>
        <strong><span id="readyBadge" class="status">Checking</span></strong>
        <small id="summaryIssues">Loading checks</small>
      </div>
      <div class="metric">
        <span>Payment</span>
        <strong id="summaryMode">Masumi</strong>
        <small id="summaryNetwork">Preprod</small>
      </div>
      <div class="metric">
        <span>Registry</span>
        <strong id="summaryRegistry">Not loaded</strong>
        <small>Agent name and listing state</small>
      </div>
      <div class="metric">
        <span>Secrets</span>
        <strong id="summarySecrets">Checking</strong>
        <small>Keys stay redacted after save</small>
      </div>
    </section>

    <div class="workspace">
      <nav class="section-nav" aria-label="Setup workflow">
        <button class="nav-item" type="button" data-panel-target="configPanel" aria-controls="configPanel" aria-selected="true"><span>01</span> Configure</button>
        <button class="nav-item" type="button" data-panel-target="registryPanel" aria-controls="registryPanel" aria-selected="false"><span>02</span> Registry</button>
        <button class="nav-item" type="button" data-panel-target="testPanel" aria-controls="testPanel" aria-selected="false"><span>03</span> Test</button>
      </nav>

      <section class="content-panel" aria-label="Setup panels">
        <section id="configPanel" class="panel-section" aria-labelledby="configTitle">
          <div class="panel-heading">
            <div>
              <h2 id="configTitle">Runtime config</h2>
              <p>Save runtime values to <code>.env</code> and apply them to the running process. Existing secret values stay redacted and can be left blank.</p>
            </div>
          </div>
          <div class="notice">
            <strong>Production safety:</strong>
            <span>Use a database admin user for hosted deployments, or set <code>SETUP_USERNAME</code> with <code>SETUP_PASSWORD_HASH</code> as an env fallback. Secrets entered here are not echoed back by the dashboard.</span>
          </div>
          <details class="setup-guide">
            <summary>Credential guide</summary>
            <dl>
              <div>
                <dt>Admin login</dt>
                <dd>Protects this setup page. Create a database user with <code>npm run admin:create-user</code>, or set <code>SETUP_USERNAME</code> and <code>SETUP_PASSWORD_HASH</code>. <a href="https://docs.railway.com/variables" target="_blank" rel="noreferrer">Railway variables</a></dd>
              </div>
              <div>
                <dt>Langdock API key and Agent ID</dt>
                <dd>Create an API key in Langdock workspace settings, share the agent with that API key, then copy the agent ID from the agent URL. <a href="https://docs.langdock.com/api-endpoints/agent/agent-api-guide" target="_blank" rel="noreferrer">Langdock guide</a></dd>
              </div>
              <div>
                <dt>Payment Service URL and API key</dt>
                <dd>Use a Masumi Payment Service base URL ending in <code>/api/v1</code> or Masumi SaaS ending in <code>/pay/api/v1</code>. <a href="https://www.masumi.network/dev/masumi/api-reference" target="_blank" rel="noreferrer">Masumi API reference</a></dd>
              </div>
              <div>
                <dt>Seller VKey and Agent Identifier</dt>
                <dd>The seller VKey identifies the funded selling wallet. The agent identifier is created by Masumi registry registration; use Register agent, then Refresh registry until it appears. <a href="https://www.masumi.network/dev/masumi/documentation/how-to-guides/list-agent-on-sokosumi" target="_blank" rel="noreferrer">Sokosumi listing guide</a></dd>
              </div>
            </dl>
          </details>
          <form id="configForm" novalidate>
          <fieldset>
            <legend>Langdock</legend>
            <label>
              Base URL
              <input name="langdockBaseUrl" type="url" inputmode="url" autocomplete="url" value="https://api.langdock.com" required />
              <span class="hint">The wrapper calls {baseUrl}/agent/v1/chat/completions.</span>
            </label>
            <div class="row">
              <label>
                API key
                <input name="langdockApiKey" type="password" autocomplete="new-password" spellcheck="false" />
                <span class="hint">Leave blank to keep the saved key.</span>
              </label>
              <label>
                Agent ID
                <input name="langdockAgentId" type="text" autocomplete="off" spellcheck="false" />
                <span class="hint">Leave blank to keep the saved agent ID.</span>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Masumi</legend>
            <div class="row">
              <label>
                Payment mode
                <select name="paymentMode">
                  <option value="masumi">masumi</option>
                  <option value="direct">direct</option>
                </select>
              </label>
              <label>
                Network
                <span class="segmented" role="radiogroup" aria-label="Masumi network">
                  <label><input type="radio" name="network" value="Preprod" checked /> Preprod</label>
                  <label><input type="radio" name="network" value="Mainnet" /> Mainnet</label>
                </span>
              </label>
            </div>
            <label>
              Payment Service URL
              <input name="paymentServiceUrl" type="url" inputmode="url" autocomplete="url" placeholder="https://.../pay/api/v1" />
              <span class="hint">Use /pay/api/v1 for Masumi SaaS or /api/v1 for a direct payment node.</span>
            </label>
            <div class="row">
              <label>
                Payment API key
                <input name="paymentApiKey" type="password" autocomplete="new-password" spellcheck="false" />
                <span class="hint">Leave blank to keep the saved payment key.</span>
              </label>
              <label>
                Auth header
                <select name="paymentApiAuthHeader">
                  <option value="">Auto</option>
                  <option value="x-api-key">x-api-key</option>
                  <option value="token">token</option>
                </select>
              </label>
            </div>
            <div class="row">
              <label>
                Agent identifier
                <input name="agentIdentifier" type="text" autocomplete="off" spellcheck="false" />
                <span class="hint">Usually filled after registry registration.</span>
              </label>
              <label>
                Seller VKey
                <input name="sellerVKey" type="password" autocomplete="new-password" spellcheck="false" />
                <span class="hint">Leave blank to keep the saved seller key.</span>
              </label>
            </div>
            <label>
              Price amounts JSON
              <textarea name="priceAmounts" spellcheck="false" placeholder='[{"amount":"1000000","unit":"..."}]'></textarea>
              <span class="hint">Optional. Leave empty to use fixed pricing configured in Masumi.</span>
            </label>
          </fieldset>

          <div class="actions">
            <button id="saveConfig" type="submit">Apply config</button>
            <button id="refreshState" class="secondary" type="button">Refresh status</button>
            <span id="configMessage" class="message" role="status" aria-live="polite"></span>
          </div>
        </form>
        </section>

        <section id="registryPanel" class="panel-section" aria-labelledby="registryTitle" hidden>
          <div class="panel-heading">
            <div>
              <h2 id="registryTitle">Masumi registry</h2>
              <p>Prepare the public listing metadata your users will see. Agent profiles are saved locally in this browser so you can manage multiple listings.</p>
            </div>
          </div>
          <div class="stack" aria-labelledby="agentSlotsTitle">
            <div>
              <h3 id="agentSlotsTitle">Agent slots</h3>
              <p class="hint">Save up to four registration profiles locally, then register the selected profile when its metadata is ready.</p>
            </div>
            <div id="agentSlots" class="agent-slots" role="list" aria-label="Agent registration slots"></div>
            <div class="actions">
              <button id="saveAgentSlot" class="secondary" type="button">Save current slot</button>
              <button id="clearAgentSlot" class="secondary" type="button">Clear slot</button>
            </div>
          </div>

          <form id="registryForm" class="stack" novalidate>
          <fieldset>
            <legend>Public listing</legend>
          <div class="row">
            <label>
              Agent route slug
              <input name="agentSlug" type="text" autocomplete="off" spellcheck="false" placeholder="research-agent" />
              <span class="hint">Creates /agents/{slug}/start_job, /status, /availability, and /input_schema.</span>
            </label>
            <label>
              Langdock Agent ID
              <input name="langdockAgentId" type="text" autocomplete="off" spellcheck="false" placeholder="langdock-agent-id" />
              <span class="hint">The Langdock agent this slot calls at runtime.</span>
            </label>
          </div>
          <label>
            Public agent URL
            <input name="agentApiBaseUrl" type="url" inputmode="url" autocomplete="url" placeholder="https://your-agent.example.com" />
            <span class="hint">Must be public and serve /availability, /input_schema, /start_job, and /status.</span>
          </label>
          <div class="row">
            <label>
              Agent name
              <input name="agentName" type="text" autocomplete="off" maxlength="250" />
            </label>
            <label>
              Tags
              <input name="tags" type="text" autocomplete="off" value="langdock,masumi" />
              <span class="hint">Comma-separated, 1-15 tags.</span>
            </label>
          </div>
          <label>
            Description
            <textarea name="agentDescription" maxlength="250" placeholder="What this agent does"></textarea>
          </label>
          </fieldset>

          <fieldset>
            <legend>Capability and pricing</legend>
          <div class="row">
            <label>
              Capability
              <input name="capabilityName" type="text" autocomplete="off" value="langdock-agent" />
            </label>
            <label>
              Version
              <input name="capabilityVersion" type="text" autocomplete="off" value="1.0.0" />
            </label>
          </div>
          <div class="row">
            <label>
              Price amount
              <input name="pricingAmount" type="text" inputmode="numeric" pattern="[0-9]*" value="1000000" />
              <span class="hint">Raw units. 1000000 = 1 tUSDM/USDCx.</span>
            </label>
            <label>
              Price unit
              <input name="pricingUnit" type="text" autocomplete="off" spellcheck="false" />
            </label>
          </div>
          </fieldset>

          <fieldset>
            <legend>Author</legend>
          <div class="row">
            <label>
              Author name
              <input name="authorName" type="text" autocomplete="name" />
            </label>
            <label>
              Author email
              <input name="authorContactEmail" type="email" autocomplete="email" spellcheck="false" />
            </label>
          </div>
          <label>
            Author contact
            <input name="authorContactOther" type="text" autocomplete="off" />
          </label>
          <label>
            Organization
            <input name="authorOrganization" type="text" autocomplete="organization" />
          </label>
          </fieldset>

          <fieldset>
            <legend>Examples and legal</legend>
          <label>
            Example outputs
            <textarea name="exampleOutputs" spellcheck="false" placeholder='[{"name":"Sample report","url":"https://example.com/report.pdf","mimeType":"application/pdf"}]'></textarea>
            <span class="hint">Optional JSON array of public sample output links.</span>
          </label>
          <div class="row">
            <label>
              Privacy policy URL
              <input name="legalPrivacyPolicy" type="url" inputmode="url" autocomplete="url" />
            </label>
            <label>
              Terms URL
              <input name="legalTerms" type="url" inputmode="url" autocomplete="url" />
            </label>
          </div>
          <label>
            Legal notes
            <textarea name="legalOther" spellcheck="false"></textarea>
          </label>
          </fieldset>
          <div class="actions">
            <button id="registerAgent" type="submit">Register agent</button>
            <button id="refreshRegistry" class="secondary" type="button">Refresh registry</button>
            <span id="registryMessage" class="message" role="status" aria-live="polite"></span>
          </div>
        </form>
        <details class="output-block">
          <summary>Registry response</summary>
          <pre id="registryOutput" aria-label="Registry response">Register or refresh to see registry status.</pre>
        </details>
        </section>

        <section id="testPanel" class="panel-section" aria-labelledby="testTitle" hidden>
          <div class="panel-heading">
            <div>
              <h2 id="testTitle">Test execution</h2>
              <p>Call Langdock directly or submit the wrapper's <code>/start_job</code> endpoint using the current runtime configuration.</p>
            </div>
          </div>
        <form id="startJobForm" class="stack" novalidate>
          <label>
            Identifier from purchaser
            <input name="identifier_from_purchaser" type="text" autocomplete="off" spellcheck="false" placeholder="ab12cd34ef56ab" />
            <span class="hint">Masumi mode requires lowercase hex, 14-26 characters. Leave empty in direct mode.</span>
          </label>
          <label>
            Prompt
            <textarea name="text" required>Say hello in one sentence.</textarea>
          </label>
          <div class="actions">
            <button id="testLangdock" class="secondary" type="button">Test Langdock</button>
            <button id="runJob" type="submit">Run job</button>
            <span id="jobMessage" class="message" role="status" aria-live="polite"></span>
          </div>
        </form>
        <details class="output-block" open>
          <summary>Job response</summary>
          <pre id="jobOutput" aria-label="Job response">Submit a job to see the response.</pre>
        </details>
        </section>
      </section>

      <aside class="status-panel stack" aria-labelledby="statusTitle">
        <div>
          <h2 id="statusTitle">Readiness</h2>
          <p id="emptyState">No status loaded yet.</p>
          <ul id="issues" class="issue-list"></ul>
        </div>
        <details class="output-block" open>
          <summary>Redacted configuration state</summary>
          <pre id="stateOutput" aria-label="Redacted configuration state">{}</pre>
        </details>
      </aside>
    </div>
  </main>

  <script>
    const PREPROD_TUSDM_UNIT = '${PREPROD_TUSDM_UNIT}';
    const MAINNET_USDCX_UNIT = '${MAINNET_USDCX_UNIT}';
    const configForm = document.getElementById('configForm');
    const registryForm = document.getElementById('registryForm');
    const startJobForm = document.getElementById('startJobForm');
    const readyBadge = document.getElementById('readyBadge');
    const issues = document.getElementById('issues');
    const stateOutput = document.getElementById('stateOutput');
    const jobOutput = document.getElementById('jobOutput');
    const registryOutput = document.getElementById('registryOutput');
    const configMessage = document.getElementById('configMessage');
    const registryMessage = document.getElementById('registryMessage');
    const jobMessage = document.getElementById('jobMessage');
    const emptyState = document.getElementById('emptyState');
    const saveConfig = document.getElementById('saveConfig');
    const runJob = document.getElementById('runJob');
    const registerAgent = document.getElementById('registerAgent');
    const testLangdock = document.getElementById('testLangdock');
    const agentSlots = document.getElementById('agentSlots');
    const saveAgentSlot = document.getElementById('saveAgentSlot');
    const clearAgentSlot = document.getElementById('clearAgentSlot');
    const refreshStateTop = document.getElementById('refreshStateTop');
    const summaryMode = document.getElementById('summaryMode');
    const summaryNetwork = document.getElementById('summaryNetwork');
    const summaryRegistry = document.getElementById('summaryRegistry');
    const summarySecrets = document.getElementById('summarySecrets');
    const summaryIssues = document.getElementById('summaryIssues');
    const panelStorageKey = 'langdock-masumi-wrapper.activePanel.v1';
    const slotStorageKey = 'langdock-masumi-wrapper.agentSlots.v1';
    let selectedAgentSlot = 0;
    let registryEnvLoaded = false;

    function formValue(form, name) {
      const field = form.elements[name];
      return field && 'value' in field ? field.value.trim() : '';
    }

    function setupHeaders() {
      return { };
    }

    function setActivePanel(panelId) {
      document.querySelectorAll('[data-panel-target]').forEach((button) => {
        const isActive = button.getAttribute('data-panel-target') === panelId;
        button.setAttribute('aria-selected', String(isActive));
      });
      document.querySelectorAll('.panel-section').forEach((panel) => {
        panel.hidden = panel.id !== panelId;
      });
      try { localStorage.setItem(panelStorageKey, panelId); } catch {}
    }

    document.querySelectorAll('[data-panel-target]').forEach((button) => {
      button.addEventListener('click', () => {
        setActivePanel(button.getAttribute('data-panel-target'));
      });
    });

    function restorePanel() {
      let saved = 'configPanel';
      try { saved = localStorage.getItem(panelStorageKey) || saved; } catch {}
      if (!document.getElementById(saved)) saved = 'configPanel';
      setActivePanel(saved);
    }

    function blankAgentSlot() {
      return {
        agentSlug: '',
        langdockAgentId: '',
        agentApiBaseUrl: '',
        agentName: '',
        agentDescription: '',
        capabilityName: 'langdock-agent',
        capabilityVersion: '1.0.0',
        authorName: '',
        authorContactEmail: '',
        authorContactOther: '',
        authorOrganization: '',
        tags: 'langdock,masumi',
        pricingAmount: '1000000',
        pricingUnit: '',
        exampleOutputs: '',
        legalPrivacyPolicy: '',
        legalTerms: '',
        legalOther: ''
      };
    }

    function loadAgentSlots() {
      try {
        const parsed = JSON.parse(localStorage.getItem(slotStorageKey) || '[]');
        if (Array.isArray(parsed)) {
          return Array.from({ length: 4 }, (_, index) => Object.assign(blankAgentSlot(), parsed[index] || {}));
        }
      } catch {
        // Ignore corrupt local storage and reset below.
      }
      return Array.from({ length: 4 }, blankAgentSlot);
    }

    function saveAgentSlots(slots) {
      localStorage.setItem(slotStorageKey, JSON.stringify(slots.slice(0, 4)));
    }

    function currentRegistryPayload() {
      return {
        agentSlug: formValue(registryForm, 'agentSlug'),
        langdockAgentId: formValue(registryForm, 'langdockAgentId'),
        agentApiBaseUrl: formValue(registryForm, 'agentApiBaseUrl'),
        agentName: formValue(registryForm, 'agentName'),
        agentDescription: formValue(registryForm, 'agentDescription'),
        capabilityName: formValue(registryForm, 'capabilityName'),
        capabilityVersion: formValue(registryForm, 'capabilityVersion'),
        authorName: formValue(registryForm, 'authorName'),
        authorContactEmail: formValue(registryForm, 'authorContactEmail'),
        authorContactOther: formValue(registryForm, 'authorContactOther'),
        authorOrganization: formValue(registryForm, 'authorOrganization'),
        tags: formValue(registryForm, 'tags'),
        pricingAmount: formValue(registryForm, 'pricingAmount'),
        pricingUnit: formValue(registryForm, 'pricingUnit'),
        exampleOutputs: formValue(registryForm, 'exampleOutputs'),
        legalPrivacyPolicy: formValue(registryForm, 'legalPrivacyPolicy'),
        legalTerms: formValue(registryForm, 'legalTerms'),
        legalOther: formValue(registryForm, 'legalOther')
      };
    }

    function applyAgentSlot(slot) {
      const data = Object.assign(blankAgentSlot(), slot || {});
      for (const [key, value] of Object.entries(data)) {
        if (registryForm.elements[key]) registryForm.elements[key].value = value;
      }
      syncPricingUnit();
      syncAgentBaseUrl();
    }

    function renderAgentSlots() {
      const slots = loadAgentSlots();
      agentSlots.innerHTML = '';
      slots.forEach((slot, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'slot-card';
        button.setAttribute('role', 'listitem');
        button.setAttribute('aria-pressed', String(index === selectedAgentSlot));
        const title = document.createElement('span');
        title.textContent = 'Agent ' + (index + 1) + ': ' + (slot.agentName || 'Empty agent');
        const subtitle = document.createElement('small');
        subtitle.textContent = slot.agentSlug
          ? '/agents/' + slot.agentSlug
          : slot.agentApiBaseUrl || 'No route slug saved';
        button.append(title, subtitle);
        button.addEventListener('click', () => {
          selectedAgentSlot = index;
          applyAgentSlot(slots[index]);
          renderAgentSlots();
        });
        agentSlots.appendChild(button);
      });
    }

    function isMeaningfullyBlankAgentSlot(slot) {
      return !slot.agentSlug && !slot.langdockAgentId && !slot.agentApiBaseUrl && !slot.agentName && !slot.agentDescription && !slot.authorName;
    }

    function applyRegistryStateOnce(registry, agents) {
      if (registryEnvLoaded) return;
      registryEnvLoaded = true;
      if (Array.isArray(agents) && agents.length > 0) {
        const slots = loadAgentSlots();
        agents.slice(0, 4).forEach((agent, index) => {
          slots[index] = Object.assign(blankAgentSlot(), slots[index] || {}, {
            agentSlug: agent.slug || slots[index]?.agentSlug || '',
            agentApiBaseUrl: agent.apiBaseUrl || slots[index]?.agentApiBaseUrl || '',
            agentName: agent.name || slots[index]?.agentName || '',
            agentDescription: agent.description || slots[index]?.agentDescription || '',
            langdockAgentId: agent.langdockAgentId || slots[index]?.langdockAgentId || '',
          });
        });
        saveAgentSlots(slots);
        applyAgentSlot(slots[selectedAgentSlot]);
        renderAgentSlots();
        return;
      }
      if (!registry || typeof registry !== 'object') return;
      const serverSlot = blankAgentSlot();
      for (const [key, value] of Object.entries(registry)) {
        if (typeof value === 'string' && value.trim()) serverSlot[key] = value;
      }
      if (!serverSlot.agentApiBaseUrl && !serverSlot.agentName && !serverSlot.agentDescription) return;
      const slots = loadAgentSlots();
      if (!isMeaningfullyBlankAgentSlot(slots[selectedAgentSlot] || {})) return;
      slots[selectedAgentSlot] = serverSlot;
      saveAgentSlots(slots);
      applyAgentSlot(serverSlot);
      renderAgentSlots();
    }

    function saveCurrentAgentSlot() {
      syncAgentBaseUrl();
      const slots = loadAgentSlots();
      slots[selectedAgentSlot] = currentRegistryPayload();
      saveAgentSlots(slots);
      renderAgentSlots();
      setMessage(registryMessage, 'Saved agent ' + (selectedAgentSlot + 1) + ' locally.', 'success');
    }

    function clearCurrentAgentSlot() {
      const slots = loadAgentSlots();
      slots[selectedAgentSlot] = blankAgentSlot();
      saveAgentSlots(slots);
      applyAgentSlot(slots[selectedAgentSlot]);
      renderAgentSlots();
      setMessage(registryMessage, 'Cleared agent ' + (selectedAgentSlot + 1) + '.', 'success');
    }

    function setMessage(node, text, kind) {
      node.textContent = text;
      node.className = kind ? 'message ' + kind : 'message';
    }

    function setButtonLoading(button, loading, loadingLabel) {
      if (!button) return;
      if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
      button.disabled = loading;
      if (loading) {
        button.setAttribute('aria-busy', 'true');
        button.textContent = loadingLabel || 'Working...';
      } else {
        button.removeAttribute('aria-busy');
        button.textContent = button.dataset.defaultLabel;
      }
    }

    function selectedNetwork() {
      return formValue(configForm, 'network') || 'Preprod';
    }

    function syncPricingUnit() {
      const field = registryForm.elements.pricingUnit;
      if (!field.value.trim()) {
        field.value = selectedNetwork() === 'Mainnet' ? MAINNET_USDCX_UNIT : PREPROD_TUSDM_UNIT;
      }
    }

    function normalizeSlug(value) {
      return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    }

    function syncAgentBaseUrl() {
      const slugField = registryForm.elements.agentSlug;
      const urlField = registryForm.elements.agentApiBaseUrl;
      const normalized = normalizeSlug(slugField.value);
      if (slugField.value && slugField.value !== normalized) slugField.value = normalized;
      if (!normalized) return;
      const generated = window.location.origin + '/agents/' + normalized;
      if (!urlField.value.trim() || urlField.dataset.generated === 'true') {
        urlField.value = generated;
        urlField.dataset.generated = 'true';
      }
    }

    function populateConfigControls(configured) {
      if (!configured || typeof configured !== 'object') return;
      configForm.elements.langdockBaseUrl.value = configured.langdockBaseUrl || 'https://api.langdock.com';
      configForm.elements.paymentMode.value = configured.paymentMode || 'masumi';
      configForm.elements.paymentServiceUrl.value = configured.paymentServiceUrl || '';
      configForm.elements.paymentApiAuthHeader.value = configured.paymentApiAuthHeader || '';
      const networkField = configForm.querySelector('input[name="network"][value="' + (configured.network || 'Preprod') + '"]');
      if (networkField) networkField.checked = true;

      configForm.elements.langdockApiKey.placeholder = configured.langdockApiKey ? 'Saved on server' : '';
      configForm.elements.langdockAgentId.placeholder = configured.langdockAgentId ? 'Saved on server' : '';
      configForm.elements.paymentApiKey.placeholder = configured.paymentApiKey ? 'Saved on server' : '';
      configForm.elements.agentIdentifier.placeholder = configured.agentIdentifier ? 'Saved on server' : '';
      configForm.elements.sellerVKey.placeholder = configured.sellerVKey ? 'Saved on server' : '';
      if (configured.priceAmountsCount > 0 && !configForm.elements.priceAmounts.value.trim()) {
        configForm.elements.priceAmounts.placeholder = String(configured.priceAmountsCount) + ' price amount saved on server';
      }
      syncPricingUnit();
    }

    function renderState(data) {
      const report = data.report || {};
      applyRegistryStateOnce(data.registry, data.agents);
      populateConfigControls(data.configured);
      const ready = report.status === 'ready';
      readyBadge.textContent = ready ? 'Ready' : 'Not ready';
      readyBadge.className = ready ? 'status ready' : 'status not-ready';
      const configured = data.configured || {};
      summaryMode.textContent = configured.paymentMode || report.mode || 'masumi';
      summaryNetwork.textContent = configured.network || report.network || 'Preprod';
      summaryRegistry.textContent = configured.agentIdentifier
        ? 'Identifier saved'
        : data.registry && data.registry.agentName
          ? 'Profile saved'
          : 'Not registered';
      const secretCount = [
        configured.langdockApiKey,
        configured.langdockAgentId,
        configured.paymentApiKey,
        configured.sellerVKey
      ].filter(Boolean).length;
      summarySecrets.textContent = secretCount + '/4 saved';

      issues.innerHTML = '';
      const issueList = Array.isArray(report.issues) ? report.issues : [];
      emptyState.hidden = issueList.length > 0;
      summaryIssues.textContent = issueList.length === 0
        ? 'No open issues'
        : issueList.length + ' issue' + (issueList.length === 1 ? '' : 's');
      for (const issue of issueList) {
        const item = document.createElement('li');
        item.textContent = issue.severity + ': ' + issue.message;
        if (issue.severity === 'error') item.className = 'danger';
        if (issue.severity === 'info') item.className = 'ok';
        issues.appendChild(item);
      }
      stateOutput.textContent = JSON.stringify(data, null, 2);
    }

    async function refreshState(triggerButton) {
      setButtonLoading(triggerButton, true, 'Refreshing');
      setMessage(configMessage, 'Loading status...', '');
      try {
        const res = await fetch('/setup/config');
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Could not load status.');
        renderState(data);
        setMessage(configMessage, 'Status refreshed.', 'success');
      } catch (err) {
        setMessage(configMessage, 'Could not load status. Try again.', 'error');
      } finally {
        setButtonLoading(triggerButton, false);
      }
    }

    configForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setButtonLoading(saveConfig, true, 'Applying...');
      configForm.setAttribute('aria-busy', 'true');
      setMessage(configMessage, 'Applying config...', '');
      const payload = {
        langdockBaseUrl: formValue(configForm, 'langdockBaseUrl'),
        langdockApiKey: formValue(configForm, 'langdockApiKey'),
        langdockAgentId: formValue(configForm, 'langdockAgentId'),
        paymentMode: formValue(configForm, 'paymentMode'),
        paymentServiceUrl: formValue(configForm, 'paymentServiceUrl'),
        paymentApiKey: formValue(configForm, 'paymentApiKey'),
        paymentApiAuthHeader: formValue(configForm, 'paymentApiAuthHeader'),
        network: formValue(configForm, 'network'),
        agentIdentifier: formValue(configForm, 'agentIdentifier'),
        sellerVKey: formValue(configForm, 'sellerVKey'),
        priceAmounts: formValue(configForm, 'priceAmounts')
      };
      try {
        const res = await fetch('/setup/config', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, setupHeaders()),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Config was rejected.');
        renderState(data);
        configForm.reset();
        configForm.elements.langdockBaseUrl.value = payload.langdockBaseUrl || 'https://api.langdock.com';
        configForm.elements.paymentMode.value = payload.paymentMode || 'masumi';
        const networkField = configForm.querySelector('input[name="network"][value="' + (payload.network || 'Preprod') + '"]');
        if (networkField) networkField.checked = true;
        syncPricingUnit();
        setMessage(configMessage, 'Config saved to .env and applied.', 'success');
      } catch (err) {
        setMessage(configMessage, err instanceof Error ? err.message : 'Could not apply config.', 'error');
      } finally {
        setButtonLoading(saveConfig, false);
        configForm.removeAttribute('aria-busy');
      }
    });

    document.getElementById('refreshState').addEventListener('click', (event) => refreshState(event.currentTarget));
    refreshStateTop.addEventListener('click', (event) => refreshState(event.currentTarget));
    saveAgentSlot.addEventListener('click', saveCurrentAgentSlot);
    clearAgentSlot.addEventListener('click', clearCurrentAgentSlot);
    configForm.addEventListener('change', (event) => {
      if (event.target && event.target.name === 'network') {
        registryForm.elements.pricingUnit.value = selectedNetwork() === 'Mainnet' ? MAINNET_USDCX_UNIT : PREPROD_TUSDM_UNIT;
      }
    });
    registryForm.elements.agentSlug.addEventListener('blur', syncAgentBaseUrl);
    registryForm.elements.agentSlug.addEventListener('input', () => {
      registryForm.elements.agentApiBaseUrl.dataset.generated = 'true';
    });
    registryForm.elements.agentApiBaseUrl.addEventListener('input', () => {
      registryForm.elements.agentApiBaseUrl.dataset.generated = 'false';
    });

    async function refreshRegistryStatus(triggerButton) {
      setButtonLoading(triggerButton, true, 'Refreshing...');
      setMessage(registryMessage, 'Loading registry...', '');
      try {
        const slug = formValue(registryForm, 'agentSlug');
        const url = '/setup/registry/status' + (slug ? '?agentSlug=' + encodeURIComponent(slug) : '');
        const res = await fetch(url, {
          headers: setupHeaders()
        });
        const data = await res.json();
        registryOutput.textContent = JSON.stringify(data, null, 2);
        if (!res.ok) throw new Error(data.message || 'Could not load registry.');
        setMessage(registryMessage, data.agentIdentifier ? 'Agent identifier saved.' : 'Registry status loaded.', 'success');
        await refreshState();
      } catch (err) {
        setMessage(registryMessage, err instanceof Error ? err.message : 'Could not load registry.', 'error');
      } finally {
        setButtonLoading(triggerButton, false);
      }
    }

    document.getElementById('refreshRegistry').addEventListener('click', (event) => refreshRegistryStatus(event.currentTarget));

    registryForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setButtonLoading(registerAgent, true, 'Registering...');
      registryForm.setAttribute('aria-busy', 'true');
      syncPricingUnit();
      syncAgentBaseUrl();
      setMessage(registryMessage, 'Submitting registration...', '');
      const payload = {
        agentSlug: formValue(registryForm, 'agentSlug'),
        langdockAgentId: formValue(registryForm, 'langdockAgentId'),
        agentApiBaseUrl: formValue(registryForm, 'agentApiBaseUrl'),
        agentName: formValue(registryForm, 'agentName'),
        agentDescription: formValue(registryForm, 'agentDescription'),
        capabilityName: formValue(registryForm, 'capabilityName'),
        capabilityVersion: formValue(registryForm, 'capabilityVersion'),
        authorName: formValue(registryForm, 'authorName'),
        authorContactEmail: formValue(registryForm, 'authorContactEmail'),
        authorContactOther: formValue(registryForm, 'authorContactOther'),
        authorOrganization: formValue(registryForm, 'authorOrganization'),
        tags: formValue(registryForm, 'tags'),
        pricingAmount: formValue(registryForm, 'pricingAmount'),
        pricingUnit: formValue(registryForm, 'pricingUnit'),
        exampleOutputs: formValue(registryForm, 'exampleOutputs'),
        legalPrivacyPolicy: formValue(registryForm, 'legalPrivacyPolicy'),
        legalTerms: formValue(registryForm, 'legalTerms'),
        legalOther: formValue(registryForm, 'legalOther')
      };
      try {
        const res = await fetch('/setup/registry/register', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, setupHeaders()),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        registryOutput.textContent = JSON.stringify(data, null, 2);
        if (!res.ok) throw new Error(data.message || 'Registration failed.');
        saveCurrentAgentSlot();
        setMessage(registryMessage, 'Registration submitted for agent ' + (selectedAgentSlot + 1) + '. Confirmation can take several minutes.', 'success');
        await refreshState();
      } catch (err) {
        setMessage(registryMessage, err instanceof Error ? err.message : 'Could not register agent.', 'error');
      } finally {
        setButtonLoading(registerAgent, false);
        registryForm.removeAttribute('aria-busy');
      }
    });

    testLangdock.addEventListener('click', async () => {
      setButtonLoading(testLangdock, true, 'Testing...');
      setMessage(jobMessage, 'Calling Langdock...', '');
      try {
        const res = await fetch('/setup/langdock/test', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, setupHeaders()),
          body: JSON.stringify({ prompt: formValue(startJobForm, 'text') })
        });
        const data = await res.json();
        jobOutput.textContent = JSON.stringify(data, null, 2);
        if (!res.ok) throw new Error(data.message || 'Langdock test failed.');
        setMessage(jobMessage, 'Langdock responded.', 'success');
      } catch (err) {
        setMessage(jobMessage, err instanceof Error ? err.message : 'Could not call Langdock.', 'error');
      } finally {
        setButtonLoading(testLangdock, false);
      }
    });

    startJobForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setButtonLoading(runJob, true, 'Running...');
      startJobForm.setAttribute('aria-busy', 'true');
      setMessage(jobMessage, 'Submitting job...', '');
      const identifier = formValue(startJobForm, 'identifier_from_purchaser');
      const payload = {
        input_data: [{ key: 'text', value: formValue(startJobForm, 'text') }]
      };
      if (identifier) payload.identifier_from_purchaser = identifier;
      try {
        const res = await fetch('/start_job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        jobOutput.textContent = JSON.stringify(data, null, 2);
        if (!res.ok) throw new Error(data.message || 'Job was rejected.');
        setMessage(jobMessage, 'Job submitted.', 'success');
      } catch (err) {
        setMessage(jobMessage, err instanceof Error ? err.message : 'Could not submit job.', 'error');
      } finally {
        setButtonLoading(runJob, false);
        startJobForm.removeAttribute('aria-busy');
      }
    });

    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton) {
      logoutButton.addEventListener('click', async () => {
        setButtonLoading(logoutButton, true, 'Signing out...');
        try {
          await fetch('/auth/logout', { method: 'POST' });
        } finally {
          window.location.href = '/';
        }
      });
    }

    restorePanel();
    renderAgentSlots();
    applyAgentSlot(loadAgentSlots()[selectedAgentSlot]);
    syncPricingUnit();
    refreshState();
  </script>
</body>
</html>`;
}

function sessionTokenFromRequest(request: FastifyRequest): string {
  const cookie = request.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]*)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { return ""; }
  }
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return "";
}

function setSessionCookie(reply: import("fastify").FastifyReply, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `session=${encodeURIComponent(token)}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly${secure}`,
  );
}

async function getSessionUser(request: FastifyRequest): Promise<AuthenticatedUser | null> {
  const token = sessionTokenFromRequest(request);
  if (!token) return null;
  return verifyToken(token);
}

async function requestHasSetupAccess(request: FastifyRequest): Promise<boolean> {
  // Session-based auth
  const user = await getSessionUser(request);
  if (user) return true;
  // Legacy token/basic auth only when explicitly configured
  if (setupAccessConfigured()) {
    return requestCanConfigure(request);
  }
  return false;
}

function escSetupHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function registerSetup(app: FastifyInstance, ctx: BridgeContext): void {
  // ── Auth routes ─────────────────────────────────────────────────────

  app.get("/", async (request, reply) => {
    const user = await getSessionUser(request);
    if (user) {
      return reply.redirect("/dashboard");
    }
    return reply.type("text/html; charset=utf-8").send(loginHtml());
  });

  app.get("/dashboard", async (request, reply) => {
    const user = await getSessionUser(request);
    if (!user) {
      // Allow legacy token auth for API users but only when explicitly configured
      if (!setupAccessConfigured() || !(await requestCanConfigure(request))) {
        return reply.redirect("/");
      }
    }
    return reply.type("text/html; charset=utf-8").send(setupHtml(user));
  });

  app.post("/auth", async (request, reply) => {
    if (rejectCrossOriginPost(request, reply)) return;

    const body =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, string | undefined>)
        : {};
    const mode = (body.mode || "login").trim().toLowerCase();
    const username = (body.username || "").trim();
    const password = body.password || "";

    if (
      !applyRateLimit(
        reply,
        "setup-auth",
        clientIdentifier(request, username.toLowerCase() || "missing"),
        5,
        15 * 60 * 1000,
      )
    ) {
      return;
    }

    if (!username || !password) {
      return reply.status(400).send({ error: "MISSING_FIELDS", message: "Username and password are required." });
    }

    if (mode === "register") {
      return reply.status(403).send({
        error: "REGISTRATION_DISABLED",
        message: "Registration is disabled. Configure the admin login on the server.",
      });
    }

    const loginResult = await loginAdmin(username, password);
    if ("error" in loginResult) {
      return reply.status(loginResult.credentialsConfigured ? 401 : 503).send({
        error: "LOGIN_FAILED",
        message: loginResult.error,
      });
    }
    setSessionCookie(reply, loginResult.token);
    return reply.status(200).send({ ok: true, user: loginResult.user });
  });

  app.post("/auth/logout", async (request, reply) => {
    if (rejectCrossOriginPost(request, reply)) return;
    const token = sessionTokenFromRequest(request);
    if (token) await logoutUser(token);
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return reply
      .header(
        "set-cookie",
        `session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`,
      )
      .send({ ok: true });
  });

  // ── Setup API routes ───────────────────────────────────────────────

  app.get("/setup/config", async (request, reply) => {
    if (!await requestHasSetupAccess(request)) {
      return reply.status(401).send({
        error: "SETUP_ACCESS_DENIED",
        message: "Authentication required.",
      });
    }
    if (
      !applyRateLimit(
        reply,
        "setup-read",
        clientIdentifier(request),
        120,
        60 * 1000,
      )
    ) {
      return;
    }
    return reply.status(200).send(redactConfigState());
  });

  app.post("/setup/config", async (request, reply) => {
    if (rejectCrossOriginPost(request, reply)) return;
    if (!await requestHasSetupAccess(request)) {
      return reply.status(401).send({
        error: "SETUP_ACCESS_DENIED",
        message: "Authentication required.",
      });
    }
    if (
      !applyRateLimit(
        reply,
        "setup-write",
        clientIdentifier(request),
        30,
        60 * 1000,
      )
    ) {
      return;
    }

    const body =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as SetupConfigBody)
        : {};

    try {
      const patch = buildEnvPatch(body);
      await persistEnvPatch(patch);
      applyEnvPatch(patch);
      const config = loadConfig();
      ctx.endpointHandler.setStartJobHandler(
        createLangdockStartJobHandler(config),
      );
      return reply.status(200).send(redactConfigState());
    } catch (e) {
      return reply.status(400).send({
        error: "INVALID_SETUP_CONFIG",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.post("/setup/langdock/test", async (request, reply) => {
    if (rejectCrossOriginPost(request, reply)) return;
    if (!await requestHasSetupAccess(request)) {
      return reply.status(401).send({
        error: "SETUP_ACCESS_DENIED",
        message: "Authentication required.",
      });
    }
    if (
      !applyRateLimit(
        reply,
        "setup-langdock-test",
        clientIdentifier(request),
        20,
        60 * 1000,
      )
    ) {
      return;
    }

    const config = loadConfig();
    if (!config.langdockApiKey || !config.langdockAgentId) {
      return reply.status(400).send({
        error: "LANGDOCK_NOT_CONFIGURED",
        message:
          "Apply LANGDOCK_API_KEY and LANGDOCK_AGENT_ID before testing Langdock.",
      });
    }

    const body =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as LangdockTestBody)
        : {};
    const prompt = str(body.prompt) || "Say hello in one sentence.";

    try {
      const response = await completeChat({
        baseUrl: config.langdockBaseUrl,
        apiKey: config.langdockApiKey,
        agentId: config.langdockAgentId,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: prompt }],
          },
        ],
      });

      return reply.status(200).send({
        ok: true,
        output: extractAssistantContent(response),
        raw: response,
      });
    } catch (e) {
      const status = e instanceof LangdockApiError ? e.status : 500;
      return reply.status(status >= 400 && status < 600 ? status : 500).send({
        error: "LANGDOCK_TEST_FAILED",
        message:
          e instanceof LangdockApiError
            ? `Langdock HTTP ${e.status}: ${e.bodySnippet}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  });

  app.post("/setup/registry/register", async (request, reply) => {
    if (rejectCrossOriginPost(request, reply)) return;
    if (!await requestHasSetupAccess(request)) {
      return reply.status(401).send({
        error: "SETUP_ACCESS_DENIED",
        message: "Authentication required.",
      });
    }
    if (
      !applyRateLimit(
        reply,
        "setup-registry-register",
        clientIdentifier(request),
        10,
        60 * 1000,
      )
    ) {
      return;
    }

    const body =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as RegistrySetupBody)
        : {};

    try {
      const config = loadConfig();
      if (!config.paymentServiceUrl || !config.paymentApiKey) {
        return reply.status(400).send({
          error: "PAYMENT_SERVICE_NOT_CONFIGURED",
          message:
            "Apply PAYMENT_SERVICE_URL and PAYMENT_API_KEY before registering an agent.",
        });
      }
      if (!config.sellerVKey) {
        return reply.status(400).send({
          error: "SELLER_VKEY_NOT_CONFIGURED",
          message: "Apply SELLER_VKEY before registering an agent.",
        });
      }

      const tags = splitCsv(body.tags);
      if (tags.length === 0) {
        throw new Error("At least one tag is required.");
      }
      if (tags.length > 15) {
        throw new Error("Masumi registry accepts at most 15 tags.");
      }

      const pricing = normalizeRegistryPricing(
        body.pricing,
        body.pricingAmount,
        body.pricingUnit,
        config.masumiNetwork,
      );

      const agentName = requireString(body.agentName, "Agent name");
      const agentDescription = requireString(body.agentDescription, "Description");
      const agentApiBaseUrl = requireString(body.agentApiBaseUrl, "Public agent URL");
      const capabilityName = requireString(body.capabilityName, "Capability");
      const capabilityVersion = requireString(
        body.capabilityVersion,
        "Capability version",
      );
      const authorName = requireString(body.authorName, "Author name");
      const exampleOutputs = normalizeRegistryExampleOutputs(body.exampleOutputs);
      const registryPatch = registryEnvPatch(body, exampleOutputs);
      const draftAgentPatch = agentProfileEnvPatch(body);
      await persistEnvPatch(registryPatch);
      applyEnvPatch(registryPatch);
      if (draftAgentPatch.updates.size > 0 || draftAgentPatch.deletes.size > 0) {
        await persistEnvPatch(draftAgentPatch);
        applyEnvPatch(draftAgentPatch);
      }

      const client = configuredPaymentClient();
      const result = await client.registerAgent({
        network: config.masumiNetwork,
        sellingWalletVkey: config.sellerVKey,
        name: agentName,
        description: agentDescription,
        apiBaseUrl: agentApiBaseUrl,
        capabilityName,
        capabilityVersion,
        authorName,
        authorContactEmail: str(body.authorContactEmail),
        authorContactOther: str(body.authorContactOther),
        authorOrganization: str(body.authorOrganization),
        tags,
        exampleOutputs,
        legal: {
          privacyPolicy: str(body.legalPrivacyPolicy),
          terms: str(body.legalTerms),
          other: str(body.legalOther),
        },
        pricing,
      });

      if (result.agentIdentifier) {
        const slug = str(body.agentSlug);
        if (slug) {
          await persistAgentProfileIdentifier(slug, result.agentIdentifier);
        } else {
          await persistAgentIdentifier(result.agentIdentifier);
        }
      }

      return reply.status(200).send({
        status: "submitted",
        state: result.state,
        agentIdentifier: result.agentIdentifier,
        message:
          result.agentIdentifier
            ? "Agent identifier returned and saved."
            : "Registration submitted. Poll registry status until agentIdentifier appears.",
        raw: result.raw,
      });
    } catch (e) {
      const status = e instanceof MasumiPaymentError ? e.status : 400;
      return reply.status(status >= 400 && status < 600 ? status : 400).send({
        error: "REGISTRY_REGISTRATION_FAILED",
        message:
          e instanceof MasumiPaymentError
            ? `Masumi Payment HTTP ${e.status}: ${e.bodySnippet}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  });

  app.get<{ Querystring: { agentSlug?: string } }>(
    "/setup/registry/status",
    async (request, reply) => {
    if (!await requestHasSetupAccess(request)) {
      return reply.status(401).send({
        error: "SETUP_ACCESS_DENIED",
        message: "Authentication required.",
      });
    }
    if (
      !applyRateLimit(
        reply,
        "setup-registry-status",
        clientIdentifier(request),
        30,
        60 * 1000,
      )
    ) {
      return;
    }

    try {
      const client = configuredPaymentClient();
      const assets = await client.listRegistry();
      const requestedSlug = str(request.query.agentSlug);
      const profile = requestedSlug
        ? findAgentProfile(loadConfig(), requestedSlug)
        : undefined;
      if (requestedSlug && !profile) {
        return reply.status(404).send({
          error: "AGENT_NOT_FOUND",
          message: `No agent is configured for slug: ${requestedSlug}`,
          assets,
        });
      }
      const match = profile
        ? matchRegisteredAgentForProfile(assets, profile)
        : matchRegisteredAgent(assets);
      const agentIdentifier =
        typeof match?.agentIdentifier === "string" ? match.agentIdentifier : undefined;
      if (agentIdentifier) {
        if (profile) await persistAgentProfileIdentifier(profile.slug, agentIdentifier);
        else await persistAgentIdentifier(agentIdentifier);
      }

      return reply.status(200).send({
        agentSlug: profile?.slug,
        agentIdentifier,
        state: typeof match?.state === "string" ? match.state : undefined,
        matchedAgent: match,
        assets,
        sokosumi:
          loadConfig().masumiNetwork === "Mainnet"
            ? "https://sokosumi.com/agents"
            : "https://preprod.sokosumi.com/agents",
      });
    } catch (e) {
      const status = e instanceof MasumiPaymentError ? e.status : 400;
      return reply.status(status >= 400 && status < 600 ? status : 400).send({
        error: "REGISTRY_STATUS_FAILED",
        message:
          e instanceof MasumiPaymentError
            ? `Masumi Payment HTTP ${e.status}: ${e.bodySnippet}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  });
}
