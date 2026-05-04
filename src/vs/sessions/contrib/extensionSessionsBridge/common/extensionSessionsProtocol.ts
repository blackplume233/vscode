/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Command-based protocol between the Sessions app (main thread) and an extension
 * that acts as a native Sessions provider.
 *
 * The extension must register these commands on activation.
 * The bridge contribution (extensionSessionsBridge.contribution.ts) reads
 * `product.json.nativeSessionsProviderId` and calls these commands to drive
 * the provider.
 *
 * Command contract:
 *   All arguments are plain JSON-serialisable objects so they survive the
 *   ICommandService serialisation boundary.
 */

/** Stable command identifiers for the bridge protocol. */
export const SESSION_BRIDGE_COMMANDS = {
	/** Called once during bridge initialisation to retrieve static provider metadata. */
	getProviderInfo: '_sessions.bridge.getProviderInfo',
	/**
	 * Called to retrieve the list of session type IDs the provider supports for
	 * a given folder URI.  Returns SessionTypeInfo[].
	 */
	getSessionTypes: '_sessions.bridge.getSessionTypes',
	/**
	 * Called to retrieve browse actions (folder picker entries).
	 * Returns BrowseActionInfo[].
	 */
	getBrowseActions: '_sessions.bridge.getBrowseActions',
	/**
	 * Called when the user picks a browse action.
	 * Returns a BrowsedWorkspaceInfo or undefined if the action was cancelled.
	 */
	runBrowseAction: '_sessions.bridge.runBrowseAction',
	/**
	 * Called to resolve a workspace description from a folder URI.
	 * Returns WorkspaceInfo or undefined if the provider can't handle the URI.
	 */
	resolveWorkspace: '_sessions.bridge.resolveWorkspace',
} as const;

/** Serialisable metadata returned by `getProviderInfo`. */
export interface ProviderInfo {
	readonly label: string;
	readonly iconId: string;
}

/** Serialisable session type descriptor. */
export interface SessionTypeInfo {
	readonly id: string;
	readonly label: string;
	readonly iconId?: string;
}

/** Serialisable browse action descriptor. */
export interface BrowseActionInfo {
	readonly id: string;
	readonly label: string;
	readonly iconId?: string;
	readonly providerId: string;
}

/** Workspace info returned when resolving or browsing. */
export interface WorkspaceInfo {
	readonly label: string;
	readonly folderUri: string;
}
