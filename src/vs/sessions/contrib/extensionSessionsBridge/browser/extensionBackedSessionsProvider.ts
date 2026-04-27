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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatSendRequestOptions, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChat, ISession, ISessionCapabilities, ISessionType, ISessionWorkspace, ISessionWorkspaceBrowseAction, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionChangeEvent, ISessionsProvider, ISendRequestOptions } from '../../../services/sessions/common/sessionsProvider.js';
import { BrowseActionInfo, ProviderInfo, SESSION_BRIDGE_COMMANDS, SessionTypeInfo, WorkspaceInfo } from '../common/extensionSessionsProtocol.js';

let nextSessionId = 1;

/**
 * Generic Sessions provider backed by an extension via the command-bridge protocol.
 *
 * The provider delegates metadata, session types, and workspace resolution to the
 * extension through the SESSION_BRIDGE_COMMANDS protocol.  Workbench-internal
 * operations that require main-thread services (IChatService, IChatWidgetService)
 * remain here so that the extension never needs direct Workbench API access.
 *
 * To wire up a new extension-backed provider:
 *  1. Set `product.json.defaultChatAgent.nativeSessionsProviderId` to the provider id.
 *  2. Register the SESSION_BRIDGE_COMMANDS commands in the extension.
 *  3. The extensionSessionsBridge.contribution.ts contribution will automatically
 *     create and register an ExtensionBackedSessionsProvider.
 */
export class ExtensionBackedSessionsProvider extends Disposable implements ISessionsProvider {

	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;

	private _sessionTypes: ISessionType[] = [];
	get sessionTypes(): readonly ISessionType[] { return this._sessionTypes; }
	private readonly _onDidChangeSessionTypes = this._register(new Emitter<void>());
	readonly onDidChangeSessionTypes = this._onDidChangeSessionTypes.event;

	private readonly _sessions = new Map<string, ISession>();
	private readonly _onDidChangeSessions = this._register(new Emitter<ISessionChangeEvent>());
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private _browseActions: ISessionWorkspaceBrowseAction[] = [];
	get browseActions(): readonly ISessionWorkspaceBrowseAction[] { return this._browseActions; }

	/** Default model id forwarded to IChatService. Overridable per-session via setModel. */
	private readonly _defaultModelId: string;

	constructor(
		providerId: string,
		providerInfo: ProviderInfo,
		defaultModelId: string,
		@ICommandService private readonly _commandService: ICommandService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IChatService private readonly _chatService: IChatService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this.id = providerId;
		this.label = providerInfo.label;
		this.icon = ThemeIcon.fromId(providerInfo.iconId) ?? Codicon.sparkle;
		this._defaultModelId = defaultModelId;
	}

	/**
	 * Refreshes session types and browse actions from the extension.
	 * Called once after construction and whenever the extension signals a change.
	 */
	async refresh(): Promise<void> {
		await Promise.all([this._refreshSessionTypes(), this._refreshBrowseActions()]);
	}

	private async _refreshSessionTypes(): Promise<void> {
		try {
			const types: SessionTypeInfo[] = await this._commandService.executeCommand(
				SESSION_BRIDGE_COMMANDS.getSessionTypes,
				{}
			) ?? [];
			this._sessionTypes = types.map(t => ({
				id: t.id,
				label: t.label,
				icon: t.iconId ? (ThemeIcon.fromId(t.iconId) ?? Codicon.sparkle) : Codicon.sparkle,
			}));
			this._onDidChangeSessionTypes.fire();
		} catch (err) {
			this._logService.warn('[ExtensionSessionsBridge] getSessionTypes failed:', err);
		}
	}

	private async _refreshBrowseActions(): Promise<void> {
		try {
			const actions: BrowseActionInfo[] = await this._commandService.executeCommand(
				SESSION_BRIDGE_COMMANDS.getBrowseActions,
				{}
			) ?? [];
			this._browseActions = actions.map(a => ({
				label: a.label,
				icon: a.iconId ? (ThemeIcon.fromId(a.iconId) ?? Codicon.folderOpened) : Codicon.folderOpened,
				providerId: a.providerId,
				run: () => this._runBrowseAction(a.id),
			}));
		} catch (err) {
			// Fall back to a built-in folder picker if the extension doesn't provide browse actions.
			this._browseActions = [{
				label: localize('folders', 'Folders'),
				icon: Codicon.folderOpened,
				providerId: this.id,
				run: () => this._browseForFolder(),
			}];
			this._logService.debug('[ExtensionSessionsBridge] getBrowseActions failed, using default folder picker:', err);
		}
	}

