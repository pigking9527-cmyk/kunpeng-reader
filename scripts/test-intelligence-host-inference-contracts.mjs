import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));
const schema = await readJson("contracts/intelligence/host-inference-v1.schema.json");
const fixture = await readJson("contracts/fixtures/intelligence-host-inference-v1.json");

const sha256 = /^[a-f0-9]{64}$/u;
const opaque = /^[A-Za-z0-9_-]{16,}$/u;
const forbidden = ["prompt", "context", "text", "book", "answer", "source", "url", "path", "model"];

function assertEnvelope(value, sender, recipient, label) {
  assert.equal(value.schemaVersion, 1, `${label} schema`);
  assert.equal(value.suite, "HPKE-v1-X25519-HKDF-SHA256-CHACHA20POLY1305", `${label} suite`);
  assert.equal(value.senderKeyId, sender, `${label} sender`);
  assert.equal(value.recipientKeyId, recipient, `${label} recipient`);
  assert.match(value.enc, opaque, `${label} encapsulated key`);
  assert.match(value.ciphertext, opaque, `${label} ciphertext`);
  assert.match(value.ciphertextSha256, sha256, `${label} ciphertext digest`);
  for (const field of forbidden) assert.equal(Object.hasOwn(value, field), false, `${label} exposes ${field}`);
}

assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(schema.$defs?.encryptedEnvelope?.additionalProperties, false);
assert.deepEqual(schema.$defs?.operation?.enum, [
  "library_answer", "library_compare", "reading_deep_analysis", "reading_memory",
  "news_preference", "news_evidence_review", "companion_prompt",
]);
assert.ok(schema.$defs?.taskState?.enum?.includes("PURGED"));
assert.ok(schema.$defs?.taskState?.enum?.includes("CANCELLED"));

const { pairingOffer: offer, pairing, request, result, cancel } = fixture;
assert.equal(pairing.state, "ACTIVE");
assert.equal(pairing.hostInstallationId, offer.hostInstallationId);
assert.equal(pairing.hostKeyId, offer.hostKeyId);
assert.ok(pairing.capabilities.includes(request.operation));
assert.equal(request.pairId, pairing.pairId);
assert.equal(request.capabilityRevision, pairing.capabilityRevision);
assertEnvelope(request.requestEnvelope, pairing.clientKeyId, pairing.hostKeyId, "request");
assert.equal(result.taskId, request.taskId);
assertEnvelope(result.resultEnvelope, pairing.hostKeyId, pairing.clientKeyId, "result");
assert.equal(cancel.taskId, request.taskId);

console.log("host inference contract fixture checks passed");
