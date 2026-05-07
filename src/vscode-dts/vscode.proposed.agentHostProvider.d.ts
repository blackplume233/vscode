/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/vscode-dts-cancellation, local/vscode-dts-event-naming, local/vscode-dts-provider-naming, local/vscode-dts-string-type-literals */

declare module 'vscode' {
	export namespace agentHost {
		export function registerProvider(id: string, provider: AgentHostProvider, options?: AgentHostProviderRegistrationOptions): Disposable;
	}

	export interface AgentHostProviderRegistrationOptions {
		readonly apiVersion?: number;
		readonly capabilities?: readonly string[];
	}

	export interface AgentHostProvider {
		readonly displayName?: string;
		readonly description?: string;
		readonly models?: readonly AgentHostModel[];
		readonly onDidProgress: Event<AgentHostProgress>;
		createSession(options?: AgentHostCreateSessionOptions): Thenable<AgentHostSessionMetadata>;
		sendMessage(sessionId: string, message: AgentHostMessage, token?: CancellationToken): Thenable<void>;
		respondToConfirmation(sessionId: string, requestId: string, approved: boolean, optionId?: string): Thenable<void>;
		respondToInputRequest?(sessionId: string, requestId: string, input: string | undefined): Thenable<void>;
		getSessionHistory(sessionId: string): Thenable<readonly unknown[]>;
		listSessions(): Thenable<readonly AgentHostSessionMetadata[]>;
		changeModel(sessionId: string, model: AgentHostModel): Thenable<void>;
		abortSession(sessionId: string): Thenable<void>;
		resolveSessionConfig(options?: AgentHostCreateSessionOptions): Thenable<unknown>;
		sessionConfigCompletions(key: string, query: string, values: Record<string, unknown>): Thenable<readonly unknown[]>;
		disposeSession?(sessionId: string): Thenable<void>;
	}

	export interface AgentHostModel {
		readonly id: string;
		readonly name: string;
		readonly provider?: string;
		readonly maxContextWindow?: number;
		readonly supportsVision?: boolean;
	}

	export interface AgentHostCreateSessionOptions {
		readonly workingDirectory?: Uri;
		readonly workspaceUri?: Uri;
		readonly model?: AgentHostModel;
		readonly config?: Record<string, unknown>;
	}

	export interface AgentHostSessionMetadata {
		readonly id: string;
		readonly uri?: Uri;
		readonly title?: string;
		readonly createdAt?: number;
		readonly updatedAt?: number;
		readonly workspaceUri?: Uri;
		readonly model?: AgentHostModel;
	}

	export interface AgentHostMessage {
		readonly requestId: string;
		readonly text: string;
		readonly parts?: readonly unknown[];
		readonly model?: AgentHostModel;
	}

	export type AgentHostProgress =
		| { readonly type: 'markdownDelta'; readonly sessionId: string; readonly requestId: string; readonly text: string }
		| { readonly type: 'reasoningDelta'; readonly sessionId: string; readonly requestId: string; readonly text: string }
		| { readonly type: 'toolStart'; readonly sessionId: string; readonly requestId: string; readonly toolCallId: string; readonly name: string; readonly title?: string; readonly input?: unknown }
		| { readonly type: 'toolDelta'; readonly sessionId: string; readonly requestId: string; readonly toolCallId: string; readonly inputDelta?: unknown; readonly outputDelta?: unknown; readonly status?: string }
		| { readonly type: 'toolPendingConfirmation'; readonly sessionId: string; readonly requestId: string; readonly toolCallId: string; readonly title: string; readonly message?: string; readonly options?: readonly { readonly id: string; readonly label: string; readonly kind: string }[] }
		| { readonly type: 'toolComplete'; readonly sessionId: string; readonly requestId: string; readonly toolCallId: string; readonly output?: unknown; readonly error?: string }
		| { readonly type: 'inputRequested'; readonly sessionId: string; readonly requestId: string; readonly prompt: string; readonly placeholder?: string }
		| { readonly type: 'turnComplete'; readonly sessionId: string; readonly requestId: string; readonly stopReason?: string }
		| { readonly type: 'turnCancelled'; readonly sessionId: string; readonly requestId: string }
		| { readonly type: 'titleChanged'; readonly sessionId: string; readonly title: string }
		| { readonly type: 'modelChanged'; readonly sessionId: string; readonly model: AgentHostModel }
		| { readonly type: 'usage'; readonly sessionId: string; readonly requestId: string; readonly used: number; readonly size: number; readonly cost?: { readonly amount: number; readonly currency: string } }
		| { readonly type: 'error'; readonly sessionId: string; readonly requestId?: string; readonly message: string; readonly code?: string }
		| { readonly type: 'diffsChanged'; readonly sessionId: string; readonly diffs: readonly unknown[] };
}
