/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { MainContext, type ExtHostAgentHostProvidersShape, type MainThreadAgentHostProvidersShape } from './extHost.protocol.js';

interface AgentHostProviderShape {
	readonly displayName?: string;
	readonly description?: string;
	readonly models?: readonly unknown[];
	readonly onDidProgress?: vscode.Event<unknown>;
	createSession(options?: unknown): Thenable<unknown>;
	sendMessage(sessionId: string, message: unknown, token?: vscode.CancellationToken): Thenable<void>;
	respondToConfirmation(sessionId: string, requestId: string, approved: boolean, optionId?: string): Thenable<void>;
	respondToInputRequest?(sessionId: string, requestId: string, input: string | undefined): Thenable<void>;
	getSessionHistory(sessionId: string): Thenable<unknown>;
	listSessions(): Thenable<unknown>;
	changeModel(sessionId: string, model: unknown): Thenable<void>;
	abortSession(sessionId: string): Thenable<void>;
	resolveSessionConfig(options?: unknown): Thenable<unknown>;
	sessionConfigCompletions(key: string, query: string, values: Record<string, unknown>): Thenable<unknown>;
	disposeSession?(sessionId: string): Thenable<void>;
}

interface AgentHostProviderRegistrationOptions {
	readonly apiVersion?: number;
	readonly capabilities?: readonly string[];
}

export class ExtHostAgentHostProviders extends Disposable implements ExtHostAgentHostProvidersShape {
	private readonly _proxy: MainThreadAgentHostProvidersShape;
	private readonly _providers = new Map<number, { readonly id: string; readonly provider: AgentHostProviderShape; readonly disposables: DisposableStore }>();
	private _handlePool = 0;

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadAgentHostProviders);
	}

	registerProvider(id: string, provider: AgentHostProviderShape, options: AgentHostProviderRegistrationOptions = {}): vscode.Disposable {
		const handle = this._handlePool++;
		const disposables = new DisposableStore();
		this._providers.set(handle, { id, provider, disposables });
		if (provider.onDidProgress) {
			disposables.add(provider.onDidProgress(progress => this._proxy.$acceptAgentHostProgress(handle, progress as never)));
		}
		void this._proxy.$registerAgentHostProvider({
			handle,
			id,
			displayName: provider.displayName ?? id,
			description: provider.description ?? provider.displayName ?? id,
			models: Array.isArray(provider.models) ? provider.models as never : [],
			apiVersion: options.apiVersion ?? 1,
			capabilities: options.capabilities ?? ['agentHostProvider'],
		});
		return toDisposable(() => {
			this._unregisterProvider(handle);
		});
	}

	override dispose(): void {
		for (const handle of [...this._providers.keys()]) {
			this._unregisterProvider(handle);
		}
		super.dispose();
	}

	async $handleAgentHostRequest(request: Parameters<ExtHostAgentHostProvidersShape['$handleAgentHostRequest']>[0]): Promise<Awaited<ReturnType<ExtHostAgentHostProvidersShape['$handleAgentHostRequest']>>> {
		const entry = this._providers.get(request.handle);
		if (!entry) {
			return { requestId: request.requestId, ok: false, error: `Agent Host provider not found: ${request.handle}` };
		}
		try {
			const value = await this._callProvider(entry.provider, request.method, request.args);
			return { requestId: request.requestId, ok: true, value };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._logService.error(`[ExtHostAgentHostProviders] ${request.method} failed`, err);
			return { requestId: request.requestId, ok: false, error: message };
		}
	}

	private _callProvider(provider: AgentHostProviderShape, method: string, args: readonly unknown[]): Thenable<unknown> {
		switch (method) {
			case 'createSession': return provider.createSession(args[0]);
			case 'sendMessage': return provider.sendMessage(String(args[0]), args[1]);
			case 'respondToConfirmation': return provider.respondToConfirmation(String(args[0]), String(args[1]), Boolean(args[2]), typeof args[3] === 'string' ? args[3] : undefined);
			case 'respondToInputRequest': return provider.respondToInputRequest?.(String(args[0]), String(args[1]), typeof args[2] === 'string' ? args[2] : undefined) ?? Promise.resolve();
			case 'getSessionHistory': return provider.getSessionHistory(String(args[0]));
			case 'listSessions': return provider.listSessions();
			case 'changeModel': return provider.changeModel(String(args[0]), args[1]);
			case 'abortSession': return provider.abortSession(String(args[0]));
			case 'resolveSessionConfig': return provider.resolveSessionConfig(args[0]);
			case 'sessionConfigCompletions': return provider.sessionConfigCompletions(String(args[0]), String(args[1] ?? ''), (args[2] ?? {}) as Record<string, unknown>);
			case 'disposeSession': return provider.disposeSession?.(String(args[0])) ?? Promise.resolve();
			default: return Promise.reject(new Error(`Unsupported Agent Host provider method: ${method}`));
		}
	}

	private _unregisterProvider(handle: number): void {
		const entry = this._providers.get(handle);
		if (!entry) {
			return;
		}
		this._providers.delete(handle);
		entry.disposables.dispose();
		void this._proxy.$unregisterAgentHostProvider(handle);
	}
}
