/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ExtensionBackedSessionsProvider } from './extensionBackedSessionsProvider.js';
import { ProviderInfo, SESSION_BRIDGE_COMMANDS } from '../common/extensionSessionsProtocol.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Activation command id called by the extension to signal its provider is ready.
 *
 * Usage from the extension side:
 *   await vscode.commands.executeCommand('_sessions.bridge.activate', 'game-agent');
 */
export const SESSIONS_BRIDGE_ACTIVATE_COMMAND = '_sessions.bridge.activate';

/**
 * Registers an {@link ExtensionBackedSessionsProvider} when
 * `product.json.defaultChatAgent.nativeSessionsProviderId` is set.
 *
 * The lifecycle is:
 *   1. This contribution registers the `_sessions.bridge.activate` command.
 *   2. Extension activates, registers SESSION_BRIDGE_COMMANDS, then calls
 *      `vscode.commands.executeCommand('_sessions.bridge.activate', providerId)`.
 *   3. The command handler creates and registers the provider.
 *
 * This design is generic — any extension implementing SESSION_BRIDGE_COMMANDS
 * can plug into the Sessions app by setting `nativeSessionsProviderId` in
 * product.json without requiring any GAS-specific fork code.
 */
class ExtensionSessionsBridgeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.extensionSessionsBridge';

	constructor(
		@IProductService productService: IProductService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@ICommandService commandService: ICommandService,
		@ILogService logService: ILogService,
	) {
		super();

		const nativeProviderId = productService.defaultChatAgent?.nativeSessionsProviderId;
		if (!nativeProviderId) {
			return;
		}

		const defaultModelId = productService.defaultChatAgent?.completionsAdvancedSetting ?? nativeProviderId;

		logService.info('[ExtensionSessionsBridge] Registering bridge activate command for provider:', nativeProviderId);

		/**
		 * Register the activation command. The extension calls this after it has
		 * registered all SESSION_BRIDGE_COMMANDS to signal that the bridge is ready.
		 */
		this._register(CommandsRegistry.registerCommand(
			SESSIONS_BRIDGE_ACTIVATE_COMMAND,
			async (accessor: ServicesAccessor, activatedProviderId: string) => {
				if (activatedProviderId !== nativeProviderId) {
					logService.warn('[ExtensionSessionsBridge] activate called with unexpected providerId:', activatedProviderId, '(expected:', nativeProviderId, ')');
					return;
				}

				logService.info('[ExtensionSessionsBridge] Extension provider activated:', activatedProviderId);

				try {
					const providerInfo: ProviderInfo = await commandService.executeCommand(
						SESSION_BRIDGE_COMMANDS.getProviderInfo,
						{ providerId: nativeProviderId }
					) ?? { label: nativeProviderId, iconId: 'sparkle' };

					const provider = instantiationService.createInstance(
						ExtensionBackedSessionsProvider,
						nativeProviderId,
						providerInfo,
						defaultModelId,
					);

					await provider.refresh();
					const providerRegistration = sessionsProvidersService.registerProvider(provider);
					// Keep provider alive for the lifetime of this contribution.
					this._register(providerRegistration);
					logService.info('[ExtensionSessionsBridge] Provider registered:', nativeProviderId);
				} catch (err) {
					logService.error('[ExtensionSessionsBridge] Failed to register provider:', nativeProviderId, err);
				}
			}
		));
	}
}

registerWorkbenchContribution2(
	ExtensionSessionsBridgeContribution.ID,
	ExtensionSessionsBridgeContribution,
	WorkbenchPhase.AfterRestored,
);
