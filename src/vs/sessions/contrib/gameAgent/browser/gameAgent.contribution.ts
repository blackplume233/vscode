/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { GameAgentSessionsProvider } from './gameAgentSessionsProvider.js';

/**
 * Registers the {@link GameAgentSessionsProvider} as a sessions provider.
 */
class GameAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.gameAgentProvider';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
	) {
		super();

		const provider = this._register(instantiationService.createInstance(GameAgentSessionsProvider));
		this._register(sessionsProvidersService.registerProvider(provider));
	}
}

registerWorkbenchContribution2(GameAgentContribution.ID, GameAgentContribution, WorkbenchPhase.AfterRestored);
