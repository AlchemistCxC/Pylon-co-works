import type { PluginSessionCreationApi } from '../../../plugin-runtime/session-creation/pluginSessionCreationApi.js';
import type { SessionCreationSnapshot } from '../../../plugin-runtime/session-creation/sessionCreationTypes.js';
export declare const PROFILE_PERSONA_CONTRIBUTION_KIND = "builtin.pylon/profile-persona";
export declare const FIRST_MESSAGE_PHASE = "pylon/session-first-message";
export declare const PROMPT_PRELUDE_ARTIFACT_KIND = "pylon/prompt-prelude";
export declare const WORKSPACE_CAPABILITIES_CONTRIBUTION_KIND = "builtin.pylon/workspace-capabilities";
export declare function registerBuiltinSessionCreationContributions(api: PluginSessionCreationApi): void;
export declare function collectFirstMessagePromptPrelude(snapshot: SessionCreationSnapshot | undefined): string;
export declare function collectProfilePersona(snapshot: SessionCreationSnapshot | undefined): string;
