import {
  UI_ROOT_CLASS,
  type InteractiveState,
  type UiControlContract,
  type UiTheme,
  interactiveAttributes,
  uiRootAttributes,
} from "../src/index.js";

const theme: UiTheme = "dark";
const state: InteractiveState = "loading";
const control: UiControlContract = { ariaLabel: "关闭", state, tone: "neutral" };

const root = uiRootAttributes(theme);
const interactive = interactiveAttributes();

void control;
void root;
void interactive;
void UI_ROOT_CLASS;
