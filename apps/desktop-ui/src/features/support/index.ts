export type {
  AboutInfo,
  BugFeedbackDraft,
  CurrentReleaseNotes,
  DiagnosticsSummary,
  FeedbackDraft,
  FeedbackKind,
  FeatureFeedbackDraft,
  FeedbackSubmission,
  PreparedAttachment,
  SupportPort,
  UpdateInfo,
} from "./support-port.js";
export {
  createSupportController,
  legacySupportDomIds,
  type SupportController,
  type SupportLoadPhase,
  type SupportRenderer,
  type SupportUpdatePhase,
  type SupportViewState,
} from "./support-controller.js";
