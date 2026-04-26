/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatSendRequestOptions, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChat, ISession, ISessionCapabilities, ISessionType, ISessionWorkspace, ISessionWorkspaceBrowseAction, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionChangeEvent, ISessionsProvider, ISendRequestOptions } from '../../../services/sessions/common/sessionsProvider.js';
import { GAME_AGENT_DEFAULT_MODEL_ID, GAME_AGENT_PROVIDER_ID, GAME_AGENT_SESSION_TYPE, GameAgentSessionType } from '../common/gameAgentTypes.js';

let nextSessionId = 1;

/**
 * Minimal bridge that exposes Game Agent Studio as an ISessionsProvider.
 * All real work is delegated to the GAS extension via commands.
 */
export class GameAgentSessionsProvider extends Disposable implements ISessionsProvider {
	readonly id = GAME_AGENT_PROVIDER_ID;
	readonly label = 'Game Agent Studio';
	readonly icon: ThemeIcon = Codicon.sparkle;

	readonly sessionTypes: readonly ISessionType[] = [GameAgentSessionType];
	readonly onDidChangeSessionTypes = Event.None;

	private readonly _sessions = new Map<string, ISession>();
	private readonly _onDidChangeSessions = this._register(new Emitter<ISessionChangeEvent>());
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	readonly browseActions: readonly ISessionWorkspaceBrowseAction[];

	constructor(
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IChatService private readonly _chatService: IChatService,
	) {
		super();
		this.browseActions = [{
			label: localize('folders', "Folders"),
			icon: Codicon.folderOpened,
			providerId: this.id,
			run: () => this._browseForFolder(),
		}];
	}

	getSessions(): ISession[] {
		return [...this._sessions.values()];
	}

	resolveWorkspace(repositoryUri: URI): ISessionWorkspace {
		return {
			label: basename(repositoryUri) || repositoryUri.fsPath || repositoryUri.toString(),
			icon: Codicon.folder,
			repositories: [{
				uri: repositoryUri,
				workingDirectory: repositoryUri,
				detail: undefined,
				baseBranchName: undefined,
				baseBranchProtected: undefined,
			}],
			requiresWorkspaceTrust: false,
		};
	}

	createNewSession(repositoryUri: URI, sessionTypeId: string): ISession {
		const localId = `gas-${nextSessionId++}`;
		const sessionId = `${this.id}:${localId}`;
		const now = new Date();

		const chatResource = URI.parse(`gas://${localId}/chat/main`);
		const mainChat: IChat = {
			resource: chatResource,
			createdAt: now,
			title: observableValue('chat-title', 'New Chat'),
			updatedAt: observableValue('chat-updatedAt', now),
			status: observableValue('chat-status', SessionStatus.Untitled),
			changes: observableValue('chat-changes', []),
			modelId: observableValue('chat-modelId', GAME_AGENT_DEFAULT_MODEL_ID),
			mode: observableValue('chat-mode', undefined),
			isArchived: observableValue('chat-isArchived', false),
			isRead: observableValue('chat-isRead', true),
			description: observableValue('chat-description', undefined),
			lastTurnEnd: observableValue('chat-lastTurnEnd', undefined),
		};

		const session: ISession = {
			sessionId,
			resource: URI.parse(`gas://${localId}`),
			providerId: this.id,
			sessionType: sessionTypeId || GAME_AGENT_SESSION_TYPE,
			icon: Codicon.sparkle,
			createdAt: now,
			workspace: observableValue('workspace', this.resolveWorkspace(repositoryUri)),
			title: observableValue('title', 'Game Agent Studio'),
			updatedAt: observableValue('updatedAt', now),
			status: observableValue('status', SessionStatus.Untitled),
			changes: observableValue('changes', []),
			modelId: observableValue('modelId', GAME_AGENT_DEFAULT_MODEL_ID),
			mode: observableValue('mode', undefined),
			loading: observableValue('loading', false),
			isArchived: observableValue('isArchived', false),
			isRead: observableValue('isRead', true),
			description: observableValue('description', undefined),
			lastTurnEnd: observableValue('lastTurnEnd', undefined),
			gitHubInfo: observableValue('gitHubInfo', undefined),
			chats: observableValue('chats', [mainChat]),
			mainChat,
			capabilities: { supportsMultipleChats: false } satisfies ISessionCapabilities,
		};

		this._sessions.set(sessionId, session);
		this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });

		return session;
	}

	getSessionTypes(_repositoryUri: URI): ISessionType[] {
		return [GameAgentSessionType];
	}

	async renameChat(_sessionId: string, _chatUri: URI, _title: string): Promise<void> {
		// no-op for now; extension handles internally
	}

	setModel(_sessionId: string, _modelId: string): void {
		// Model changes are handled by the GAS chat session content provider.
	}

	async archiveSession(_sessionId: string): Promise<void> {
		// no-op
	}

	async unarchiveSession(_sessionId: string): Promise<void> {
		// no-op
	}

	async deleteSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			this._sessions.delete(sessionId);
			this._onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
		}
	}

	async deleteChat(_sessionId: string, _chatUri: URI): Promise<void> {
		// single-chat sessions: delete the whole session
		await this.deleteSession(_sessionId);
	}

	async sendAndCreateChat(sessionId: string, options: ISendRequestOptions): Promise<ISession> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		await this._sendToGasChatSession(session, options);
		return session;
	}

	addChat(sessionId: string): IChat {
		const session = this._sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}
		return session.mainChat;
	}

	async sendRequest(sessionId: string, _chatResource: URI, options: ISendRequestOptions): Promise<ISession> {
		return this.sendAndCreateChat(sessionId, options);
	}

	private async _sendToGasChatSession(session: ISession, options: ISendRequestOptions): Promise<void> {
		const sendOptions: IChatSendRequestOptions = {
			location: ChatAgentLocation.Chat,
			userSelectedModelId: GAME_AGENT_DEFAULT_MODEL_ID,
			modeInfo: {
				kind: ChatModeKind.Agent,
				isBuiltin: true,
				modeInstructions: undefined,
				modeId: 'agent',
				applyCodeBlockSuggestionId: undefined,
				permissionLevel: undefined,
			},
			agentIdSilent: GAME_AGENT_SESSION_TYPE,
			attachedContext: options.attachedContext,
		};

		await this._chatSessionsService.getOrCreateChatSession(session.mainChat.resource, CancellationToken.None);
		const chatWidget = await this._chatWidgetService.openSession(session.mainChat.resource, ChatViewPaneTarget);
		if (!chatWidget) {
			throw new Error('[GameAgent] Failed to open GAS chat widget');
		}

		const result = await this._chatService.sendRequest(session.mainChat.resource, options.query, sendOptions);
		if (result.kind === 'rejected') {
			throw new Error(`[GameAgent] sendRequest rejected: ${result.reason}`);
		}
	}

	private async _browseForFolder(): Promise<ISessionWorkspace | undefined> {
		const selected = await this._fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: localize('selectGasFolder', "Select Folder"),
		});
		if (!selected?.[0]) {
			return undefined;
		}
		return this.resolveWorkspace(selected[0]);
	}
}
