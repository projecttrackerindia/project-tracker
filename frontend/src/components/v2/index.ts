/** The shared pieces of the v2 shell (V2-PLAN §4). Pages import them from here. */
export { Rail, PhoneBar, AvatarMenu } from './Rail';
export { NewSheetHost } from './NewSheet';
export { AskBar, CopilotHost } from './AskBar';
export { SidePanel } from './SidePanel';
export { InboxRow, type InboxKind } from './InboxRow';
export { AiCard } from './AiCard';
export { PlaceTabs } from './PlaceTabs';
export { openNew, useNewSheet, guessType, useCopilot, pageContext, useTabParam, useSaveState, type NewType, type SaveState } from './state';
