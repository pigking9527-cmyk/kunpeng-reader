import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));
const schema = await readJson("contracts/intelligence/intelligence-v1.schema.json");
const fixture = await readJson("contracts/fixtures/intelligence-publication-bundle.v1.json");
const hostInferenceSchema = await readJson("contracts/intelligence/host-inference-v1.schema.json");
const hostInferenceFixture = await readJson("contracts/fixtures/intelligence-host-inference-v1.json");
const SHA256 = /^[a-f0-9]{64}$/;
const HTTPS_URL = /^https:\/\/[^\s]+$/u;
const MODEL_URL = /(?:https?:\/\/|www\.)/iu;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function bundleSha256(bundle) {
  const unsigned = structuredClone(bundle);
  delete unsigned.bundleSha256;
  return createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex");
}

function signed(bundle) {
  const result = structuredClone(bundle);
  result.bundleSha256 = bundleSha256(result);
  return result;
}

function assertId(value, label) {
  assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, `${label} must be a stable identifier`);
}

function assertNoModelUrl(value, label) {
  assert.equal(MODEL_URL.test(value), false, `${label} must not contain a model-injected URL`);
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function assertEncryptedEnvelope(envelope, expectedRecipient, expectedSender, label) {
  assert.equal(envelope.schemaVersion, 1, `${label} schema version`);
  assert.equal(envelope.suite, "HPKE-v1-X25519-HKDF-SHA256-CHACHA20POLY1305", `${label} suite`);
  assert.equal(envelope.recipientKeyId, expectedRecipient, `${label} recipient binding`);
  assert.equal(envelope.senderKeyId, expectedSender, `${label} sender binding`);
  assert.match(envelope.enc, /^[A-Za-z0-9_-]{16,}$/u, `${label} encapsulated key`);
  assert.match(envelope.ciphertext, /^[A-Za-z0-9_-]{16,}$/u, `${label} must be opaque ciphertext`);
  assert.match(envelope.ciphertextSha256, SHA256, `${label} ciphertext digest`);
  assert.ok(["none", "zstd"].includes(envelope.compression), `${label} compression`);
  for (const forbidden of ["prompt", "context", "text", "book", "answer", "source", "url", "path", "model"]) {
    assert.equal(Object.hasOwn(envelope, forbidden), false, `${label} must not project ${forbidden}`);
  }
}

function validateHostInferenceFixtureV1(value) {
  const defs = hostInferenceSchema.$defs;
  assert.equal(hostInferenceSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(defs?.operation?.enum?.includes("reading_deep_analysis"));
  assert.ok(defs?.operation?.enum?.includes("news_preference"));
  assert.equal(defs?.encryptedEnvelope?.additionalProperties, false);
  assert.ok(defs?.taskState?.enum?.includes("PURGED"));
  assert.ok(defs?.taskState?.enum?.includes("CANCELLED"));

  const { pairingOffer: offer, pairing, request, result, cancel } = value;
  assert.equal(offer.schemaVersion, 1);
  assertId(offer.offerId, "host pairing offer id");
  assertId(offer.hostInstallationId, "host installation id");
  assert.match(offer.hostKeyId, /^key:/u);
  assert.match(offer.hostPublicKey, /^[A-Za-z0-9_-]{16,}$/u);
  assert.match(offer.hostKeyFingerprint, SHA256);
  assertUnique(offer.capabilities, "host capabilities");

  assert.equal(pairing.schemaVersion, 1);
  assertId(pairing.pairId, "host pair id");
  assert.equal(pairing.state, "ACTIVE");
  assert.equal(pairing.hostInstallationId, offer.hostInstallationId);
  assert.equal(pairing.hostKeyId, offer.hostKeyId);
  assert.ok(Number.isInteger(pairing.capabilityRevision) && pairing.capabilityRevision >= 1);
  assertUnique(pairing.capabilities, "paired host capabilities");

  assert.equal(request.schemaVersion, 1);
  assertId(request.taskId, "host task id");
  assert.equal(request.pairId, pairing.pairId);
  assert.ok(pairing.capabilities.includes(request.operation), "task operation must be paired");
  assert.equal(request.capabilityRevision, pairing.capabilityRevision);
  assertEncryptedEnvelope(request.requestEnvelope, pairing.hostKeyId, pairing.clientKeyId, "request envelope");

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.taskId, request.taskId);
  assertEncryptedEnvelope(result.resultEnvelope, pairing.clientKeyId, pairing.hostKeyId, "result envelope");
  assert.equal(cancel.schemaVersion, 1);
  assert.equal(cancel.taskId, request.taskId);
}

// Cross-array references and append-only registry semantics are deliberately
// executable here: portable JSON Schema cannot represent either invariant.
function validatePublicationBundleV1(bundle) {
  assert.equal(bundle.schemaVersion, 1);
  assertId(bundle.publicationId, "publicationId");
  assert.ok(["event", "daily"].includes(bundle.kind));
  assert.equal(new Date(bundle.expiresAt).getTime() - new Date(bundle.publishedAt).getTime(), 30 * 24 * 60 * 60 * 1000);
  assert.match(bundle.bundleSha256, SHA256);
  assert.equal(bundle.bundleSha256, bundleSha256(bundle), "bundleSha256 must cover the complete unsigned canonical bundle");
  assert.ok(Array.isArray(bundle.events) && bundle.events.length > 0);
  assert.ok(Array.isArray(bundle.assets));

  const assetIds = bundle.assets.map((asset) => asset.assetId);
  assertUnique(assetIds, "assetId");
  for (const asset of bundle.assets) {
    assertId(asset.assetId, "assetId");
    assert.equal(asset.kind, "image");
    assert.match(asset.sha256, SHA256);
  }
  const knownAssets = new Set(assetIds);
  const eventIds = bundle.events.map((event) => event.eventId);
  assertUnique(eventIds, "eventId within one immutable bundle");

  for (const event of bundle.events) {
    assertId(event.eventId, "eventId");
    assert.ok(Number.isInteger(event.revisionNo) && event.revisionNo >= 1);
    assertNoModelUrl(event.title, "event title");
    assert.ok(Array.isArray(event.notes) && event.notes.length > 0);
    const noteIds = event.notes.map((note) => note.noteId);
    assertUnique(noteIds, `noteId in ${event.eventId}`);
    const knownNotes = new Set(noteIds);
    for (const note of event.notes) {
      assertId(note.noteId, "noteId");
      assertId(note.sourceId, "sourceId");
      assert.match(note.sourceSha256, SHA256, "note.sourceSha256 must bind evidence to one archived source version");
      assert.match(note.originalUrl, HTTPS_URL, "originalUrl must be host-projected HTTPS");
      assert.ok(Array.isArray(note.paragraphs) && note.paragraphs.length > 0, "note must contain archived paragraph evidence");
      assertUnique(note.paragraphs.map((paragraph) => paragraph.paragraphId), `paragraphId in ${note.noteId}`);
      for (const paragraph of note.paragraphs) {
        assertId(paragraph.paragraphId, "paragraphId");
        assert.match(paragraph.sha256, SHA256, "paragraph evidence must include its immutable SHA-256");
      }
    }
    for (const block of event.blocks) {
      assertId(block.blockId, "blockId");
      if (block.videoUrl !== undefined) assert.match(block.videoUrl, HTTPS_URL, "videoUrl must be HTTPS");
      if (block.mediaIds !== undefined) {
        assertUnique(block.mediaIds, `mediaIds in ${block.blockId}`);
        for (const assetId of block.mediaIds) assert.ok(knownAssets.has(assetId), `mediaId ${assetId} must resolve to an asset`);
      }
      for (const segment of block.segments) {
        assertNoModelUrl(segment.text, "synthesis segment");
        assert.ok(segment.noteIds.length > 0, "each factual segment needs at least one note");
        assertUnique(segment.noteIds, `noteIds in ${block.blockId}`);
        for (const noteId of segment.noteIds) assert.ok(knownNotes.has(noteId), `noteId ${noteId} must resolve within its event`);
      }
    }
  }
}

function validatePublicationAppend(existingByPublicationId, bundle) {
  validatePublicationBundleV1(bundle);
  const existing = existingByPublicationId.get(bundle.publicationId);
  assert.ok(!existing || existing === bundle.bundleSha256, "a publicationId cannot be silently overwritten; correction needs a new immutable publicationId");
}

function assertReject(mutator, label) {
  const mutated = signed(fixture);
  mutator(mutated);
  if (label !== "invalid digest") mutated.bundleSha256 = bundleSha256(mutated);
  assert.throws(() => validatePublicationBundleV1(mutated), undefined, label);
}

const publication = schema.$defs?.publicationBundle;
assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.ok(publication?.required?.includes("bundleSha256"));
assert.equal(schema.$defs?.asset?.properties?.kind?.const, "image");
assert.match(schema.$defs?.httpsUrl?.pattern ?? "", /^\^https:/);
assert.ok(schema.$defs?.archiveRequest?.properties?.state?.enum?.includes("PURGED"));
assert.equal(schema.$defs?.capabilities?.properties?.feedEnabled?.type, "boolean");
assert.equal(schema.$defs?.feedPage?.properties?.nextCursor?.$ref, "#/$defs/cursor");
assert.equal(schema.$defs?.deliveryAck?.properties?.publicationId?.$ref, "#/$defs/id");
assert.deepEqual(schema.$defs?.deviceRegistration?.properties?.platform?.enum, ["windows", "macos", "linux", "android", "ios"]);
assert.equal(schema.$defs?.publisherJob?.properties?.kind?.const, "archive_relay");
assert.equal(schema.$defs?.note?.properties?.sourceSha256?.$ref, "#/$defs/sha256");
assert.equal(schema.$defs?.note?.properties?.paragraphs?.items?.$ref, "#/$defs/paragraphEvidence");
assert.equal(schema.$defs?.modelSynthesis?.additionalProperties, false);
assert.equal(schema.$defs?.modelEventSynthesis?.properties?.originalUrl, undefined);
assert.equal(schema.$defs?.modelBlockSynthesis?.properties?.videoUrl, undefined);

validatePublicationBundleV1(fixture);
validatePublicationAppend(new Map([[fixture.publicationId, fixture.bundleSha256]]), fixture);
assert.throws(() => validatePublicationAppend(new Map([[fixture.publicationId, "0".repeat(64)]]), fixture));
assertReject((bundle) => { bundle.events[0].blocks[0].segments[0].noteIds = ["missing-note"]; }, "unresolvable note ID");
assertReject((bundle) => { bundle.events[0].notes[0].paragraphs = []; }, "note without paragraph evidence");
assertReject((bundle) => { bundle.events[0].notes[0].sourceSha256 = "not-a-sha"; }, "note without source version evidence");
assertReject((bundle) => { bundle.events[0].blocks[0].segments[0].text = "详情见 HTTPS://untrusted.invalid/"; }, "model URL in synthesis text");
assertReject((bundle) => { bundle.events[0].blocks[0].videoUrl = "http://video.invalid/demo"; }, "non-HTTPS video");
assertReject((bundle) => { bundle.events[0].blocks[0].mediaIds = ["missing-asset"]; }, "unresolvable media ID");
assertReject((bundle) => { bundle.events[0].title = "说明 https://untrusted.invalid/"; }, "model URL in title");
assertReject((bundle) => { bundle.bundleSha256 = "0".repeat(64); }, "invalid digest");
validateHostInferenceFixtureV1(hostInferenceFixture);

console.log("intelligence publication and host-inference contract fixture checks passed");
