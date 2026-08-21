import { installAnimationSettings } from "./animation-settings.ts";
import { installOverlayStack } from "./overlay-stack.ts";
import { installSemanticStatusCache } from "./semantic-status-cache.ts";
import { installShelfUiRules } from "./shelf-ui-rules.ts";

const legacyWindow = window as unknown as Window & Record<string, unknown>;

installOverlayStack(legacyWindow);
installAnimationSettings(legacyWindow);
installSemanticStatusCache(legacyWindow);
installShelfUiRules(legacyWindow);
