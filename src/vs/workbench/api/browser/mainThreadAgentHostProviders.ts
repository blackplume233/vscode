/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { revive } from '../../../base/common/marshalling.js';
import { IAgentHostService, type ExtensionBackedAgentHostProgress, type IExtensionBackedAgentHostRegistration } from '../../../platform/agentHost/common/agentService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, MainContext, type ExtHostAgentHostProvidersShape, type MainThreadAgentHostProvidersShape } from '../common/extHost.protocol.js';

@extHostNamedCustomer(MainContext.MainThreadAgentHostProviders)
export class MainThreadAgentHostProviders extends Disposable implements MainThreadAgentHostProvidersShape {
	private readonly _proxy: ExtHostAgentHostProvidersShape;

	constructor(
		extHostContext: IExtHostContext,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostAgentHostProviders);
		this._register(this._agentHostService.onDidExtensionBackedAgentHostRequest(async request => {
			const response = await this._proxy.$handleAgentHostRequest(revive(request));
			this._agentHostService.completeExtensionBackedAgentHostRequest(response);
		}));
	}

	async $registerAgentHostProvider(registration: IExtensionBackedAgentHostRegistration): Promise<void> {
		await this._agentHostService.registerExtensionBackedAgentHostProvider(registration);
	}

	async $unregisterAgentHostProvider(handle: number): Promise<void> {
		await this._agentHostService.unregisterExtensionBackedAgentHostProvider(handle);
	}

	$acceptAgentHostProgress(handle: number, progress: ExtensionBackedAgentHostProgress): void {
		this._agentHostService.acceptExtensionBackedAgentHostProgress(handle, progress);
	}
}
