// Provider-published reference (read as source, never executed):
// https://plugins.svn.wordpress.org/saturnshift-for-woocommerce/trunk/includes/class-saturnshift-webhook.php
// This verifies delivery ONLY. Payment/settlement interpretation is not enabled.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;
class SaturnShiftDeliveryError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
function hasDeliverySecret(secret) {
  return typeof secret === "string" && secret.length >= 16 && secret.length <= 512;
}
async function verifySaturnShiftDelivery(request, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!hasDeliverySecret(secret)) throw new SaturnShiftDeliveryError("saturnshift_delivery_secret_not_configured", 503);
  // Reject duplicate timestamps/signatures instead of selecting an ambiguous value.
  const header = request.headers.get("SaturnShift-Signature") || "";
  const match = /^t=([1-9][0-9]{9}),\s*v1=([0-9a-fA-F]{64})$/.exec(header);
  if (!match) throw new SaturnShiftDeliveryError("invalid_saturnshift_delivery_signature", 401);
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - Number(match[1])) > MAX_CLOCK_SKEW_SECONDS) {
    throw new SaturnShiftDeliveryError("stale_saturnshift_delivery", 401);
  }
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    throw new SaturnShiftDeliveryError("saturnshift_delivery_too_large", 413);
  }
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BODY_BYTES) throw new SaturnShiftDeliveryError("saturnshift_delivery_too_large", 413);
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
  const prefix = new TextEncoder().encode(match[1] + ".");
  const signed = new Uint8Array(prefix.length + size);
  signed.set(prefix);
  let offset = prefix.length;
  for (const chunk of chunks) { signed.set(chunk, offset); offset += chunk.byteLength; }
  const signature = Uint8Array.from(match[2].match(/../g), part => Number.parseInt(part, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, signature, signed)) {
    throw new SaturnShiftDeliveryError("invalid_saturnshift_delivery_signature", 401);
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signed.subarray(prefix.length))); }
  catch { throw new SaturnShiftDeliveryError("invalid_saturnshift_delivery_json", 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.type !== "string") {
    throw new SaturnShiftDeliveryError("invalid_saturnshift_delivery_event", 400);
  }
  // The event-ID header is not signed by this scheme. Never use it as payment proof.
  return { type: payload.type };
}
export { hasDeliverySecret, verifySaturnShiftDelivery, SaturnShiftDeliveryError };
