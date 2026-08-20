import type {
  FeedbackDraft,
  PreparedAttachment,
  SupportPort,
} from "./support-port.js";

declare const port: SupportPort;
declare const image: PreparedAttachment;

const controller = new AbortController();
const draft: FeedbackDraft = {
  kind: "bug",
  text: "The feedback body remains local to the typed port.",
  imageAttachmentIds: [image.id],
};

void port.submitFeedback(draft, controller.signal);
void port.captureRedactedDiagnostics(controller.signal);
void port.loadCurrentReleaseNotes(controller.signal);
void port.ignoreUpdate("1.15.0", controller.signal);
void port.saveRedactedProblemTraceToDesktop(controller.signal);
port.releaseFeedbackAttachments([image.id]);
void port.exportRedactedDiagnostics(controller.signal);

// @ts-expect-error A feature cannot put attachment bytes in a draft.
const unsafeDraft: FeedbackDraft = { kind: "bug", text: "", imageAttachmentIds: [], data: "base64" };
void unsafeDraft;

// @ts-expect-error A feature suggestion cannot include a diagnostic trace.
const unsafeFeatureDraft: FeedbackDraft = { kind: "feature", text: "", imageAttachmentIds: [], diagnosticAttachmentId: image.id };
void unsafeFeatureDraft;

// @ts-expect-error Native access must be injected as a complete typed port.
const incompletePort: SupportPort = { loadAbout: async () => ({ appVersion: "1" }) };
void incompletePort;
