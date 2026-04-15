/**
 * UI Module Index
 * Re-exports all UI components for easy importing
 */

export { GasEstimator } from './GasEstimator.js';
export { notificationUI } from './NotificationUI.js';
export * from './utils.js';
export { reactionManager } from './ReactionManager.js';
export { onlineUsersUI } from './OnlineUsersUI.js';
export { dropdownManager } from './DropdownManager.js';
export { mediaHandler } from './MediaHandler.js';
export { messageRenderer } from './MessageRenderer.js';
export * from './MessageGrouper.js';
export { modalManager } from './ModalManager.js';
export { settingsUI } from './SettingsUI.js';
export { exploreUI } from './ExploreUI.js';
export { channelSettingsUI } from './ChannelSettingsUI.js';
export { contactsUI } from './ContactsUI.js';
export { channelListUI } from './ChannelListUI.js';
export { chatAreaUI } from './ChatAreaUI.js';
export { inputUI } from './InputUI.js';
export { headerUI } from './HeaderUI.js';
export { channelModalsUI } from './ChannelModalsUI.js';
export { init as initJoinChannelUI, getInstance as getJoinChannelUI } from './JoinChannelUI.js';
export { inviteUI } from './InviteUI.js';
export { channelViewUI } from './ChannelViewUI.js';
export { avatarGenerator, generateAvatar, getAvatar, getAvatarHtml, getAddressColor } from './AvatarGenerator.js';
export { sanitizeMessageHtml, sanitizeText, sanitizeUrl, isSanitizerAvailable } from './sanitizer.js';