	private async _runBrowseAction(actionId: string): Promise<ISessionWorkspace | undefined> {
		try {
			const result: WorkspaceInfo | undefined = await this._commandService.executeCommand(
				SESSION_BRIDGE_COMMANDS.runBrowseAction,
				{ actionId }
			);
			if (!result) { return undefined; }
			return this.resolveWorkspace(URI.parse(result.folderUri));
		} catch (err) {
			this._logService.warn('[ExtensionSessionsBridge] runBrowseAction failed:', err);
			return undefined;
		}
	}

	private async _browseForFolder(): Promise<ISessionWorkspace | undefined> {
		const selected = await this._fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: localize('selectFolder', 'Select Folder'),
		});
		if (!selected?.[0]) { return undefined; }
		return this.resolveWorkspace(selected[0]);
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
		const localId = `ext-${nextSessionId++}`;
		const sessionId = `${this.id}:${localId}`;
		const now = new Date();

		const chatResource = URI.parse(`${this.id}://${localId}/chat/main`);
		const mainChat: IChat = {
			resource: chatResource,
			createdAt: now,
			title: observableValue('chat-title', 'New Chat'),
			updatedAt: observableValue('chat-updatedAt', now),
			status: observableValue('chat-status', SessionStatus.Untitled),
			changes: observableValue('chat-changes', []),
			modelId: observableValue('chat-modelId', this._defaultModelId),
			mode: observableValue('chat-mode', undefined),
			isArchived: observableValue('chat-isArchived', false),
			isRead: observableValue('chat-isRead', true),
			description: observableValue('chat-description', undefined),
			lastTurnEnd: observableValue('chat-lastTurnEnd', undefined),
		};

		const sessionType = sessionTypeId || this._sessionTypes[0]?.id || this.id;
		const session: ISession = {
			sessionId,
			resource: URI.parse(`${this.id}://${localId}`),
			providerId: this.id,
			sessionType,
			icon: this.icon,
			createdAt: now,
			workspace: observableValue('workspace', this.resolveWorkspace(repositoryUri)),
			title: observableValue('title', this.label),
			updatedAt: observableValue('updatedAt', now),
			status: observableValue('status', SessionStatus.Untitled),
			changes: observableValue('changes', []),
			modelId: observableValue('modelId', this._defaultModelId),
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
		return [...this._sessionTypes];
	}

	async renameChat(_sessionId: string, _chatUri: URI, _title: string): Promise<void> {
		// Lifecycle managed in extension side; no-op for now.
	}

	setModel(sessionId: string, modelId: string): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			(session.modelId as ReturnType<typeof observableValue<string>>).set(modelId, undefined);
		}
	}

	async archiveSession(_sessionId: string): Promise<void> {
		// no-op for PoC
	}

	async unarchiveSession(_sessionId: string): Promise<void> {
		// no-op for PoC
	}

	async deleteSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			this._sessions.delete(sessionId);
			this._onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
		}
	}

	async deleteChat(_sessionId: string, _chatUri: URI): Promise<void> {
		await this.deleteSession(_sessionId);
	}

	async sendAndCreateChat(sessionId: string, options: ISendRequestOptions): Promise<ISession> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}
		await this._sendToExtensionSession(session, options);
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

	private async _sendToExtensionSession(session: ISession, options: ISendRequestOptions): Promise<void> {
		const sessionType = session.sessionType;
		const sendOptions: IChatSendRequestOptions = {
			location: ChatAgentLocation.Chat,
			userSelectedModelId: this._defaultModelId,
			modeInfo: {
				kind: ChatModeKind.Agent,
				isBuiltin: true,
				modeInstructions: undefined,
				modeId: 'agent',
				applyCodeBlockSuggestionId: undefined,
				permissionLevel: undefined,
			},
			agentIdSilent: sessionType,
			attachedContext: options.attachedContext,
		};

		await this._chatSessionsService.getOrCreateChatSession(session.mainChat.resource, CancellationToken.None);
		const chatWidget = await this._chatWidgetService.openSession(session.mainChat.resource, ChatViewPaneTarget);
		if (!chatWidget) {
			throw new Error(`[ExtensionSessionsBridge] Failed to open chat widget for session ${session.sessionId}`);
		}

		const result = await this._chatService.sendRequest(session.mainChat.resource, options.query, sendOptions);
		if (result.kind === 'rejected') {
			throw new Error(`[ExtensionSessionsBridge] sendRequest rejected: ${result.reason}`);
		}
	}
}
