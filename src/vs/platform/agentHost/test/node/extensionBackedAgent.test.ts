/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionBackedAgent } from '../../node/extensionBackedAgent.js';
import { AgentSession, type AgentSignal, type ExtensionBackedAgentHostMethod, type IExtensionBackedAgentHostRegistration } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind, SessionInputAnswerState, SessionInputAnswerValueKind, SessionInputResponseKind, ToolCallStatus, TurnState, type ResponsePart } from '../../common/state/sessionState.js';

suite('ExtensionBackedAgent', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const registration: IExtensionBackedAgentHostRegistration = {
		handle: 1,
		id: 'gas',
		displayName: 'GAS',
		description: 'Game Agent Studio',
	};

	test('uses provider-owned canonical session URIs', async () => {
		const agent = disposables.add(new ExtensionBackedAgent(registration, async (_handle, method) => {
			assert.strictEqual(method, 'createSession');
			return { id: 'extension-session-1', uri: { scheme: 'gas-agent-host', path: '/wrong' } };
		}));

		const result = await agent.createSession();

		assert.strictEqual(result.session.toString(), 'gas:/extension-session-1');
		assert.strictEqual(AgentSession.provider(result.session), 'gas');
	});

	test('maps pending confirmation without auto-continuing and returns selected option id', async () => {
		const calls: { method: ExtensionBackedAgentHostMethod; args: readonly unknown[] }[] = [];
		const agent = disposables.add(new ExtensionBackedAgent(registration, async (_handle, method, args) => {
			calls.push({ method, args });
			return undefined;
		}));
		const signals: AgentSignal[] = [];
		const session = AgentSession.uri('gas', 'extension-session-1');

		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));
		agent.acceptProgress({
			type: 'toolPendingConfirmation',
			sessionId: 'extension-session-1',
			requestId: 'turn-1',
			toolCallId: 'tool-1',
			title: 'Run command',
			message: 'Run npm test?',
			options: [
				{ id: 'allow-once', label: 'Allow Once', kind: 'allow_once' },
				{ id: 'skip', label: 'Skip', kind: 'cancel' },
			],
		});
		agent.respondToPermissionRequest('tool-1', true, 'allow-once');

		assert.strictEqual(signals.length, 2);
		assert.strictEqual(signals[0].kind, 'action');
		if (signals[0].kind === 'action') {
			assert.strictEqual(signals[0].action.type, ActionType.SessionToolCallStart);
		}
		assert.strictEqual(signals[1].kind, 'pending_confirmation');
		if (signals[1].kind === 'pending_confirmation') {
			assert.strictEqual(signals[1].session.toString(), session.toString());
			assert.strictEqual(signals[1].state.status, ToolCallStatus.PendingConfirmation);
			assert.strictEqual(signals[1].state.options?.[0]?.label, 'Allow Once');
		}
		assert.deepStrictEqual(calls, [{
			method: 'respondToConfirmation',
			args: ['extension-session-1', 'tool-1', true, 'allow-once'],
		}]);
	});

	test('forwards core IAgent methods to the extension provider', async () => {
		const calls: { method: ExtensionBackedAgentHostMethod; args: readonly unknown[] }[] = [];
		const agent = disposables.add(new ExtensionBackedAgent(registration, async (_handle, method, args) => {
			calls.push({ method, args });
			switch (method) {
				case 'createSession':
					return { id: 'extension-session-1' };
				case 'listSessions':
					return [{ id: 'extension-session-1', title: 'GAS restored', createdAt: 1, updatedAt: 2 }];
				case 'sessionConfigCompletions':
					return [{ label: 'gpt-5.4', value: 'gas-codex/gpt-5.4' }];
				default:
					return undefined;
			}
		}));
		const created = await agent.createSession();

		await agent.sendMessage(created.session, 'hello', [], 'turn-1');
		await agent.abortSession(created.session);
		await agent.changeModel(created.session, { id: 'gas-codex/gpt-5.4' });
		await agent.getSessionMessages(created.session);
		await agent.listSessions();
		await agent.resolveSessionConfig({} as never);
		await agent.sessionConfigCompletions({ property: 'model', query: 'gpt', config: {} } as never);
		await agent.disposeSession(created.session);

		assert.deepStrictEqual(calls.map(call => call.method), [
			'createSession',
			'sendMessage',
			'abortSession',
			'changeModel',
			'getSessionHistory',
			'listSessions',
			'resolveSessionConfig',
			'sessionConfigCompletions',
			'disposeSession',
		]);
		assert.deepStrictEqual(calls.find(call => call.method === 'sendMessage')?.args, [
			'extension-session-1',
			{ requestId: 'turn-1', text: 'hello', attachments: [] },
		]);
	});

	test('maps tool delta and completion progress to native actions', async () => {
		const agent = disposables.add(new ExtensionBackedAgent(registration, async () => undefined));
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		agent.acceptProgress({ type: 'toolStart', sessionId: 'extension-session-1', requestId: 'turn-1', toolCallId: 'tool-1', name: 'shell', title: 'Run command' });
		agent.acceptProgress({ type: 'toolDelta', sessionId: 'extension-session-1', requestId: 'turn-1', toolCallId: 'tool-1', outputDelta: 'hello' });
		agent.acceptProgress({ type: 'toolComplete', sessionId: 'extension-session-1', requestId: 'turn-1', toolCallId: 'tool-1', output: 'done' });

		const actions = signals.filter((signal): signal is Extract<AgentSignal, { kind: 'action' }> => signal.kind === 'action').map(signal => signal.action);
		assert.deepStrictEqual(actions.map(action => action.type), [
			ActionType.SessionToolCallStart,
			ActionType.SessionToolCallDelta,
			ActionType.SessionToolCallComplete,
		]);
	});

	test('maps non-tool progress variants to native actions', async () => {
		const agent = disposables.add(new ExtensionBackedAgent(registration, async () => undefined));
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		agent.acceptProgress({ type: 'markdownDelta', sessionId: 'extension-session-1', requestId: 'turn-1', text: 'hello' });
		agent.acceptProgress({ type: 'reasoningDelta', sessionId: 'extension-session-1', requestId: 'turn-1', text: 'thinking' });
		agent.acceptProgress({ type: 'titleChanged', sessionId: 'extension-session-1', title: 'New title' });
		agent.acceptProgress({ type: 'modelChanged', sessionId: 'extension-session-1', model: { id: 'gas-codex/gpt-5.4' } });
		agent.acceptProgress({ type: 'usage', sessionId: 'extension-session-1', requestId: 'turn-1', used: 1, size: 2 });
		agent.acceptProgress({ type: 'error', sessionId: 'extension-session-1', requestId: 'turn-1', message: 'boom', code: 'QA' });
		agent.acceptProgress({ type: 'diffsChanged', sessionId: 'extension-session-1', diffs: [] });
		agent.acceptProgress({ type: 'turnComplete', sessionId: 'extension-session-1', requestId: 'turn-1' });
		agent.acceptProgress({ type: 'turnCancelled', sessionId: 'extension-session-1', requestId: 'turn-2' });

		const actions = signals.filter((signal): signal is Extract<AgentSignal, { kind: 'action' }> => signal.kind === 'action').map(signal => signal.action);

		assert.deepStrictEqual(actions.map(action => action.type), [
			ActionType.SessionResponsePart,
			ActionType.SessionDelta,
			ActionType.SessionResponsePart,
			ActionType.SessionReasoning,
			ActionType.SessionTitleChanged,
			ActionType.SessionModelChanged,
			ActionType.SessionUsage,
			ActionType.SessionError,
			ActionType.SessionDiffsChanged,
			ActionType.SessionTurnComplete,
			ActionType.SessionTurnCancelled,
		]);
	});

	test('correlates input requests and forwards accepted text', async () => {
		const calls: { method: ExtensionBackedAgentHostMethod; args: readonly unknown[] }[] = [];
		const agent = disposables.add(new ExtensionBackedAgent(registration, async (_handle, method, args) => {
			calls.push({ method, args });
			return undefined;
		}));
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		agent.acceptProgress({ type: 'inputRequested', sessionId: 'extension-session-1', requestId: 'input-1', prompt: 'Name?', placeholder: 'Ada' });
		agent.respondToUserInputRequest('input-1', SessionInputResponseKind.Accept, {
			answer: {
				state: SessionInputAnswerState.Submitted,
				value: { kind: SessionInputAnswerValueKind.Text, value: 'Grace' },
			},
		});

		assert.strictEqual(signals[0]?.kind, 'action');
		assert.deepStrictEqual(calls, [{
			method: 'respondToInputRequest',
			args: ['extension-session-1', 'input-1', 'Grace'],
		}]);
	});

	test('maps extension history into protocol turns with tool cards', async () => {
		const agent = disposables.add(new ExtensionBackedAgent(registration, async (_handle, method) => {
			assert.strictEqual(method, 'getSessionHistory');
			return [{
				id: 'turn-1',
				status: 'completed',
				parts: [
					{ type: 'user', text: 'read package json' },
					{ type: 'markdown', text: 'Reading file.' },
					{ type: 'tool', toolCallId: 'tool-1', name: 'read_file', status: 'completed', input: { path: 'package.json' }, output: 'ok' },
				],
				usage: { inputTokens: 1, outputTokens: 2 },
			}];
		}));

		const turns = await agent.getSessionMessages(AgentSession.uri('gas', 'extension-session-1'));

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0]?.userMessage.text, 'read package json');
		assert.strictEqual(turns[0]?.responseParts[0]?.kind, ResponsePartKind.Markdown);
		assert.strictEqual(turns[0]?.responseParts[1]?.kind, ResponsePartKind.ToolCall);
		const toolPart = turns[0]?.responseParts[1];
		assert.strictEqual(toolPart?.kind === ResponsePartKind.ToolCall ? toolPart.toolCall.status : undefined, ToolCallStatus.Completed);
		assert.strictEqual(turns[0]?.usage?.inputTokens, 1);
	});

	test('maps restored pending skipped failed and usage parts from extension history', async () => {
		const agent = disposables.add(new ExtensionBackedAgent(registration, async (_handle, method) => {
			assert.strictEqual(method, 'getSessionHistory');
			return [{
				id: 'turn-1',
				status: 'cancelled',
				parts: [
					{ type: 'user', text: 'run tools' },
					{ type: 'tool', toolCallId: 'tool-pending', name: 'shell', status: 'pending', input: 'echo pending' },
					{ type: 'tool', toolCallId: 'tool-skipped', name: 'shell', status: 'skipped', input: 'echo skipped' },
					{ type: 'tool', toolCallId: 'tool-failed', name: 'shell', status: 'failed', output: 'stderr', error: 'exit 1' },
					{ type: 'usage', used: 3, size: 5 },
				],
			}];
		}));

		const turns = await agent.getSessionMessages(AgentSession.uri('gas', 'extension-session-1'));
		const toolParts = turns[0]?.responseParts.filter((part): part is Extract<ResponsePart, { kind: ResponsePartKind.ToolCall }> => part.kind === ResponsePartKind.ToolCall) ?? [];

		assert.strictEqual(turns[0]?.state, TurnState.Cancelled);
		assert.strictEqual(turns[0]?.usage?.inputTokens, 3);
		assert.strictEqual(turns[0]?.usage?.outputTokens, 5);
		assert.strictEqual(toolParts[0]?.toolCall.status, ToolCallStatus.PendingConfirmation);
		assert.strictEqual(toolParts[1]?.toolCall.status, ToolCallStatus.Cancelled);
		assert.strictEqual(toolParts[2]?.toolCall.status, ToolCallStatus.Completed);
		assert.strictEqual(toolParts[2]?.toolCall.success, false);
		assert.strictEqual(toolParts[2]?.toolCall.error?.message, 'exit 1');
	});
});
