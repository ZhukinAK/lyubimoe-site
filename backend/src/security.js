import crypto from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export async function hashPassword(password) {
  return hash(password, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32
  });
}

export async function verifyPassword(passwordHash, password) {
  return verify(passwordHash, password);
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const separator = part.indexOf("=");
      return [decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))];
    })
  );
}

export function sessionCookie(token, domain, maxAge = SESSION_TTL_MS / 1000) {
  const parts = [
    `lyubimoe_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`
  ];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join("; ");
}
