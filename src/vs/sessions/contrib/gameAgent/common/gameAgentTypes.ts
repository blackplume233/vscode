/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ISessionType } from '../../../services/sessions/common/session.js';

export const GAME_AGENT_PROVIDER_ID = 'game-agent';

export const GAME_AGENT_SESSION_TYPE = 'gas';

export const GAME_AGENT_DEFAULT_MODEL_ID = 'gas-codex/gpt-5.4';

export const GameAgentSessionType: ISessionType = {
	id: GAME_AGENT_SESSION_TYPE,
	label: 'Game Agent Studio',
	icon: Codicon.sparkle,
};

export const GAS_COMMANDS = {
	createSession: 'gas.internal.createSession',
	sendRequest: 'gas.internal.sendRequest',
	listSessions: 'gas.internal.listSessions',
	deleteSession: 'gas.internal.deleteSession',
	setModel: 'gas.internal.setModel',
} as const;
