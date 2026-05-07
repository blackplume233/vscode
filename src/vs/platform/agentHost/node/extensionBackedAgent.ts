/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { observableValue } from '../../../base/common/observable.js';
import { hasKey } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ActionType, type SessionAction } from '../common/state/sessionActions.js';
import { ResponsePartKind, SessionInputAnswerState, SessionInputAnswerValueKind, SessionInputQuestionKind, SessionInputResponseKind, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ModelSelection, type ResponsePart, type SessionInputAnswer, type ToolCallState, type Turn } from '../common/state/sessionState.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../common/state/protocol/commands.js';
import { ConfirmationOptionKind } from '../common/state/protocol/state.js';
import {
	AgentSession,
	type AgentSignal,
	type ExtensionBackedAgentHostMethod,
	type ExtensionBackedAgentHostProgress,
	type IAgent,
	type IAgentAttachment,
	type IAgentCreateSessionConfig,
	type IAgentCreateSessionResult,
	type IAgentDescriptor,
	type IAgentModelInfo,
	type IAgentResolveSessionConfigParams,
	type IAgentSessionConfigCompletionsParams,
	type IAgentSessionMetadata,
	type IExtensionBackedAgentHostRegistration,
} from '../common/agentService.js';

type Requester = (handle: number, method: ExtensionBackedAgentHostMethod, args: readonly unknown[]) => Promise<unknown>;

type ExtensionBackedAgentHostTurn = {
	readonly id?: string;
	readonly requestId?: string;
	readonly parts?: readonly ExtensionBackedAgentHostTurnPart[];
	readonly status?: string;
	readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
};

type ExtensionBackedAgentHostTurnPart =
	| { readonly type: 'user'; readonly text?: string }
	| { readonly type: 'markdown'; readonly text?: string }
	| { readonly type: 'reasoning'; readonly text?: string }
	| { readonly type: 'tool'; readonly toolCallId?: string; readonly name?: string; readonly status?: string; readonly input?: unknown; readonly output?: unknown; readonly error?: string }
	| { readonly type: 'usage'; readonly used?: number; readonly size?: number }
	| { readonly type: 'error'; readonly message?: string; readonly code?: string };

export class ExtensionBackedAgent extends Disposable implements IAgent {
	readonly id: string;
	readonly models: ReturnType<typeof observableValue<readonly IAgentModelInfo[]>>;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _sessionToExtensionId = new Map<string, string>();
	private readonly _toolCallToExtensionSessionId = new Map<string, string>();
	private readonly _inputRequestToExtensionSessionId = new Map<string, string>();
	private readonly _turnParts = new Map<string, { markdownPartId?: string; reasoningPartId?: string }>();
	private readonly _startedToolCalls = new Set<string>();

	constructor(
		private readonly _registration: IExtensionBackedAgentHostRegistration,
		private readonly _request: Requester,
	) {
		super();
		this.id = _registration.id;
		this.models = observableValue<readonly IAgentModelInfo[]>('extensionBackedAgentModels', _registration.models ?? []);
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
		const result = await this._request(this._registration.handle, 'createSession', [config]) as {
			id?: string;
			uri?: URI | { scheme: string; authority?: string; path: string };
			title?: string;
			workspaceUri?: URI;
			model?: ModelSelection;
		};
		const session = config?.session ?? AgentSession.uri(this.id, result.id ?? generateUuid());
		const extensionSessionId = result.id ?? AgentSession.id(session) ?? generateUuid();
		this._sessionToExtensionId.set(session.toString(), extensionSessionId);
		return {
			session,
			workingDirectory: result.workspaceUri ? URI.revive(result.workspaceUri) : config?.workingDirectory,
		};
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		const result = await this._request(this._registration.handle, 'resolveSessionConfig', [params]);
		return (result ?? { schema: { type: 'object', properties: {} }, values: {} }) as ResolveSessionConfigResult;
	}

	async sessionConfigCompletions(params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		const result = await this._request(this._registration.handle, 'sessionConfigCompletions', [params.property, params.query ?? '', params.config ?? {}]);
		return this._mapSessionConfigCompletions(result);
	}

	async sendMessage(session: URI, prompt: string, attachments?: IAgentAttachment[], turnId?: string): Promise<void> {
		const requestId = turnId ?? generateUuid();
		this._turnParts.delete(this._turnKey(session, requestId));
		await this._request(this._registration.handle, 'sendMessage', [
			this._extensionSessionId(session),
			{ requestId, text: prompt, attachments },
		]);
	}

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const result = await this._request(this._registration.handle, 'getSessionHistory', [this._extensionSessionId(session)]);
		return Array.isArray(result) ? result.map((turn, index) => this._mapTurn(turn as ExtensionBackedAgentHostTurn, index)) : [];
	}

	async disposeSession(session: URI): Promise<void> {
		await this._request(this._registration.handle, 'disposeSession', [this._extensionSessionId(session)]);
		this._forgetSession(session);
	}

	async abortSession(session: URI): Promise<void> {
		await this._request(this._registration.handle, 'abortSession', [this._extensionSessionId(session)]);
	}

	async changeModel(session: URI, model: ModelSelection): Promise<void> {
		await this._request(this._registration.handle, 'changeModel', [this._extensionSessionId(session), model]);
	}

	respondToPermissionRequest(requestId: string, approved: boolean, selectedOptionId?: string): void {
		void this._request(this._registration.handle, 'respondToConfirmation', [this._toolCallToExtensionSessionId.get(requestId) ?? '', requestId, approved, selectedOptionId]);
	}

	respondToUserInputRequest(requestId: string, response: SessionInputResponseKind, answers?: Record<string, SessionInputAnswer>): void {
		void this._request(this._registration.handle, 'respondToInputRequest', [this._inputRequestToExtensionSessionId.get(requestId) ?? '', requestId, this._getInputResponseText(response, answers)]);
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: this._registration.displayName,
			description: this._registration.description ?? this._registration.displayName,
		};
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		const result = await this._request(this._registration.handle, 'listSessions', []);
		if (!Array.isArray(result)) {
			return [];
		}
		return result.map((item) => {
			const record = item as { id?: string; uri?: URI; title?: string; createdAt?: number; updatedAt?: number; workspaceUri?: URI; model?: ModelSelection; status?: unknown };
			const extensionSessionId = record.id ?? generateUuid();
			const session = AgentSession.uri(this.id, extensionSessionId);
			this._sessionToExtensionId.set(session.toString(), extensionSessionId);
			return {
				session,
				startTime: record.createdAt ?? Date.now(),
				modifiedTime: record.updatedAt ?? Date.now(),
				summary: record.title,
				workingDirectory: record.workspaceUri ? URI.revive(record.workspaceUri) : undefined,
				model: record.model,
			};
		});
	}

	getProtectedResources(): [] { return []; }
	async authenticate(): Promise<boolean> { return true; }
	async shutdown(): Promise<void> { }
	setClientCustomizations(): Promise<[]> { return Promise.resolve([]); }
	setClientTools(): void { }
	onClientToolCallComplete(): void { }
	setCustomizationEnabled(): void { }

	acceptProgress(progress: ExtensionBackedAgentHostProgress): void {
		const session = AgentSession.uri(this.id, progress.sessionId);
		this._sessionToExtensionId.set(session.toString(), progress.sessionId);
		const turnId = hasKey(progress, { requestId: true }) && typeof progress.requestId === 'string' ? progress.requestId : generateUuid();
		const action = this._progressToAction(session, turnId, progress);
		if (action) {
			this._onDidSessionProgress.fire({ kind: 'action', session, action });
		}
		if (progress.type === 'toolPendingConfirmation') {
			const toolKey = this._toolKey(session, progress.toolCallId);
			if (!this._startedToolCalls.has(toolKey)) {
				this._startedToolCalls.add(toolKey);
				this._onDidSessionProgress.fire({
					kind: 'action',
					session,
					action: {
						type: ActionType.SessionToolCallStart,
						session: session.toString(),
						turnId,
						toolCallId: progress.toolCallId,
						toolName: progress.toolCallId,
						displayName: progress.title,
					},
				});
			}
			this._toolCallToExtensionSessionId.set(progress.toolCallId, progress.sessionId);
			this._onDidSessionProgress.fire({
				kind: 'pending_confirmation',
				session,
				state: {
					status: ToolCallStatus.PendingConfirmation,
					toolCallId: progress.toolCallId,
					toolName: progress.toolCallId,
					displayName: progress.title,
					invocationMessage: progress.message ?? progress.title,
					confirmationTitle: progress.title,
					options: progress.options?.map(option => ({
						id: option.id,
						label: option.label,
						kind: option.kind.startsWith('allow') ? ConfirmationOptionKind.Approve : ConfirmationOptionKind.Deny,
					})),
				},
				permissionKind: 'custom-tool',
			});
		}
	}

	private _progressToAction(session: URI, turnId: string, progress: ExtensionBackedAgentHostProgress): SessionAction | undefined {
		switch (progress.type) {
			case 'markdownDelta': {
				const partId = this._getOrCreatePart(session, turnId, 'markdown');
				return { type: ActionType.SessionDelta, session: session.toString(), turnId, partId, content: progress.text };
			}
			case 'reasoningDelta': {
				const partId = this._getOrCreatePart(session, turnId, 'reasoning');
				return { type: ActionType.SessionReasoning, session: session.toString(), turnId, partId, content: progress.text };
			}
			case 'toolStart':
				this._startedToolCalls.add(this._toolKey(session, progress.toolCallId));
				return { type: ActionType.SessionToolCallStart, session: session.toString(), turnId, toolCallId: progress.toolCallId, toolName: progress.name, displayName: progress.title ?? progress.name };
			case 'toolDelta':
				return { type: ActionType.SessionToolCallDelta, session: session.toString(), turnId, toolCallId: progress.toolCallId, content: typeof progress.inputDelta === 'string' ? progress.inputDelta : JSON.stringify(progress.inputDelta ?? progress.outputDelta ?? '') };
			case 'toolComplete':
				return {
					type: ActionType.SessionToolCallComplete,
					session: session.toString(),
					turnId,
					toolCallId: progress.toolCallId,
					result: {
						success: !progress.error,
						pastTenseMessage: progress.error ? 'Failed' : 'Completed',
						content: progress.output === undefined ? [] : [{ type: ToolResultContentType.Text, text: typeof progress.output === 'string' ? progress.output : JSON.stringify(progress.output) }],
						error: progress.error ? { message: progress.error } : undefined,
					},
				};
			case 'turnComplete':
				return { type: ActionType.SessionTurnComplete, session: session.toString(), turnId };
			case 'turnCancelled':
				return { type: ActionType.SessionTurnCancelled, session: session.toString(), turnId };
			case 'titleChanged':
				return { type: ActionType.SessionTitleChanged, session: session.toString(), title: progress.title };
			case 'modelChanged':
				return { type: ActionType.SessionModelChanged, session: session.toString(), model: progress.model };
			case 'usage':
				return { type: ActionType.SessionUsage, session: session.toString(), turnId, usage: { inputTokens: progress.used, outputTokens: progress.size } };
			case 'error':
				return { type: ActionType.SessionError, session: session.toString(), turnId: progress.requestId ?? turnId, error: { errorType: progress.code ?? 'extensionBackedAgent', message: progress.message } };
			case 'diffsChanged':
				return { type: ActionType.SessionDiffsChanged, session: session.toString(), diffs: [...progress.diffs] };
			case 'inputRequested':
				this._inputRequestToExtensionSessionId.set(progress.requestId, progress.sessionId);
				return {
					type: ActionType.SessionInputRequested,
					session: session.toString(),
					request: {
						id: progress.requestId,
						message: progress.prompt,
						questions: [{
							kind: SessionInputQuestionKind.Text,
							id: `${progress.requestId}:input`,
							message: progress.prompt,
							required: true,
							defaultValue: progress.placeholder,
						}],
					},
				};
			default:
				return undefined;
		}
	}

	private _getOrCreatePart(session: URI, turnId: string, kind: 'markdown' | 'reasoning'): string {
		const key = this._turnKey(session, turnId);
		const existing = this._turnParts.get(key) ?? {};
		const current = kind === 'markdown' ? existing.markdownPartId : existing.reasoningPartId;
		if (current) {
			return current;
		}
		const partId = generateUuid();
		this._turnParts.set(key, kind === 'markdown' ? { ...existing, markdownPartId: partId } : { ...existing, reasoningPartId: partId });
		const part: ResponsePart = kind === 'markdown'
			? { kind: ResponsePartKind.Markdown, id: partId, content: '' }
			: { kind: ResponsePartKind.Reasoning, id: partId, content: '' };
		this._onDidSessionProgress.fire({
			kind: 'action',
			session,
			action: { type: ActionType.SessionResponsePart, session: session.toString(), turnId, part },
		});
		return partId;
	}

	private _turnKey(session: URI, turnId: string): string {
		return `${session.toString()}:${turnId}`;
	}

	private _toolKey(session: URI, toolCallId: string): string {
		return `${session.toString()}:${toolCallId}`;
	}

	private _forgetSession(session: URI): void {
		const sessionKey = session.toString();
		this._sessionToExtensionId.delete(sessionKey);
		for (const key of [...this._turnParts.keys()]) {
			if (key.startsWith(`${sessionKey}:`)) {
				this._turnParts.delete(key);
			}
		}
		for (const key of [...this._startedToolCalls]) {
			if (key.startsWith(`${sessionKey}:`)) {
				this._startedToolCalls.delete(key);
			}
		}
	}

	private _mapSessionConfigCompletions(value: unknown): SessionConfigCompletionsResult {
		const items = Array.isArray(value)
			? value
			: typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items)
				? (value as { items: unknown[] }).items
				: [];
		return {
			items: items.map(item => {
				const record = typeof item === 'object' && item !== null ? item as { value?: unknown; label?: unknown; description?: unknown } : {};
				const value = record.value === undefined ? record.label : record.value;
				return {
					value: typeof value === 'string' ? value : JSON.stringify(value ?? ''),
					label: typeof record.label === 'string' ? record.label : String(value ?? ''),
					description: typeof record.description === 'string' ? record.description : undefined,
				};
			}),
		};
	}

	private _mapTurn(value: ExtensionBackedAgentHostTurn, index: number): Turn {
		const parts = value.parts ?? [];
		const userPart = parts.find(part => part.type === 'user') as Extract<ExtensionBackedAgentHostTurnPart, { type: 'user' }> | undefined;
		const errorPart = parts.find(part => part.type === 'error') as Extract<ExtensionBackedAgentHostTurnPart, { type: 'error' }> | undefined;
		const usagePart = parts.find(part => part.type === 'usage') as Extract<ExtensionBackedAgentHostTurnPart, { type: 'usage' }> | undefined;
		return {
			id: value.id ?? value.requestId ?? `extension-turn-${index}`,
			userMessage: { text: userPart?.text ?? '' },
			responseParts: parts.flatMap((part, partIndex) => this._mapTurnPart(part, value.id ?? value.requestId ?? `extension-turn-${index}`, partIndex)),
			usage: value.usage ? { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens } : usagePart ? { inputTokens: usagePart.used, outputTokens: usagePart.size } : undefined,
			state: this._mapTurnState(value.status),
			error: errorPart ? { errorType: errorPart.code ?? 'extensionBackedAgent', message: errorPart.message ?? 'Agent Host runtime error' } : undefined,
		};
	}

	private _mapTurnPart(part: ExtensionBackedAgentHostTurnPart, turnId: string, index: number): ResponsePart[] {
		switch (part.type) {
			case 'markdown':
				return [{ kind: ResponsePartKind.Markdown, id: `${turnId}:markdown:${index}`, content: part.text ?? '' }];
			case 'reasoning':
				return [{ kind: ResponsePartKind.Reasoning, id: `${turnId}:reasoning:${index}`, content: part.text ?? '' }];
			case 'tool': {
				const toolCallId = part.toolCallId ?? `${turnId}:tool:${index}`;
				const toolName = part.name ?? toolCallId;
				return [{
					kind: ResponsePartKind.ToolCall,
					toolCall: this._mapToolCall(part, toolCallId, toolName),
				}];
			}
			default:
				return [];
		}
	}

	private _mapToolCall(part: Extract<ExtensionBackedAgentHostTurnPart, { type: 'tool' }>, toolCallId: string, toolName: string): ToolCallState {
		const base = {
			toolCallId,
			toolName,
			displayName: toolName,
			invocationMessage: toolName,
			toolInput: this._stringify(part.input),
		};
		switch (part.status) {
			case 'completed':
			case 'failed':
				return {
					...base,
					status: ToolCallStatus.Completed,
					confirmed: ToolCallConfirmationReason.UserAction,
					success: part.status !== 'failed',
					pastTenseMessage: part.status === 'failed' ? 'Failed' : 'Completed',
					content: part.output === undefined ? [] : [{ type: ToolResultContentType.Text, text: this._stringify(part.output) }],
					error: part.status === 'failed' ? { message: (part.error ?? this._stringify(part.output)) || 'Tool failed' } : undefined,
				};
			case 'skipped':
			case 'cancelled':
				return {
					...base,
					status: ToolCallStatus.Cancelled,
					reason: ToolCallCancellationReason.Skipped,
				};
			case 'pending':
			case 'pending-confirmation':
				return {
					...base,
					status: ToolCallStatus.PendingConfirmation,
					confirmationTitle: toolName,
				};
			case 'running':
				return {
					...base,
					status: ToolCallStatus.Running,
					confirmed: ToolCallConfirmationReason.NotNeeded,
				};
			default:
				return {
					toolCallId,
					toolName,
					displayName: toolName,
					status: ToolCallStatus.Streaming,
					partialInput: this._stringify(part.input),
					invocationMessage: toolName,
				};
		}
	}

	private _mapTurnState(status: string | undefined): TurnState {
		if (status === 'cancelled') {
			return TurnState.Cancelled;
		}
		if (status === 'failed') {
			return TurnState.Error;
		}
		return TurnState.Complete;
	}

	private _getInputResponseText(response: SessionInputResponseKind, answers: Record<string, SessionInputAnswer> | undefined): string | undefined {
		if (response !== SessionInputResponseKind.Accept || !answers) {
			return undefined;
		}
		for (const answer of Object.values(answers)) {
			if (answer.state === SessionInputAnswerState.Skipped) {
				continue;
			}
			switch (answer.value.kind) {
				case SessionInputAnswerValueKind.Text:
				case SessionInputAnswerValueKind.Selected:
					return answer.value.value;
				case SessionInputAnswerValueKind.Number:
					return String(answer.value.value);
				case SessionInputAnswerValueKind.Boolean:
					return answer.value.value ? 'true' : 'false';
				case SessionInputAnswerValueKind.SelectedMany:
					return answer.value.value.join('\n');
			}
		}
		return '';
	}

	private _stringify(value: unknown): string {
		if (value === undefined || value === null) {
			return '';
		}
		return typeof value === 'string' ? value : JSON.stringify(value);
	}

	private _extensionSessionId(session: URI): string {
		return this._sessionToExtensionId.get(session.toString()) ?? AgentSession.id(session);
	}
}
