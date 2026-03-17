import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
  zeroAddress,
} from 'viem';
import { gnosis } from 'viem/chains';
import { onWalletChange, sendTransactions } from '@aboutcircles/miniapp-sdk';
import { cidV0ToHex } from '@aboutcircles/sdk-utils';
import { marked } from 'marked';
import {
  getCompatibilityFallbackHandlerDeployment,
  getProxyFactoryDeployment,
  getSafeSingletonDeployment,
} from '@safe-global/safe-deployments';
import { CirclesClient } from './circlesClient.js';

const RPC_URL = 'https://rpc.aboutcircles.com/';
const RPC_FALLBACK_URLS = [
  RPC_URL,
  'https://rpc.gnosischain.com',
  'https://1rpc.io/gnosis',
];
const SAFE_VERSION = '1.4.1';
const SAFE_TX_SERVICE_URL = 'https://safe-transaction-gnosis-chain.safe.global';
const TX_RECEIPT_TIMEOUT_MS = 12 * 60 * 1000;
const TX_RECEIPT_POLL_MS = 3000;
const USER_OP_LOOKBACK_BLOCKS = 5000n;
const ENTRYPOINT_V07_ADDRESS = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const ATTO_CIRCLES_DECIMALS = 18n;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PREVIEW_IMAGE_DIMENSION = 256;
const MAX_PREVIEW_IMAGE_BYTES = 150 * 1024;
const PREVIEW_IMAGE_QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34, 0.26];
const MAX_GROUP_NAME_LENGTH = 19;
const MEMBER_PAGE_LIMIT = 50;
const GROUP_PAGE_LIMIT = 50;
const SAFE_MULTICALL_BATCH_SIZE = 40;
const USER_OPERATION_EVENT = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'
);
const PROXY_CREATION_EVENT = parseAbiItem(
  'event ProxyCreation(address indexed proxy, address singleton)'
);
const BASE_GROUP_CREATED_EVENT = parseAbiItem(
  'event BaseGroupCreated(address indexed group, address indexed owner, address indexed mintHandler, address treasury)'
);

const publicClient = createPublicClient({
  chain: gnosis,
  transport: http(RPC_URL),
});
const receiptClients = RPC_FALLBACK_URLS.map((url) =>
  createPublicClient({
    chain: gnosis,
    transport: http(url),
  })
);

const safeSingletonDeployment = getSafeSingletonDeployment({
  network: String(gnosis.id),
  version: SAFE_VERSION,
});
const proxyFactoryDeployment = getProxyFactoryDeployment({
  network: String(gnosis.id),
  version: SAFE_VERSION,
});
const compatibilityFallbackHandlerDeployment = getCompatibilityFallbackHandlerDeployment({
  network: String(gnosis.id),
  version: SAFE_VERSION,
});

let connectedAddress = null;
let humanSdk = null;
let activeGroupSdk = null;
let activeGroupAvatar = null;
let activeGroupMeta = null;
let activeOwnerSafe = null;
let lastTxHashes = [];
let activeGroups = [];
let cachedMembers = [];
let memberPages = [];
let memberNamesByAddress = new Map();
let membersQuery = null;
let currentMembersPageIndex = 0;
let membersHasMorePages = false;
let loadedMembersGroupAddress = null;
let membersLoadRequestId = 0;
let ownerSafeOwners = [];
let ownerSafeThreshold = null;
let activeMembershipConditions = [];
let ownerSafeDetailsLoadRequestId = 0;
let cachedMintableAmount = 0n;
let currentView = 'login';
const groupPreviewImageByAddress = new Map();
let createImageDataUrl = '';
let profileImageSourceUrl = '';
let profileImageSelectedDataUrl = '';
let imageProcessing = false;
let memberSearchRequestId = 0;
let memberSearchDebounceTimer = null;
let ownerSearchRequestId = 0;
let ownerSearchDebounceTimer = null;
let sendSearchRequestId = 0;
let sendSearchDebounceTimer = null;
let adminGroupsLoadRequestId = 0;
let resultHideTimer = null;
const sessionOwnerSafesByUser = new Map();
const createExternalLink = { label: '', url: '' };
const profileExternalLink = { label: '', url: '' };

const badge = document.getElementById('badge');
const resultEl = document.getElementById('result');
const breadcrumbEl = document.getElementById('breadcrumb');
const breadcrumbHomeBtn = document.getElementById('breadcrumb-home');

const loginSection = document.getElementById('login-section');
const groupsSection = document.getElementById('groups-section');
const createSection = document.getElementById('create-section');
const groupSection = document.getElementById('group-section');

const groupsListEl = document.getElementById('groups-list');
const startCreateGroupBtn = document.getElementById('start-create-group-btn');
const createGroupBtn = document.getElementById('create-group-btn');
const createGroupNameInput = document.getElementById('create-group-name');
const createGroupSymbolInput = document.getElementById('create-group-symbol');
const createGroupDescriptionInput = document.getElementById('create-group-description');
const createGroupImageInput = document.getElementById('create-group-image');
const createImagePreviewWrap = document.getElementById('create-image-preview-wrap');
const createImagePreview = document.getElementById('create-image-preview');
const clearCreateImageBtn = document.getElementById('clear-create-image-btn');
const createLinkLabelInput = document.getElementById('create-link-label');
const createLinkUrlInput = document.getElementById('create-link-url');

const refreshGroupBtn = document.getElementById('refresh-group-btn');
const switchGroupsBtn = document.getElementById('switch-groups-btn');
const groupCoverEl = document.getElementById('group-cover');
const groupSymbolDisplay = document.getElementById('group-symbol-display');
const groupNameDisplay = document.getElementById('group-name-display');
const groupDescriptionDisplay = document.getElementById('group-description-display');
const groupAddressDisplay = document.getElementById('group-address-display');
const groupManagementMenuEl = document.getElementById('group-management-menu');
const groupOverviewPanelEl = document.getElementById('group-overview-panel');
const groupDetailsPanelEl = document.getElementById('group-details-panel');
const groupAdminsPanelEl = document.getElementById('group-admins-panel');
const groupMembersPanelEl = document.getElementById('group-members-panel');
const groupTokensPanelEl = document.getElementById('group-tokens-panel');
const overviewGroupAddressEl = document.getElementById('overview-group-address');
const overviewOwnerSafeEl = document.getElementById('overview-owner-safe');
const overviewTreasuryAddressEl = document.getElementById('overview-treasury-address');
const overviewMintHandlerEl = document.getElementById('overview-mint-handler');
const overviewServiceAddressEl = document.getElementById('overview-service-address');
const overviewFeeCollectionAddressEl = document.getElementById('overview-fee-collection-address');
const overviewGroupTypeEl = document.getElementById('overview-group-type');
const overviewTotalSupplyLabelEl = document.getElementById('overview-total-supply-label');
const overviewTotalSupplyEl = document.getElementById('overview-total-supply');

const profileDescriptionInput = document.getElementById('profile-description');
const profileImageInput = document.getElementById('profile-image');
const profileImagePreviewWrap = document.getElementById('profile-image-preview-wrap');
const profileImagePreview = document.getElementById('profile-image-preview');
const clearProfileImageBtn = document.getElementById('clear-profile-image-btn');
const profileLinkLabelInput = document.getElementById('profile-link-label');
const profileLinkUrlInput = document.getElementById('profile-link-url');
const ownerSafeInput = document.getElementById('owner-safe-input');
const updateOwnerBtn = document.getElementById('update-owner-btn');
const ownerSafeOwnersListEl = document.getElementById('owner-safe-owners-list');
const addOwnerInput = document.getElementById('add-owner-input');
const addOwnerSafeBtn = document.getElementById('add-owner-safe-btn');
const ownerSafeSearchResultsEl = document.getElementById('owner-safe-search-results');
const serviceAddressInput = document.getElementById('service-address-input');
const updateServiceBtn = document.getElementById('update-service-btn');
const feeCollectionInput = document.getElementById('fee-collection-input');
const updateFeeCollectionBtn = document.getElementById('update-fee-collection-btn');
const membershipConditionsListEl = document.getElementById('membership-conditions-list');
const membershipConditionInput = document.getElementById('membership-condition-input');
const enableMembershipConditionBtn = document.getElementById('enable-membership-condition-btn');
const disableMembershipConditionBtn = document.getElementById('disable-membership-condition-btn');
const saveProfileBtn = document.getElementById('save-profile-btn');

const memberQueryInput = document.getElementById('member-query');
const addMemberBtn = document.getElementById('add-member-btn');
const memberSearchResultsEl = document.getElementById('member-search-results');
const membersListEl = document.getElementById('members-list');
const membersTotalCountEl = document.getElementById('members-total-count');
const membersPageLabelEl = document.getElementById('members-page-label');
const membersPrevBtn = document.getElementById('members-prev-btn');
const membersNextBtn = document.getElementById('members-next-btn');

const overviewCollateralListEl = document.getElementById('overview-collateral-list');
const overviewHoldersListEl = document.getElementById('overview-holders-list');
const overviewHoldersLabelEl = document.getElementById('overview-holders-label');
const groupTokenCardTitleEl = document.getElementById('group-token-card-title');
const groupTokenCardCopyEl = document.getElementById('group-token-card-copy');
const groupTokenPanelTitleEl = document.getElementById('group-token-panel-title');
const groupTokenMintTitleEl = document.getElementById('group-token-mint-title');
const groupTokenSendTitleEl = document.getElementById('group-token-send-title');
const mintableDisplay = document.getElementById('mintable-display');
const mintAmountLabelEl = document.getElementById('mint-amount-label');
const mintAmountInput = document.getElementById('mint-amount');
const mintMaxBtn = document.getElementById('mint-max-btn');
const mintGroupBtn = document.getElementById('mint-group-btn');
const sendRecipientInput = document.getElementById('send-recipient');
const sendSearchResultsEl = document.getElementById('send-search-results');
const sendAmountLabelEl = document.getElementById('send-amount-label');
const sendAmountInput = document.getElementById('send-amount');
const sendGroupBtn = document.getElementById('send-group-btn');

function showResult(type, html) {
  if (resultHideTimer) {
    clearTimeout(resultHideTimer);
    resultHideTimer = null;
  }
  resultEl.className = `result result-${type}`;
  resultEl.innerHTML = html;
  resultEl.classList.remove('hidden');

  if (type === 'success') {
    resultHideTimer = setTimeout(() => {
      hideResult();
    }, 3000);
  }
}

function hideResult() {
  if (resultHideTimer) {
    clearTimeout(resultHideTimer);
    resultHideTimer = null;
  }
  resultEl.classList.add('hidden');
}

function setStatus(text, type) {
  badge.textContent = text;
  badge.className = `badge badge-${type}`;
}

function hideAllSections() {
  loginSection.classList.add('hidden');
  groupsSection.classList.add('hidden');
  createSection.classList.add('hidden');
  groupSection.classList.add('hidden');
}

function setBreadcrumb(crumbs) {
  if (!crumbs || crumbs.length === 0) {
    breadcrumbEl.classList.add('hidden');
    return;
  }

  breadcrumbEl.innerHTML = '';
  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '/';
      breadcrumbEl.appendChild(sep);
    }

    if (crumb.action) {
      const link = document.createElement('button');
      link.className = 'breadcrumb-link';
      link.textContent = crumb.label;
      link.addEventListener('click', crumb.action);
      breadcrumbEl.appendChild(link);
    } else {
      const current = document.createElement('span');
      current.className = 'breadcrumb-current';
      current.textContent = crumb.label;
      breadcrumbEl.appendChild(current);
    }
  });
  breadcrumbEl.classList.remove('hidden');
}

function navigateToGroups() {
  activeGroupSdk = null;
  activeGroupAvatar = null;
  activeGroupMeta = null;
  activeOwnerSafe = null;
  resetOwnerSafeState();
  showGroupManagementMenu();
  clearMemberSearchResults();
  loadAdminGroups(true);
}

function showDisconnectedState() {
  hideAllSections();
  hideResult();
  currentView = 'login';
  setBreadcrumb(null);
  setStatus('Not connected', 'disconnected');
  loginSection.classList.remove('hidden');
  groupsListEl.innerHTML = '<p class="muted">Connect a wallet to load groups.</p>';
  resetMembersState();
  resetOwnerSafeState();
  ownerSafeInput.value = '';
  overviewCollateralListEl.innerHTML = '<p class="muted">Open a group to load treasury balances.</p>';
  overviewHoldersListEl.innerHTML = '<p class="muted">Open a group to load token holders.</p>';
  overviewGroupTypeEl.textContent = '—';
  overviewTotalSupplyEl.textContent = '—';
  updateTokenUiCopy();
  clearSendSearchResults();
}

function showGroupsView(keepStatus = false) {
  hideAllSections();
  currentView = 'groups';
  if (!keepStatus) setStatus('Connected', 'success');
  setBreadcrumb([{ label: 'Your Groups' }]);
  groupsSection.classList.remove('hidden');
}

function showCreateView() {
  hideAllSections();
  currentView = 'create';
  setStatus('Create group', 'success');
  setBreadcrumb([
    { label: 'Your Groups', action: navigateToGroups },
    { label: 'Create Group' },
  ]);
  createSection.classList.remove('hidden');
  updateCreateButtonState();
}

function showGroupView() {
  hideAllSections();
  currentView = 'group';
  setStatus('Group ready', 'success');
  const groupName = activeGroupMeta?.name || activeGroupMeta?.symbol || 'Group';
  setBreadcrumb([
    { label: 'Your Groups', action: navigateToGroups },
    { label: groupName },
  ]);
  groupSection.classList.remove('hidden');
  showGroupManagementMenu();
}

function hideGroupManagementPanels() {
  groupOverviewPanelEl.classList.add('hidden');
  groupDetailsPanelEl.classList.add('hidden');
  groupAdminsPanelEl.classList.add('hidden');
  groupMembersPanelEl.classList.add('hidden');
  groupTokensPanelEl.classList.add('hidden');
}

function resetMembersState() {
  cachedMembers = [];
  memberPages = [];
  memberNamesByAddress = new Map();
  membersHasMorePages = false;
  currentMembersPageIndex = 0;
  membersQuery = null;
  loadedMembersGroupAddress = null;
  membersListEl.innerHTML = '<p class="muted">Open Manage Group Members to load members.</p>';
  membersTotalCountEl.textContent = '0 members';
  membersPageLabelEl.textContent = 'Page 1';
  membersPrevBtn.disabled = true;
  membersNextBtn.disabled = true;
}

function resetOwnerSafeState() {
  ownerSafeOwners = [];
  ownerSafeThreshold = null;
  ownerSafeDetailsLoadRequestId += 1;
  if (ownerSearchDebounceTimer) {
    clearTimeout(ownerSearchDebounceTimer);
    ownerSearchDebounceTimer = null;
  }
  addOwnerInput.value = '';
  ownerSafeOwnersListEl.innerHTML = '<p class="muted">Open a group to load Group Admins.</p>';
  clearOwnerSafeSearchResults();
}

function resetMembershipConditionsState() {
  activeMembershipConditions = [];
  if (membershipConditionInput) {
    membershipConditionInput.value = '';
  }
  if (membershipConditionsListEl) {
    membershipConditionsListEl.innerHTML =
      '<p class="muted">Open a group to load membership conditions.</p>';
  }
}

function showGroupManagementMenu() {
  hideGroupManagementPanels();
  groupManagementMenuEl.classList.remove('hidden');
}

function showGroupManagementPanel(panel) {
  groupManagementMenuEl.classList.add('hidden');
  hideGroupManagementPanels();

  if (panel === 'overview') {
    groupOverviewPanelEl.classList.remove('hidden');
    return;
  }

  if (panel === 'details') {
    groupDetailsPanelEl.classList.remove('hidden');
    return;
  }

  if (panel === 'admins') {
    groupAdminsPanelEl.classList.remove('hidden');
    if (activeOwnerSafe && !ownerSafeOwners.length) {
      void loadOwnerSafeDetails();
    }
    return;
  }

  if (panel === 'members') {
    groupMembersPanelEl.classList.remove('hidden');
    if (activeGroupMeta?.group && loadedMembersGroupAddress !== activeGroupMeta.group) {
      void loadMembers();
    }
    return;
  }

  if (panel === 'tokens') {
    groupTokensPanelEl.classList.remove('hidden');
    return;
  }

  showGroupManagementMenu();
}

function decodeError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.shortMessage) return err.shortMessage;
  if (err.message) return err.message;
  return String(err);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getActiveTokenSymbol() {
  const symbol = String(activeGroupMeta?.symbol || '').trim();
  return symbol || 'token';
}

function formatActiveTokenAmount(amount) {
  return `${attoToCirclesString(amount)} ${getActiveTokenSymbol()}`;
}

function updateTokenUiCopy() {
  const symbol = getActiveTokenSymbol();
  const isGeneric = symbol === 'token';

  if (groupTokenCardTitleEl) {
    groupTokenCardTitleEl.textContent = isGeneric ? 'Manage Token' : `Manage ${symbol}`;
  }
  if (groupTokenCardCopyEl) {
    groupTokenCardCopyEl.textContent = isGeneric
      ? "Review collateral and manage minting and sending."
      : `Review collateral, then mint and send ${symbol}.`;
  }
  if (overviewHoldersLabelEl) {
    overviewHoldersLabelEl.textContent = isGeneric ? 'Token holders' : `${symbol} holders`;
  }
  if (groupTokenPanelTitleEl) {
    groupTokenPanelTitleEl.textContent = isGeneric ? 'Manage Token' : `Manage ${symbol}`;
  }
  if (groupTokenMintTitleEl) {
    groupTokenMintTitleEl.textContent = isGeneric ? 'Mint Token' : `Mint ${symbol}`;
  }
  if (groupTokenSendTitleEl) {
    groupTokenSendTitleEl.textContent = isGeneric ? 'Send Token' : `Send ${symbol}`;
  }
  if (mintAmountLabelEl) {
    mintAmountLabelEl.textContent = isGeneric ? 'Mint amount' : `Mint amount (${symbol})`;
  }
  if (sendAmountLabelEl) {
    sendAmountLabelEl.textContent = isGeneric ? 'Amount' : `Amount (${symbol})`;
  }
  if (mintGroupBtn) {
    mintGroupBtn.textContent = isGeneric ? 'Mint Token' : `Mint ${symbol}`;
  }
  if (sendGroupBtn) {
    sendGroupBtn.textContent = isGeneric ? 'Send Token' : `Send ${symbol}`;
  }
  if (!activeGroupMeta && mintableDisplay) {
    mintableDisplay.textContent = 'Max: 0 tokens';
  }
  if (overviewTotalSupplyLabelEl) {
    overviewTotalSupplyLabelEl.textContent = isGeneric ? 'Total Supply' : `${symbol} Total Supply`;
  }
}

function getGroupSendTransferOptions() {
  if (!activeGroupMeta?.group || !isAddress(activeGroupMeta.group)) return undefined;
  return {
    useWrappedBalances: false,
    fromTokens: [activeGroupMeta.group],
    toTokens: [activeGroupMeta.group],
  };
}

function renderMarkdown(element, markdown, emptyText = 'No description') {
  if (!element) return;

  const source = String(markdown || '').trim();
  if (!source) {
    element.textContent = emptyText;
    return;
  }

  element.innerHTML = marked.parse(escapeHtml(source), {
    breaks: true,
    gfm: true,
  });
  element.querySelectorAll('a').forEach((link) => {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
  });
}

function txLinks(hashes) {
  return hashes
    .map(
      (hash) =>
        `<a href="https://gnosisscan.io/tx/${hash}" target="_blank" rel="noopener">${hash}</a>`
    )
    .join('<br>');
}

function explorerAvatarUrl(address) {
  return `https://explorer.aboutcircles.com/avatar/${address}/`;
}

function gnosisScanAddressUrl(address) {
  return `https://gnosisscan.io/address/${address}`;
}

function shortenAddress(address) {
  if (!address || !isAddress(address)) return address || '—';
  const normalized = getAddress(address);
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function setAddressLink(element, address) {
  if (!element) return;

  if (address && isAddress(address)) {
    const normalized = getAddress(address);
    element.textContent = normalized;
    element.href = gnosisScanAddressUrl(normalized);
    element.title = normalized;
    return;
  }

  element.textContent = '—';
  element.href = '#';
  element.removeAttribute('title');
}

function isPasskeyAutoConnectError(err) {
  const message = decodeError(err).toLowerCase();
  return (
    message.includes('passkey') ||
    message.includes('passkeys') ||
    message.includes('auto connect') ||
    message.includes('autoconnect') ||
    (message.includes('wallet address') && message.includes('retrieve'))
  );
}

function attoToCirclesString(atto) {
  const amount = BigInt(atto || 0);
  const formatted = formatEther(amount);
  return formatted.includes('.') ? formatted.replace(/\.?0+$/, '') : formatted;
}

function parseCirclesInputToAtto(value) {
  const trimmed = String(value || '').trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) return null;
  const [wholeRaw, fractionRaw = ''] = trimmed.split('.');
  return (
    BigInt(wholeRaw) * 10n ** ATTO_CIRCLES_DECIMALS +
    BigInt(fractionRaw.padEnd(Number(ATTO_CIRCLES_DECIMALS), '0'))
  );
}

function normalizeAddressList(values) {
  const seen = new Set();
  const out = [];

  for (const value of values || []) {
    if (!value || typeof value !== 'string' || !isAddress(value)) continue;
    const normalized = getAddress(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function getSessionOwnerSafes(ownerAddress) {
  const key = ownerAddress?.toLowerCase();
  return normalizeAddressList(key ? sessionOwnerSafesByUser.get(key) || [] : []);
}

function setSessionOwnerSafes(ownerAddress, safeAddresses) {
  if (!ownerAddress) return;
  sessionOwnerSafesByUser.set(ownerAddress.toLowerCase(), normalizeAddressList(safeAddresses));
}

function addSessionOwnerSafe(ownerAddress, safeAddress) {
  const current = getSessionOwnerSafes(ownerAddress);
  current.push(safeAddress);
  setSessionOwnerSafes(ownerAddress, current);
}

function getCollateralAmount(balance) {
  if (!balance) return 0n;
  if (balance.attoCrc !== undefined && balance.attoCrc !== null) return BigInt(balance.attoCrc);
  if (balance.attoCircles !== undefined && balance.attoCircles !== null) return BigInt(balance.attoCircles);
  if (balance.balance !== undefined && balance.balance !== null) return BigInt(balance.balance);
  return 0n;
}

function getFallbackGroupType(type) {
  const raw = String(type || '').trim();
  if (!raw) return 'Unknown';
  if (raw === 'CrcV2_BaseGroupCreated') return 'Base Group';
  if (raw.startsWith('CrcV2_')) return raw.replace(/^CrcV2_/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return raw;
}

function sanitizeUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function readExternalLinkDraft(scope) {
  const source = scope === 'create' ? createExternalLink : profileExternalLink;
  return {
    label: String(source.label || '').trim(),
    url: sanitizeUrl(source.url),
  };
}

function extractExternalLinkFromDescription(markdown) {
  const source = String(markdown || '').trim();
  const match = source.match(
    /^(.*?)(?:\n{2,}|\n)?External link:\s*(?:\[(.*?)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^>]+)>)\s*$/s
  );

  if (!match) {
    return {
      description: source,
      link: { label: '', url: '' },
    };
  }

  return {
    description: String(match[1] || '').trim(),
    link: {
      label: String(match[2] || '').trim(),
      url: String(match[3] || match[4] || '').trim(),
    },
  };
}

function formatExternalLinkMarkdown(link) {
  const { label, url } = link || {};
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return '';
  const safeLabel = String(label || '').trim();
  const markdownLink = safeLabel ? `[${safeLabel}](${safeUrl})` : `<${safeUrl}>`;
  return `External link: ${markdownLink}`;
}

function buildDescriptionWithExternalLink(description, link) {
  const body = String(description || '').trim();
  const externalLinkMarkdown = formatExternalLinkMarkdown(link);
  if (!externalLinkMarkdown) return body;
  if (!body) return externalLinkMarkdown;
  return `${body}\n\n${externalLinkMarkdown}`;
}

function setExternalLinkDraft(scope, link) {
  const target = scope === 'create' ? createExternalLink : profileExternalLink;
  target.label = String(link?.label || '');
  target.url = String(link?.url || '');
}

function syncExternalLinkInputs(scope) {
  const link = scope === 'create' ? createExternalLink : profileExternalLink;
  const labelInput = scope === 'create' ? createLinkLabelInput : profileLinkLabelInput;
  const urlInput = scope === 'create' ? createLinkUrlInput : profileLinkUrlInput;
  if (labelInput) labelInput.value = link.label || '';
  if (urlInput) urlInput.value = link.url || '';
}

function handleExternalLinkInput(scope, field, value) {
  const target = scope === 'create' ? createExternalLink : profileExternalLink;
  target[field] = value;
}

function resetCreateForm() {
  createGroupNameInput.value = '';
  createGroupSymbolInput.value = '';
  createGroupDescriptionInput.value = '';
  setExternalLinkDraft('create', { label: '', url: '' });
  syncExternalLinkInputs('create');
  clearCreateImageSelection();
  updateCreateButtonState();
}

function updateCreateButtonState() {
  const hasName = createGroupNameInput.value.trim().length > 0;
  const hasSymbol = /^[A-Z0-9]{2,8}$/.test(createGroupSymbolInput.value.trim());
  const hasDescription = createGroupDescriptionInput.value.trim().length > 0;
  createGroupBtn.disabled =
    !connectedAddress || !hasName || !hasSymbol || !hasDescription || imageProcessing;
}

function renderImagePreview(wrap, imageEl, src) {
  if (!src) {
    imageEl.removeAttribute('src');
    wrap.classList.add('hidden');
    return;
  }

  imageEl.src = src;
  wrap.classList.remove('hidden');
}

function clearCreateImageSelection() {
  createImageDataUrl = '';
  if (createGroupImageInput) createGroupImageInput.value = '';
  renderImagePreview(createImagePreviewWrap, createImagePreview, '');
}

function getProfileImageSrc() {
  return profileImageSelectedDataUrl || profileImageSourceUrl || '';
}

function updateGroupCoverDisplay(src) {
  if (src) {
    groupCoverEl.style.backgroundImage = `url("${src}")`;
    groupCoverEl.classList.remove('hidden');
    return;
  }

  groupCoverEl.style.backgroundImage = '';
  groupCoverEl.classList.add('hidden');
}

function clearProfileImageSelection() {
  profileImageSelectedDataUrl = '';
  profileImageSourceUrl = '';
  if (profileImageInput) profileImageInput.value = '';
  renderImagePreview(profileImagePreviewWrap, profileImagePreview, '');
  updateGroupCoverDisplay('');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read selected image file.'));
    reader.readAsDataURL(file);
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode selected image.'));
    image.src = dataUrl;
  });
}

function getDataUrlByteLength(dataUrl) {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) return 0;

  const metadata = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  if (!payload) return 0;

  if (metadata.includes(';base64')) {
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.floor((payload.length * 3) / 4) - padding;
  }

  try {
    return decodeURIComponent(payload).length;
  } catch {
    return payload.length;
  }
}

async function convertImageFileToProfileDataUrl(file) {
  if (!file?.type?.startsWith('image/')) {
    throw new Error('Please select a valid image file.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Image size must be 8MB or less.');
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const sourceImage = await loadImageFromDataUrl(sourceDataUrl);
  const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
  const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
  if (!sourceWidth || !sourceHeight) {
    throw new Error('Selected image has invalid dimensions.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_IMAGE_DIMENSION;
  canvas.height = PREVIEW_IMAGE_DIMENSION;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Image processing is unavailable in this browser.');
  }

  const squareSide = Math.min(sourceWidth, sourceHeight);
  const sourceX = Math.floor((sourceWidth - squareSide) / 2);
  const sourceY = Math.floor((sourceHeight - squareSide) / 2);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, PREVIEW_IMAGE_DIMENSION, PREVIEW_IMAGE_DIMENSION);
  context.drawImage(
    sourceImage,
    sourceX,
    sourceY,
    squareSide,
    squareSide,
    0,
    0,
    PREVIEW_IMAGE_DIMENSION,
    PREVIEW_IMAGE_DIMENSION
  );

  for (const quality of PREVIEW_IMAGE_QUALITIES) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (getDataUrlByteLength(dataUrl) <= MAX_PREVIEW_IMAGE_BYTES) {
      return dataUrl;
    }
  }

  throw new Error('Could not compress image to 256x256 under 150KB.');
}

async function handleCreateImageChange() {
  const file = createGroupImageInput?.files?.[0];
  if (!file) {
    clearCreateImageSelection();
    updateCreateButtonState();
    return;
  }

  imageProcessing = true;
  updateCreateButtonState();

  try {
    createImageDataUrl = await convertImageFileToProfileDataUrl(file);
    renderImagePreview(createImagePreviewWrap, createImagePreview, createImageDataUrl);
    hideResult();
  } catch (err) {
    clearCreateImageSelection();
    showResult('error', `Could not prepare image: ${decodeError(err)}`);
  } finally {
    imageProcessing = false;
    updateCreateButtonState();
  }
}

async function handleProfileImageChange() {
  const file = profileImageInput?.files?.[0];
  if (!file) {
    renderImagePreview(profileImagePreviewWrap, profileImagePreview, getProfileImageSrc());
    return;
  }

  imageProcessing = true;
  saveProfileBtn.disabled = true;

  try {
    profileImageSelectedDataUrl = await convertImageFileToProfileDataUrl(file);
    renderImagePreview(profileImagePreviewWrap, profileImagePreview, getProfileImageSrc());
    hideResult();
  } catch (err) {
    showResult('error', `Could not prepare image: ${decodeError(err)}`);
  } finally {
    imageProcessing = false;
    saveProfileBtn.disabled = false;
  }
}

function toHexValue(value) {
  return value ? `0x${BigInt(value).toString(16)}` : '0x0';
}

function formatTxForHost(tx) {
  return {
    to: tx.to,
    data: tx.data || '0x',
    value: toHexValue(tx.value || 0n),
  };
}

function getDeploymentAddress(deployment) {
  if (!deployment) throw new Error('Safe deployment metadata is missing.');
  const networkAddress = deployment.networkAddresses?.[String(gnosis.id)] || deployment.defaultAddress;
  if (!networkAddress) throw new Error('Safe deployment for this network is missing.');
  return getAddress(networkAddress);
}

function randomSaltNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) + BigInt(b);
  return value.toString();
}

function buildPrevalidatedSignature(ownerAddress) {
  const ownerPadded = ownerAddress.toLowerCase().replace('0x', '').padStart(64, '0');
  return `0x${ownerPadded}${'0'.repeat(64)}01`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReceiptFromAnyRpc(hash) {
  const deadline = Date.now() + TX_RECEIPT_TIMEOUT_MS;
  let lastErrorMessage = '';
  let round = 0;

  while (Date.now() < deadline) {
    round += 1;

    for (const client of receiptClients) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        if (receipt) return receipt;
      } catch (err) {
        lastErrorMessage = decodeError(err);
      }
    }

    if (round % 2 === 0) {
      for (const client of receiptClients) {
        const receipt = await tryResolveUserOpReceipt(client, hash);
        if (receipt) return receipt;
      }
    }

    await sleep(TX_RECEIPT_POLL_MS);
  }

  const detail = lastErrorMessage ? ` Last RPC error: ${lastErrorMessage}` : '';
  throw new Error(`Timed out while waiting for transaction "${hash}" to confirm.${detail}`);
}

async function tryResolveUserOpReceipt(client, userOpHash) {
  try {
    const latest = await client.getBlockNumber();
    const fromBlock = latest > USER_OP_LOOKBACK_BLOCKS ? latest - USER_OP_LOOKBACK_BLOCKS : 0n;
    const logs = await client.getLogs({
      address: ENTRYPOINT_V07_ADDRESS,
      event: USER_OPERATION_EVENT,
      args: { userOpHash },
      fromBlock,
      toBlock: latest,
    });
    if (!logs.length) return null;
    const txHash = logs[logs.length - 1]?.transactionHash;
    return txHash ? await client.getTransactionReceipt({ hash: txHash }) : null;
  } catch {
    return null;
  }
}

function waitForReceipts(hashes) {
  return Promise.all(hashes.map(waitForReceiptFromAnyRpc));
}

async function preflightEthCall({ label, to, data = '0x', value = 0n, account }) {
  try {
    await publicClient.call({
      to: getAddress(to),
      data,
      value: BigInt(value),
      account,
    });
  } catch (err) {
    throw new Error(`${label} preflight failed: ${decodeError(err)}`);
  }
}

function createRunner(address) {
  return {
    address,
    async sendTransaction(txs) {
      const hashes = await sendTransactions(txs.map(formatTxForHost));
      lastTxHashes = hashes;
      const receipts = await waitForReceipts(hashes);
      return receipts[receipts.length - 1];
    },
  };
}

function createSafeOwnerRunner(ownerAddress, safeAddress) {
  const safeAbi = safeSingletonDeployment?.abi;
  if (!safeAbi) throw new Error('Safe singleton ABI is unavailable.');

  return {
    address: safeAddress,
    async sendTransaction(txs) {
      const safeExecTxs = txs.map((tx) => buildSafeExecTransaction(ownerAddress, safeAddress, tx));

      const hashes = await sendTransactions(safeExecTxs.map(formatTxForHost));
      lastTxHashes = hashes;
      const receipts = await waitForReceipts(hashes);
      return receipts[receipts.length - 1];
    },
  };
}

function buildSafeExecTransaction(ownerAddress, safeAddress, tx) {
  const safeAbi = safeSingletonDeployment?.abi;
  if (!safeAbi) throw new Error('Safe singleton ABI is unavailable.');

  const signature = buildPrevalidatedSignature(ownerAddress);
  return {
    to: safeAddress,
    value: 0n,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [
        tx.to,
        tx.value ? BigInt(tx.value) : 0n,
        tx.data || '0x',
        0,
        0n,
        0n,
        0n,
        zeroAddress,
        zeroAddress,
        signature,
      ],
    }),
  };
}

async function readSafeOwnersAndThreshold(safeAddress) {
  const safeAbi = safeSingletonDeployment?.abi;
  if (!safeAbi) throw new Error('Safe singleton ABI is unavailable.');

  const [owners, threshold] = await Promise.all([
    publicClient.readContract({
      address: getAddress(safeAddress),
      abi: safeAbi,
      functionName: 'getOwners',
    }),
    publicClient.readContract({
      address: getAddress(safeAddress),
      abi: safeAbi,
      functionName: 'getThreshold',
    }),
  ]);

  return {
    owners: normalizeAddressList(owners || []),
    threshold: Number(threshold),
  };
}

function renderOwnerSafeOwners() {
  if (!ownerSafeOwners.length) {
    ownerSafeOwnersListEl.innerHTML = '<p class="muted">No Group Admins found.</p>';
    return;
  }

  ownerSafeOwnersListEl.innerHTML = ownerSafeOwners
    .map((owner) => {
      const isConnectedOwner =
        connectedAddress && owner.toLowerCase() === connectedAddress.toLowerCase();
      return `
        <div class="list-row search-result-row">
          <div class="list-row-main">
            <div class="list-row-title mono">${escapeHtml(owner)}</div>
            <div class="list-row-meta">${isConnectedOwner ? 'Connected wallet' : 'Group admin'}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

async function loadOwnerSafeDetails() {
  if (!activeOwnerSafe || !isAddress(activeOwnerSafe)) {
    resetOwnerSafeState();
    ownerSafeOwnersListEl.innerHTML = '<p class="muted">This group does not expose an owner Safe.</p>';
    return;
  }

  const requestId = ++ownerSafeDetailsLoadRequestId;
  ownerSafeOwnersListEl.innerHTML = '<p class="muted">Loading Group Admins…</p>';

  try {
    const { owners, threshold } = await readSafeOwnersAndThreshold(activeOwnerSafe);
    if (requestId !== ownerSafeDetailsLoadRequestId) return;

    ownerSafeOwners = owners;
    ownerSafeThreshold = threshold;
    renderOwnerSafeOwners();
  } catch (err) {
    if (requestId !== ownerSafeDetailsLoadRequestId) return;

    ownerSafeOwners = [];
    ownerSafeThreshold = null;
    ownerSafeOwnersListEl.innerHTML = `<p class="muted">Could not load Group Admins: ${escapeHtml(decodeError(err))}</p>`;
  }
}

function renderMembershipConditions() {
  if (!membershipConditionsListEl) return;

  if (!activeMembershipConditions.length) {
    membershipConditionsListEl.innerHTML = '<p class="muted">No active membership conditions.</p>';
    return;
  }

  membershipConditionsListEl.innerHTML = activeMembershipConditions
    .map(
      (condition) => `
        <div class="list-row search-result-row">
          <div class="list-row-main">
            <div class="list-row-title mono">${escapeHtml(condition)}</div>
            <div class="list-row-meta">Enabled membership condition</div>
          </div>
        </div>
      `
    )
    .join('');
}

async function loadMembershipConditions() {
  if (!activeGroupAvatar?.baseGroup || !membershipConditionsListEl) {
    resetMembershipConditionsState();
    return;
  }

  membershipConditionsListEl.innerHTML = '<p class="muted">Loading membership conditions…</p>';

  try {
    const conditions = await activeGroupAvatar.baseGroup.getMembershipConditions();
    activeMembershipConditions = normalizeAddressList(conditions || []);
    renderMembershipConditions();
  } catch (err) {
    activeMembershipConditions = [];
    membershipConditionsListEl.innerHTML =
      `<p class="muted">Could not load membership conditions: ${escapeHtml(decodeError(err))}</p>`;
  }
}

async function fetchOwnerSafeCandidates(ownerAddress) {
  const url = `${SAFE_TX_SERVICE_URL}/api/v1/owners/${ownerAddress}/safes/`;

  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return normalizeAddressList(data?.safes || []);
  } catch {
    return [];
  }
}

async function getVerifiedOwnerSafes(safeAddresses, ownerAddress) {
  const safeAbi = safeSingletonDeployment?.abi;
  if (!safeAbi || !safeAddresses.length) return [];

  const normalizedSafes = normalizeAddressList(safeAddresses);
  const verifiedSafes = [];

  for (let index = 0; index < normalizedSafes.length; index += SAFE_MULTICALL_BATCH_SIZE) {
    const batch = normalizedSafes.slice(index, index + SAFE_MULTICALL_BATCH_SIZE);
    const contracts = batch.flatMap((safeAddress) => [
      {
        address: safeAddress,
        abi: safeAbi,
        functionName: 'getOwners',
      },
      {
        address: safeAddress,
        abi: safeAbi,
        functionName: 'getThreshold',
      },
    ]);

    try {
      const results = await publicClient.multicall({
        contracts,
        allowFailure: true,
      });

      batch.forEach((safeAddress, batchIndex) => {
        const ownersResult = results[batchIndex * 2];
        const thresholdResult = results[batchIndex * 2 + 1];
        if (ownersResult?.status !== 'success' || thresholdResult?.status !== 'success') return;

        const owners = ownersResult.result;
        const threshold = thresholdResult.result;
        if (
          Array.isArray(owners) &&
          owners.some((entry) => entry.toLowerCase() === ownerAddress.toLowerCase()) &&
          BigInt(threshold) >= 1n
        ) {
          verifiedSafes.push(safeAddress);
        }
      });
    } catch {}
  }

  return verifiedSafes;
}

function normalizeGroupMeta(group) {
  return {
    ...group,
    group: getAddress(group.group),
    owner: isAddress(group.owner) ? getAddress(group.owner) : group.owner,
    treasury: group.treasury && isAddress(group.treasury) ? getAddress(group.treasury) : '',
    mintHandler: group.mintHandler && isAddress(group.mintHandler) ? getAddress(group.mintHandler) : '',
    service: group.service && isAddress(group.service) ? getAddress(group.service) : '',
    feeCollection:
      group.feeCollection && isAddress(group.feeCollection) ? getAddress(group.feeCollection) : '',
  };
}

function getResolvedGroupMeta(groupAddress) {
  return activeGroups.find((entry) => entry.group.toLowerCase() === groupAddress.toLowerCase()) || null;
}

function getNameOrAddress(item) {
  return item?.name || item?.group || 'Unknown';
}

function normalizeGroups(groups) {
  return (groups || [])
    .filter((group) => group?.group && isAddress(group.group))
    .map(normalizeGroupMeta)
    .sort((a, b) => getNameOrAddress(a).localeCompare(getNameOrAddress(b)));
}

function mergeGroups(...groupLists) {
  const merged = new Map();
  for (const list of groupLists) {
    for (const group of list || []) {
      if (!group?.group) continue;
      merged.set(group.group.toLowerCase(), group);
    }
  }

  return Array.from(merged.values()).sort((a, b) => getNameOrAddress(a).localeCompare(getNameOrAddress(b)));
}

async function fetchGroupsByOwners(ownerIn) {
  if (!humanSdk || !ownerIn.length) return [];
  const groups = await humanSdk.rpc.group.findGroups(GROUP_PAGE_LIMIT, {
    ownerIn: normalizeAddressList(ownerIn),
  });
  return normalizeGroups(groups);
}

function getProxyAddressFromReceipt(receipt) {
  for (const log of receipt?.logs || []) {
    try {
      const decoded = decodeEventLog({
        abi: [PROXY_CREATION_EVENT],
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      if (decoded?.eventName === 'ProxyCreation' && decoded.args?.proxy) {
        return getAddress(decoded.args.proxy);
      }
    } catch {}
  }

  return null;
}

function getBaseGroupAddressFromReceipt(receipt) {
  for (const log of receipt?.logs || []) {
    try {
      const decoded = decodeEventLog({
        abi: [BASE_GROUP_CREATED_EVENT],
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      if (decoded?.eventName === 'BaseGroupCreated' && decoded.args?.group) {
        return getAddress(decoded.args.group);
      }
    } catch {}
  }

  return null;
}

function formatDateTime(timestampSeconds) {
  if (!timestampSeconds) return 'No expiry';
  return new Date(timestampSeconds * 1000).toLocaleString();
}

async function loadAllPages(query, maxPages = 6) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const hasPage = await query.queryNextPage();
    if (!hasPage || !query.currentPage) break;
    rows.push(...query.currentPage.results);
    if (!query.currentPage.hasMore) break;
  }
  return rows;
}

async function resolveAddress(rawInput) {
  const query = String(rawInput || '').trim();
  if (!query) throw new Error('Enter a Circles address or searchable name.');
  if (isAddress(query)) return getAddress(query);
  if (!humanSdk) throw new Error('Connected account is not ready.');

  const results = await humanSdk.rpc.profile.searchByAddressOrName(query, 20, 0);
  const exactMatch = results.find((entry) => {
    const name = String(entry?.name || '').trim().toLowerCase();
    const registeredName = String(entry?.registeredName || '').trim().toLowerCase();
    return name === query.toLowerCase() || registeredName === query.toLowerCase();
  });
  const chosen = exactMatch || results.find((entry) => entry?.address && isAddress(entry.address));
  if (!chosen?.address) throw new Error('No matching Circles avatar found.');
  return getAddress(chosen.address);
}

async function loadAdminGroups(preserveResult = false) {
  if (!connectedAddress || !humanSdk) return;

  const loadRequestId = ++adminGroupsLoadRequestId;
  hideAllSections();
  if (!preserveResult) hideResult();
  setStatus('Loading groups…', 'pending');
  groupsListEl.innerHTML = '<p class="muted">Loading groups…</p>';
  showGroupsView(true);

  let directGroups = [];
  try {
    directGroups = await fetchGroupsByOwners([connectedAddress]);
    if (loadRequestId !== adminGroupsLoadRequestId) return;

    activeGroups = directGroups;
    renderGroupsList();
    if (currentView === 'groups') {
      showGroupsView(true);
    }
  } catch (err) {
    if (loadRequestId !== adminGroupsLoadRequestId) return;

    activeGroups = [];
    renderGroupsList();
    if (currentView === 'groups') {
      showGroupsView(true);
      showResult('error', `Could not load directly owned groups: ${decodeError(err)}`);
    }
  }

  try {
    if (loadRequestId !== adminGroupsLoadRequestId) return;

    const sessionSafes = getSessionOwnerSafes(connectedAddress);
    const serviceSafes = await fetchOwnerSafeCandidates(connectedAddress);
    if (loadRequestId !== adminGroupsLoadRequestId) return;

    const allSafes = normalizeAddressList([...serviceSafes, ...sessionSafes]);
    if (!allSafes.length) {
      if (currentView === 'groups') {
        setStatus('Connected', 'success');
      }
      return;
    }

    const verifiedSafes = await getVerifiedOwnerSafes(allSafes, connectedAddress);
    if (loadRequestId !== adminGroupsLoadRequestId) return;

    setSessionOwnerSafes(connectedAddress, verifiedSafes);
    if (!verifiedSafes.length) {
      if (currentView === 'groups') {
        setStatus('Connected', 'success');
      }
      return;
    }

    const safeGroups = await fetchGroupsByOwners(verifiedSafes);
    if (loadRequestId !== adminGroupsLoadRequestId) return;

    activeGroups = mergeGroups(directGroups, safeGroups);
    renderGroupsList();
    if (currentView === 'groups') {
      showGroupsView(true);
      setStatus('Connected', 'success');
    }
  } catch (err) {
    if (loadRequestId !== adminGroupsLoadRequestId) return;

    activeGroups = directGroups;
    renderGroupsList();
    if (currentView === 'groups') {
      showGroupsView(true);
      setStatus('Connected', 'success');
      showResult('error', `Could not load Safe-backed groups: ${decodeError(err)}`);
    }
  }
}

async function hydrateGroupListImages() {
  if (!humanSdk || !activeGroups.length) return;

  const missingGroups = activeGroups.filter((group) => !groupPreviewImageByAddress.has(group.group.toLowerCase()));
  if (!missingGroups.length) return;

  await Promise.all(
    missingGroups.map(async (group) => {
      try {
        const profile = await humanSdk.rpc.profile.getProfileByAddress(group.group);
        const imageUrl = String(profile?.previewImageUrl || profile?.imageUrl || '').trim();
        groupPreviewImageByAddress.set(group.group.toLowerCase(), imageUrl || null);
      } catch {
        groupPreviewImageByAddress.set(group.group.toLowerCase(), null);
      }
    })
  );

  renderGroupsList();
}

function renderGroupsList() {
  if (!activeGroups.length) {
    groupsListEl.innerHTML = '<p class="muted">No groups yet.</p>';
    return;
  }

  groupsListEl.innerHTML = activeGroups
    .map((group) => {
      const subtitle = group.symbol || group.group;
      const previewImage = groupPreviewImageByAddress.get(group.group.toLowerCase()) || '';
      return `
        <div class="list-row group-list-row">
          <div class="group-list-info">
            <div class="group-list-avatar"${previewImage ? ` style="background-image: url('${escapeHtml(previewImage)}')"` : ''}></div>
            <div class="list-row-main group-list-main">
              <div class="list-row-title">${escapeHtml(group.name || group.group)}</div>
              <div class="list-row-meta">${escapeHtml(subtitle)}</div>
              <div class="list-row-meta mono group-list-address">${escapeHtml(group.group)}</div>
            </div>
          </div>
          <div class="list-row-action">
            <button class="open-group-btn btn-inline" data-group="${escapeHtml(group.group)}">Open</button>
          </div>
        </div>
      `;
    })
    .join('');

  groupsListEl.querySelectorAll('.open-group-btn').forEach((button) => {
    button.addEventListener('click', () => openGroup(button.dataset.group));
  });

  void hydrateGroupListImages();
}

async function createGroup() {
  const rawName = createGroupNameInput.value.trim();
  const symbol = createGroupSymbolInput.value.trim().toUpperCase();
  const description = createGroupDescriptionInput.value.trim();

  if (!rawName) {
    showResult('error', 'Group name is required.');
    return;
  }
  if (rawName.length > MAX_GROUP_NAME_LENGTH) {
    showResult('error', `Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer.`);
    return;
  }
  if (!/^[A-Z0-9]{2,8}$/.test(symbol)) {
    showResult('error', 'Ticker must be 2-8 uppercase letters or numbers.');
    return;
  }
  if (!description) {
    showResult('error', 'Description is required.');
    return;
  }
  if (!connectedAddress || !humanSdk) {
    showResult('error', 'Connect a wallet first.');
    return;
  }

  const profile = {
    name: rawName,
    description: buildDescriptionWithExternalLink(description, readExternalLinkDraft('create')) || undefined,
    previewImageUrl: createImageDataUrl || undefined,
  };

  createGroupBtn.disabled = true;
  showResult('pending', 'Preparing owner Safe, group Safe, and group deployment…');

  try {
    const safeAbi = safeSingletonDeployment?.abi;
    if (!safeAbi) throw new Error('Safe deployment metadata unavailable.');
    const proxyFactoryAbi = proxyFactoryDeployment?.abi;
    if (!proxyFactoryAbi) throw new Error('Safe proxy factory deployment metadata unavailable.');

    const profileCid = await humanSdk.profiles.create(profile);
    const metadataDigest = cidV0ToHex(profileCid);

    const ownerSaltNonce = randomSaltNonce();
    const safeSingletonAddress = getDeploymentAddress(safeSingletonDeployment);
    const proxyFactoryAddress = getDeploymentAddress(proxyFactoryDeployment);
    const fallbackHandlerAddress = getDeploymentAddress(compatibilityFallbackHandlerDeployment);

    const ownerSafeSetupData = encodeFunctionData({
      abi: safeAbi,
      functionName: 'setup',
      args: [
        [connectedAddress],
        1n,
        zeroAddress,
        '0x',
        fallbackHandlerAddress,
        zeroAddress,
        0n,
        zeroAddress,
      ],
    });
    const deployOwnerSafeData = encodeFunctionData({
      abi: proxyFactoryAbi,
      functionName: 'createProxyWithNonce',
      args: [safeSingletonAddress, ownerSafeSetupData, BigInt(ownerSaltNonce)],
    });

    const ownerDeploymentPreflight = await publicClient.call({
      to: proxyFactoryAddress,
      data: deployOwnerSafeData,
      account: connectedAddress,
    });
    const predictedOwnerSafe = getAddress(
      decodeFunctionResult({
        abi: proxyFactoryAbi,
        functionName: 'createProxyWithNonce',
        data: ownerDeploymentPreflight.data,
      })
    );

    const groupSafeSaltNonce = randomSaltNonce();
    const groupSafeSetupData = encodeFunctionData({
      abi: safeAbi,
      functionName: 'setup',
      args: [
        [predictedOwnerSafe],
        1n,
        zeroAddress,
        '0x',
        fallbackHandlerAddress,
        zeroAddress,
        0n,
        zeroAddress,
      ],
    });
    const deployGroupSafeData = encodeFunctionData({
      abi: proxyFactoryAbi,
      functionName: 'createProxyWithNonce',
      args: [safeSingletonAddress, groupSafeSetupData, BigInt(groupSafeSaltNonce)],
    });

    const groupSafeDeploymentPreflight = await publicClient.call({
      to: proxyFactoryAddress,
      data: deployGroupSafeData,
      account: predictedOwnerSafe,
    });
    const predictedGroupSafe = getAddress(
      decodeFunctionResult({
        abi: proxyFactoryAbi,
        functionName: 'createProxyWithNonce',
        data: groupSafeDeploymentPreflight.data,
      })
    );

    const createGroupTx = humanSdk.core.baseGroupFactory.createBaseGroup(
      predictedOwnerSafe,
      predictedOwnerSafe,
      predictedOwnerSafe,
      [],
      rawName,
      symbol,
      metadataDigest
    );

    await preflightEthCall({
      label: 'Group creation',
      to: createGroupTx.to,
      data: createGroupTx.data,
      value: createGroupTx.value || 0n,
      account: predictedOwnerSafe,
    });

    const batchedTransactions = [
      formatTxForHost({
        to: proxyFactoryAddress,
        data: deployOwnerSafeData,
        value: 0n,
      }),
      formatTxForHost(
        buildSafeExecTransaction(connectedAddress, predictedOwnerSafe, {
          to: proxyFactoryAddress,
          data: deployGroupSafeData,
          value: 0n,
        })
      ),
      formatTxForHost(buildSafeExecTransaction(connectedAddress, predictedOwnerSafe, createGroupTx)),
    ];

    showResult('pending', 'Deploying both Safes and creating the group in one approval…');
    lastTxHashes = await sendTransactions(batchedTransactions);
    const receipts = await waitForReceipts(lastTxHashes);

    const ownerSafeReceipt = receipts[0] || null;
    const groupSafeReceipt = receipts[1] || null;
    const baseGroupReceipt = receipts[2] || null;

    const resolvedOwnerSafe = getProxyAddressFromReceipt(ownerSafeReceipt) || predictedOwnerSafe;
    const resolvedGroupSafe = getProxyAddressFromReceipt(groupSafeReceipt) || predictedGroupSafe;
    const resolvedGroupAddress = getBaseGroupAddressFromReceipt(baseGroupReceipt);

    if (!resolvedGroupAddress) {
      throw new Error('Group creation was submitted but no BaseGroupCreated event was found.');
    }

    addSessionOwnerSafe(connectedAddress, resolvedOwnerSafe);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult(
      'success',
      `Group created: <a href="${explorerAvatarUrl(resolvedGroupAddress)}" target="_blank" rel="noopener">${resolvedGroupAddress}</a><br><span class="muted">Owner Safe:</span> ${resolvedOwnerSafe}<br><span class="muted">Group Safe:</span> ${resolvedGroupSafe}${links}`
    );

    resetCreateForm();
    await loadAdminGroups(true);
    await openGroup(resolvedGroupAddress, true);
  } catch (err) {
    if (isPasskeyAutoConnectError(err)) {
      showResult(
        'error',
        'Passkey auto-connect failed in the host app. Re-open wallet connect and choose the same wallet again, then retry group creation.'
      );
    } else {
      showResult('error', `Group creation failed: ${decodeError(err)}`);
    }
  } finally {
    updateCreateButtonState();
  }
}

async function populateProfileEditor() {
  if (!activeGroupAvatar) return;

  const profile = await activeGroupAvatar.profile.get().catch(() => undefined);
  const extracted = extractExternalLinkFromDescription(profile?.description);
  const fallbackLink = Array.isArray(profile?.extensions?.links) ? profile.extensions.links[0] : null;
  const resolvedLink = {
    label: extracted.link.label || String(fallbackLink?.label || ''),
    url: extracted.link.url || String(fallbackLink?.url || ''),
  };
  profileDescriptionInput.value = extracted.description;
  renderMarkdown(groupDescriptionDisplay, buildDescriptionWithExternalLink(extracted.description, resolvedLink));

  if (activeGroupMeta?.group) {
    const imageUrl = String(profile?.previewImageUrl || profile?.imageUrl || '').trim();
    groupPreviewImageByAddress.set(activeGroupMeta.group.toLowerCase(), imageUrl || null);
  }

  profileImageSourceUrl = String(profile?.previewImageUrl || '');
  profileImageSelectedDataUrl = '';
  renderImagePreview(profileImagePreviewWrap, profileImagePreview, getProfileImageSrc());
  updateGroupCoverDisplay(getProfileImageSrc());

  setExternalLinkDraft('profile', resolvedLink);
  syncExternalLinkInputs('profile');
}

function getMembersTotalCount() {
  const count = Number(activeGroupMeta?.memberCount);
  return Number.isFinite(count) && count >= 0 ? count : cachedMembers.length;
}

function updateMembersToolbar() {
  const totalCount = getMembersTotalCount();
  membersTotalCountEl.textContent = `${totalCount} member${totalCount === 1 ? '' : 's'}`;
  membersPageLabelEl.textContent = `Page ${currentMembersPageIndex + 1}`;
  membersPrevBtn.disabled = currentMembersPageIndex === 0;
  membersNextBtn.disabled = !membersHasMorePages && currentMembersPageIndex >= memberPages.length - 1;
}

async function hydrateMemberNames(rows) {
  await Promise.all(
    rows.map(async (row) => {
      const key = row.member.toLowerCase();
      if (memberNamesByAddress.has(key)) return;

      try {
        const profile = await humanSdk.rpc.profile.getProfileByAddress(row.member);
        const name = String(profile?.name || profile?.registeredName || '').trim();
        memberNamesByAddress.set(key, name || row.member);
      } catch {
        memberNamesByAddress.set(key, row.member);
      }
    })
  );
}

function renderMembersPage() {
  updateMembersToolbar();

  const rows = memberPages[currentMembersPageIndex] || [];
  if (!rows.length) {
    membersListEl.innerHTML = '<p class="muted">No members yet.</p>';
    return;
  }

  membersListEl.innerHTML = rows
    .map((row) => {
      const memberLabel = memberNamesByAddress.get(row.member.toLowerCase()) || row.member;
      return `
        <div class="list-row search-result-row">
          <div class="list-row-main">
            <div class="list-row-title">${escapeHtml(memberLabel)}</div>
            <div class="list-row-meta mono">${escapeHtml(row.member)}</div>
          </div>
          <button class="remove-member-btn btn-tonal" data-member="${escapeHtml(row.member)}">Remove</button>
        </div>
      `;
    })
    .join('');

  membersListEl.querySelectorAll('.remove-member-btn').forEach((button) => {
    button.addEventListener('click', () => removeMember(button.dataset.member));
  });
}

async function ensureMembersPage(pageIndex) {
  if (!membersQuery) return false;
  if (memberPages[pageIndex]) return true;

  while (memberPages.length <= pageIndex) {
    const hasPage = await membersQuery.queryNextPage();
    if (!hasPage || !membersQuery.currentPage) {
      membersHasMorePages = false;
      return false;
    }

    const pageRows = membersQuery.currentPage.results || [];
    memberPages.push(pageRows);
    cachedMembers.push(...pageRows);
    await hydrateMemberNames(pageRows);
    membersHasMorePages = Boolean(membersQuery.currentPage.hasMore);

    if (!membersHasMorePages && memberPages.length <= pageIndex && pageRows.length === 0) {
      return false;
    }
  }

  return Boolean(memberPages[pageIndex]);
}

async function goToMembersPage(pageIndex) {
  if (pageIndex < 0) return;

  membersListEl.innerHTML = '<p class="muted">Loading members…</p>';
  const ready = await ensureMembersPage(pageIndex);
  if (!ready) {
    renderMembersPage();
    return;
  }

  currentMembersPageIndex = pageIndex;
  renderMembersPage();
}

async function loadMembers() {
  if (!humanSdk || !activeGroupMeta) return;

  const groupAddress = activeGroupMeta.group;
  const requestId = ++membersLoadRequestId;
  cachedMembers = [];
  memberPages = [];
  memberNamesByAddress = new Map();
  membersHasMorePages = false;
  currentMembersPageIndex = 0;
  membersQuery = humanSdk.groups.getMembers(groupAddress, MEMBER_PAGE_LIMIT);
  loadedMembersGroupAddress = null;
  membersListEl.innerHTML = '<p class="muted">Loading members…</p>';
  updateMembersToolbar();

  try {
    await goToMembersPage(0);
    if (requestId !== membersLoadRequestId || activeGroupMeta?.group !== groupAddress) return;
    loadedMembersGroupAddress = groupAddress;
  } catch (err) {
    if (requestId !== membersLoadRequestId || activeGroupMeta?.group !== groupAddress) return;
    membersListEl.innerHTML = `<p class="muted">Could not load members: ${escapeHtml(decodeError(err))}</p>`;
  }
}

function clearOwnerSafeSearchResults(message = '') {
  ownerSafeSearchResultsEl.innerHTML = message ? `<p class="muted">${escapeHtml(message)}</p>` : '';
}

function renderOwnerSafeSearchResults(results) {
  if (!results || !results.length) {
    clearOwnerSafeSearchResults('No matches found.');
    return;
  }

  const entries = results
    .filter((entry) => entry?.address && isAddress(entry.address))
    .slice(0, 10);

  ownerSafeSearchResultsEl.innerHTML = entries
    .map((entry) => {
      const address = getAddress(entry.address);
      const isAlreadyOwner = ownerSafeOwners.some(
        (owner) => owner.toLowerCase() === address.toLowerCase()
      );
      return `
        <div class="list-row search-result-row">
          <div class="list-row-main">
            <div class="list-row-title">${escapeHtml(entry.name || entry.registeredName || address)}</div>
            <div class="list-row-meta mono">${escapeHtml(address)}</div>
          </div>
          <div class="list-row-action-stack">
            <span class="chip">${isAlreadyOwner ? 'Admin' : 'Not an admin'}</span>
            <button class="pick-owner-safe-btn btn-inline" data-owner="${escapeHtml(address)}" ${isAlreadyOwner ? 'disabled' : ''}>
              ${isAlreadyOwner ? 'Added' : 'Add'}
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  ownerSafeSearchResultsEl.querySelectorAll('.pick-owner-safe-btn').forEach((button) => {
    button.addEventListener('click', () => {
      addOwnerInput.value = button.dataset.owner || '';
      void addOwnerToOwnerSafe(button.dataset.owner || '');
    });
  });
}

async function updateOwnerSafeSearchResults() {
  const query = addOwnerInput.value.trim();
  if (ownerSearchDebounceTimer) {
    clearTimeout(ownerSearchDebounceTimer);
    ownerSearchDebounceTimer = null;
  }

  if (!query || query.length < 2) {
    clearOwnerSafeSearchResults();
    return;
  }

  if (isAddress(query)) {
    clearOwnerSafeSearchResults('Address detected. Click Add Owner.');
    return;
  }

  const requestId = ++ownerSearchRequestId;
  clearOwnerSafeSearchResults('Searching…');
  ownerSearchDebounceTimer = setTimeout(async () => {
    try {
      if (!humanSdk) return;
      const results = await humanSdk.rpc.profile.searchByAddressOrName(query, 20, 0);
      if (requestId !== ownerSearchRequestId) return;
      renderOwnerSafeSearchResults(results);
    } catch {
      if (requestId !== ownerSearchRequestId) return;
      clearOwnerSafeSearchResults('Search failed. Try again.');
    } finally {
      if (requestId === ownerSearchRequestId) ownerSearchDebounceTimer = null;
    }
  }, 180);
}

function clearMemberSearchResults(message = '') {
  memberSearchResultsEl.innerHTML = message ? `<p class="muted">${escapeHtml(message)}</p>` : '';
}

async function renderMemberSearchResults(results) {
  if (!results || !results.length) {
    clearMemberSearchResults('No matches found.');
    return;
  }

  const entries = results
    .filter((entry) => entry?.address && isAddress(entry.address))
    .slice(0, 10);

  const statuses = await Promise.all(
    entries.map(async (entry) => {
      const address = getAddress(entry.address);
      const cachedStatus = cachedMembers.some(
        (member) => member.member.toLowerCase() === address.toLowerCase()
      );
      if (cachedStatus || !activeGroupAvatar) {
        return { address, isAlreadyMember: cachedStatus };
      }

      try {
        return {
          address,
          isAlreadyMember: await activeGroupAvatar.trust.isTrusting(address),
        };
      } catch {
        return { address, isAlreadyMember: false };
      }
    })
  );

  const statusByAddress = new Map(
    statuses.map((entry) => [entry.address.toLowerCase(), entry.isAlreadyMember])
  );

  memberSearchResultsEl.innerHTML = entries
    .map((entry) => {
      const address = getAddress(entry.address);
      const isAlreadyMember = statusByAddress.get(address.toLowerCase()) || false;
      return `
        <div class="list-row search-result-row">
          <div class="list-row-main">
            <div class="list-row-title">${escapeHtml(entry.name || entry.registeredName || address)}</div>
            <div class="list-row-meta mono">${escapeHtml(address)}</div>
          </div>
          <div class="list-row-action-stack">
            <span class="chip">${isAlreadyMember ? 'Member' : 'Not a member'}</span>
            <button class="pick-member-btn btn-inline" data-member="${escapeHtml(address)}" ${isAlreadyMember ? 'disabled' : ''}>
              ${isAlreadyMember ? 'Added' : 'Add'}
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  memberSearchResultsEl.querySelectorAll('.pick-member-btn').forEach((button) => {
    button.addEventListener('click', () => addMember(button.dataset.member));
  });
}

async function updateMemberSearchResults() {
  const query = memberQueryInput.value.trim();
  if (memberSearchDebounceTimer) {
    clearTimeout(memberSearchDebounceTimer);
    memberSearchDebounceTimer = null;
  }

  if (!query || query.length < 2) {
    clearMemberSearchResults();
    return;
  }

  if (isAddress(query)) {
    clearMemberSearchResults('Address detected. Click Add to trust this member.');
    return;
  }

  const requestId = ++memberSearchRequestId;
  clearMemberSearchResults('Searching…');
  memberSearchDebounceTimer = setTimeout(async () => {
    try {
      if (!humanSdk) return;
      const results = await humanSdk.rpc.profile.searchByAddressOrName(query, 20, 0);
      if (requestId !== memberSearchRequestId) return;
      await renderMemberSearchResults(results);
    } catch {
      if (requestId !== memberSearchRequestId) return;
      clearMemberSearchResults('Search failed. Try again.');
    } finally {
      if (requestId === memberSearchRequestId) memberSearchDebounceTimer = null;
    }
  }, 180);
}

function clearSendSearchResults(message = '') {
  sendSearchResultsEl.innerHTML = message ? `<p class="muted">${escapeHtml(message)}</p>` : '';
}

function renderSendSearchResults(results) {
  if (!results || !results.length) {
    clearSendSearchResults('No matches found.');
    return;
  }

  sendSearchResultsEl.innerHTML = results
    .filter((entry) => entry?.address && isAddress(entry.address))
    .slice(0, 10)
    .map((entry) => {
      const address = getAddress(entry.address);
      return `
        <div class="list-row">
          <div class="list-row-main">
            <div class="list-row-title">${escapeHtml(entry.name || entry.registeredName || address)}</div>
            <div class="list-row-meta mono">${escapeHtml(address)}</div>
          </div>
          <button class="pick-send-recipient-btn btn-inline" data-recipient="${escapeHtml(address)}">Use</button>
        </div>
      `;
    })
    .join('');

  sendSearchResultsEl.querySelectorAll('.pick-send-recipient-btn').forEach((button) => {
    button.addEventListener('click', () => {
      sendRecipientInput.value = button.dataset.recipient || '';
      clearSendSearchResults();
    });
  });
}

async function updateSendSearchResults() {
  const query = sendRecipientInput.value.trim();
  if (sendSearchDebounceTimer) {
    clearTimeout(sendSearchDebounceTimer);
    sendSearchDebounceTimer = null;
  }

  if (!query || query.length < 2) {
    clearSendSearchResults();
    return;
  }

  if (isAddress(query)) {
    clearSendSearchResults('Address detected. Enter an amount and send.');
    return;
  }

  const requestId = ++sendSearchRequestId;
  clearSendSearchResults('Searching…');
  sendSearchDebounceTimer = setTimeout(async () => {
    try {
      if (!humanSdk) return;
      const results = await humanSdk.rpc.profile.searchByAddressOrName(query, 20, 0);
      if (requestId !== sendSearchRequestId) return;
      renderSendSearchResults(results);
    } catch {
      if (requestId !== sendSearchRequestId) return;
      clearSendSearchResults('Search failed. Try again.');
    } finally {
      if (requestId === sendSearchRequestId) sendSearchDebounceTimer = null;
    }
  }, 180);
}

async function addMember(preselectedAddress = null) {
  if (!activeGroupAvatar) {
    showResult('error', 'Open a group first.');
    return;
  }

  let memberAddress;
  try {
    memberAddress = preselectedAddress
      ? getAddress(preselectedAddress)
      : await resolveAddress(memberQueryInput.value);
  } catch (err) {
    showResult('error', decodeError(err));
    return;
  }

  addMemberBtn.disabled = true;
  showResult('pending', 'Adding member…');

  try {
    lastTxHashes = [];
    await activeGroupAvatar.trust.add(memberAddress);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult('success', `Member added: ${memberAddress}.${links}`);
    memberQueryInput.value = '';
    clearMemberSearchResults();
    await loadMembers();
  } catch (err) {
    showResult('error', `Could not add member: ${decodeError(err)}`);
  } finally {
    addMemberBtn.disabled = false;
  }
}

async function removeMember(rawAddress) {
  if (!activeGroupAvatar || !isAddress(rawAddress)) {
    showResult('error', 'Member address is invalid.');
    return;
  }

  showResult('pending', `Removing member ${rawAddress}…`);

  try {
    lastTxHashes = [];
    await activeGroupAvatar.trust.remove(getAddress(rawAddress));
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult('success', `Member removed: ${rawAddress}.${links}`);
    await loadMembers();
  } catch (err) {
    showResult('error', `Could not remove member: ${decodeError(err)}`);
  }
}

async function loadTreasuryPanels() {
  if (!humanSdk || !activeGroupMeta || !activeGroupAvatar) return;

  overviewCollateralListEl.innerHTML = '<p class="muted">Loading treasury balances…</p>';
  overviewHoldersListEl.innerHTML = `<p class="muted">Loading ${escapeHtml(getActiveTokenSymbol())} holders…</p>`;
  overviewGroupTypeEl.textContent = 'Loading…';
  overviewTotalSupplyEl.textContent = 'Loading…';
  mintableDisplay.textContent = 'Max: loading…';

  const [totalSupplyResult, collateralResult, holdersResult, mintableResult] = await Promise.allSettled([
    activeGroupAvatar.balances.getTotalSupply(),
    humanSdk.groups.getCollateral(activeGroupMeta.group),
    loadAllPages(humanSdk.groups.getHolders(activeGroupMeta.group, GROUP_PAGE_LIMIT), 2),
    activeGroupMeta.mintHandler
      ? activeGroupAvatar.transfer.getMaxAmount(activeGroupMeta.mintHandler)
      : Promise.resolve(0n),
  ]);

  overviewGroupTypeEl.textContent = getFallbackGroupType(activeGroupMeta.type);

  if (totalSupplyResult.status === 'fulfilled') {
    overviewTotalSupplyEl.textContent = formatActiveTokenAmount(BigInt(totalSupplyResult.value || 0n));
  } else {
    overviewTotalSupplyEl.textContent = 'Unavailable';
  }

  if (mintableResult.status === 'fulfilled') {
    cachedMintableAmount = BigInt(mintableResult.value || 0);
    mintableDisplay.textContent = `Max: ${formatActiveTokenAmount(cachedMintableAmount)}`;
  } else {
    cachedMintableAmount = 0n;
    mintableDisplay.textContent = 'Max: unavailable';
  }

  if (collateralResult.status === 'fulfilled') {
    const collateral = collateralResult.value || [];
    if (!collateral.length) {
      overviewCollateralListEl.innerHTML = '<p class="muted">No treasury collateral found.</p>';
    } else {
      overviewCollateralListEl.innerHTML = collateral
        .map(
          (balance) => `
            <div class="list-row">
              <div class="list-row-main">
                <div class="list-row-title">${escapeHtml(balance.tokenAddress)}</div>
                <div class="list-row-meta mono">${escapeHtml(balance.tokenOwner || activeGroupMeta.treasury || '')}</div>
              </div>
              <span class="chip">${escapeHtml(attoToCirclesString(getCollateralAmount(balance)))} CRC</span>
            </div>
          `
        )
        .join('');
    }
  } else {
    overviewCollateralListEl.innerHTML = `<p class="muted">Could not load treasury data: ${escapeHtml(decodeError(collateralResult.reason))}</p>`;
  }

  if (holdersResult.status === 'fulfilled') {
    const holders = holdersResult.value || [];
    if (!holders.length) {
      overviewHoldersListEl.innerHTML = `<p class="muted">No ${escapeHtml(getActiveTokenSymbol())} holders found.</p>`;
    } else {
      overviewHoldersListEl.innerHTML = holders
        .map(
          (holder) => `
            <div class="list-row">
              <div class="list-row-main">
                <div class="list-row-title mono">${escapeHtml(holder.holder)}</div>
                <div class="list-row-meta">${Number(holder.fractionOwnership * 100).toFixed(2)}% ownership</div>
              </div>
              <span class="chip">${escapeHtml(formatActiveTokenAmount(holder.demurragedTotalBalance))}</span>
            </div>
          `
        )
        .join('');
    }
  } else {
    overviewHoldersListEl.innerHTML = `<p class="muted">Could not load token holders: ${escapeHtml(decodeError(holdersResult.reason))}</p>`;
  }
}

async function saveProfile() {
  if (!activeGroupAvatar || !activeGroupMeta) {
    showResult('error', 'Open a group first.');
    return;
  }

  saveProfileBtn.disabled = true;
  showResult('pending', 'Saving profile metadata…');

  try {
    const existingProfile = (await activeGroupAvatar.profile.get().catch(() => undefined)) || {};
    const nextExtensions = { ...(existingProfile.extensions || {}) };
    delete nextExtensions.links;
    const nextProfile = {
      name: existingProfile.name || activeGroupMeta.name || activeGroupMeta.symbol || 'Group',
      description:
        buildDescriptionWithExternalLink(
          profileDescriptionInput.value,
          readExternalLinkDraft('profile')
        ) || undefined,
      previewImageUrl: getProfileImageSrc() || undefined,
      imageUrl: existingProfile.imageUrl || undefined,
      location: existingProfile.location || undefined,
      geoLocation: existingProfile.geoLocation || undefined,
      extensions: Object.keys(nextExtensions).length ? nextExtensions : undefined,
    };

    lastTxHashes = [];
    await activeGroupAvatar.profile.update(nextProfile);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult('success', `Profile updated.${links}`);

    await populateProfileEditor();
  } catch (err) {
    showResult('error', `Could not update profile: ${decodeError(err)}`);
  } finally {
    saveProfileBtn.disabled = false;
  }
}

async function updateGroupAddressSetting({
  inputEl,
  buttonEl,
  currentValue,
  emptyError,
  unchangedError,
  pendingMessage,
  successMessage,
  failureMessage,
  setter,
}) {
  if (!activeGroupAvatar || !activeGroupMeta) {
    showResult('error', 'Open a group first.');
    return;
  }

  let nextAddress;
  try {
    nextAddress = getAddress(String(inputEl?.value || '').trim());
  } catch {
    showResult('error', emptyError);
    return;
  }

  if (currentValue && nextAddress.toLowerCase() === currentValue.toLowerCase()) {
    showResult('error', unchangedError);
    return;
  }

  buttonEl.disabled = true;
  showResult('pending', pendingMessage);

  try {
    lastTxHashes = [];
    await setter(nextAddress);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult('success', `${successMessage(nextAddress)}${links}`);
    inputEl.value = nextAddress;
    await openGroup(activeGroupMeta.group, true);
  } catch (err) {
    showResult('error', `${failureMessage}${decodeError(err)}`);
  } finally {
    buttonEl.disabled = false;
  }
}

async function updateGroupOwner() {
  if (!activeGroupAvatar || !activeGroupMeta) {
    showResult('error', 'Open a group first.');
    return;
  }

  let nextOwner;
  try {
    nextOwner = getAddress(String(ownerSafeInput.value || '').trim());
  } catch {
    showResult('error', 'Enter a valid owner Safe address.');
    return;
  }

  if (activeOwnerSafe && nextOwner.toLowerCase() === activeOwnerSafe.toLowerCase()) {
    showResult('error', 'That Safe is already the owner.');
    return;
  }

  updateOwnerBtn.disabled = true;
  showResult('pending', 'Updating owner Safe…');

  try {
    lastTxHashes = [];
    await activeGroupAvatar.setProperties.owner(nextOwner);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult('success', `Owner Safe updated to ${nextOwner}.${links}`);
    ownerSafeInput.value = nextOwner;
    await openGroup(activeGroupMeta.group, true);
  } catch (err) {
    showResult('error', `Could not update owner Safe: ${decodeError(err)}`);
  } finally {
    updateOwnerBtn.disabled = false;
  }
}

async function updateGroupService() {
  return updateGroupAddressSetting({
    inputEl: serviceAddressInput,
    buttonEl: updateServiceBtn,
    currentValue: activeGroupMeta?.service || '',
    emptyError: 'Enter a valid service address.',
    unchangedError: 'That address is already the service.',
    pendingMessage: 'Updating service address…',
    successMessage: (nextAddress) => `Service updated to ${nextAddress}.`,
    failureMessage: 'Could not update service address: ',
    setter: (nextAddress) => activeGroupAvatar.setProperties.service(nextAddress),
  });
}

async function updateGroupFeeCollection() {
  return updateGroupAddressSetting({
    inputEl: feeCollectionInput,
    buttonEl: updateFeeCollectionBtn,
    currentValue: activeGroupMeta?.feeCollection || '',
    emptyError: 'Enter a valid fee collection address.',
    unchangedError: 'That address is already the fee collection address.',
    pendingMessage: 'Updating fee collection address…',
    successMessage: (nextAddress) => `Fee collection updated to ${nextAddress}.`,
    failureMessage: 'Could not update fee collection address: ',
    setter: (nextAddress) => activeGroupAvatar.setProperties.feeCollection(nextAddress),
  });
}

async function updateMembershipCondition(enabled) {
  if (!activeGroupAvatar || !activeGroupMeta) {
    showResult('error', 'Open a group first.');
    return;
  }

  let condition;
  try {
    condition = getAddress(String(membershipConditionInput?.value || '').trim());
  } catch {
    showResult('error', 'Enter a valid membership condition address.');
    return;
  }

  const isAlreadyActive = activeMembershipConditions.some(
    (entry) => entry.toLowerCase() === condition.toLowerCase()
  );

  if (enabled && isAlreadyActive) {
    showResult('error', 'That membership condition is already enabled.');
    return;
  }

  if (!enabled && !isAlreadyActive) {
    showResult('error', 'That membership condition is not currently enabled.');
    return;
  }

  const activeButton = enabled ? enableMembershipConditionBtn : disableMembershipConditionBtn;
  const idleButton = enabled ? disableMembershipConditionBtn : enableMembershipConditionBtn;
  activeButton.disabled = true;
  idleButton.disabled = true;
  showResult('pending', enabled ? 'Enabling membership condition…' : 'Disabling membership condition…');

  try {
    lastTxHashes = [];
    await activeGroupAvatar.setProperties.membershipCondition(condition, enabled);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult(
      'success',
      `${enabled ? 'Enabled' : 'Disabled'} membership condition ${condition}.${links}`
    );
    membershipConditionInput.value = '';
    await loadMembershipConditions();
  } catch (err) {
    showResult(
      'error',
      `Could not ${enabled ? 'update' : 'remove'} membership condition: ${decodeError(err)}`
    );
  } finally {
    activeButton.disabled = false;
    idleButton.disabled = false;
  }
}

async function addOwnerToOwnerSafe(rawOwner = addOwnerInput.value) {
  if (!activeOwnerSafe || !isAddress(activeOwnerSafe)) {
    showResult('error', 'This group does not expose a manageable owner Safe.');
    return;
  }

  let nextOwner;
  try {
    nextOwner = getAddress(String(rawOwner || '').trim());
  } catch {
    showResult('error', 'Enter a valid owner address.');
    return;
  }

  if (!ownerSafeOwners.length || ownerSafeThreshold === null) {
    await loadOwnerSafeDetails();
  }

  if (ownerSafeOwners.some((owner) => owner.toLowerCase() === nextOwner.toLowerCase())) {
    showResult('error', 'That address is already an owner of the owner Safe.');
    return;
  }

  if (ownerSafeThreshold !== null && ownerSafeThreshold > 1) {
    showResult(
      'error',
      `This owner Safe uses threshold ${ownerSafeThreshold}. The app currently supports owner changes only for threshold 1 Safes.`
    );
    return;
  }

  const safeAbi = safeSingletonDeployment?.abi;
  if (!safeAbi) {
    showResult('error', 'Safe deployment metadata unavailable.');
    return;
  }

  addOwnerSafeBtn.disabled = true;
  showResult('pending', 'Adding owner to the owner Safe…');

  try {
    const nextThreshold = BigInt(ownerSafeThreshold || 1);
    const data = encodeFunctionData({
      abi: safeAbi,
      functionName: 'addOwnerWithThreshold',
      args: [nextOwner, nextThreshold],
    });

    const ownerSafeRunner = createSafeOwnerRunner(connectedAddress, activeOwnerSafe);
    lastTxHashes = [];
    await ownerSafeRunner.sendTransaction([
      {
        to: activeOwnerSafe,
        data,
        value: 0n,
      },
    ]);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult('success', `Owner added to ${activeOwnerSafe}.${links}`);
    addOwnerInput.value = '';
    clearOwnerSafeSearchResults();
    await loadOwnerSafeDetails();
  } catch (err) {
    showResult('error', `Could not add owner to the owner Safe: ${decodeError(err)}`);
  } finally {
    addOwnerSafeBtn.disabled = false;
  }
}

async function mintGroupCrc() {
  if (!activeGroupAvatar || !activeGroupMeta?.mintHandler) {
    showResult('error', 'This group is missing a mint handler.');
    return;
  }

  const amount = parseCirclesInputToAtto(mintAmountInput.value);
  if (amount === null || amount <= 0n) {
    showResult('error', `Enter a valid ${getActiveTokenSymbol()} amount.`);
    return;
  }

  if (cachedMintableAmount > 0n && amount > cachedMintableAmount) {
    showResult(
      'error',
      `Amount exceeds the currently transferable collateral (${formatActiveTokenAmount(cachedMintableAmount)}).`
    );
    return;
  }

  mintGroupBtn.disabled = true;
  showResult('pending', 'Routing collateral to the mint handler…');

  try {
    lastTxHashes = [];
    await activeGroupAvatar.transfer.advanced(activeGroupMeta.mintHandler, amount);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult('success', `Mint flow submitted for ${formatActiveTokenAmount(amount)}.${links}`);
    mintAmountInput.value = '';
    await loadTreasuryPanels();
  } catch (err) {
    showResult('error', `Could not mint ${getActiveTokenSymbol()}: ${decodeError(err)}`);
  } finally {
    mintGroupBtn.disabled = false;
  }
}

async function sendGroupCrc() {
  if (!activeGroupAvatar || !activeGroupMeta) {
    showResult('error', 'Open a group first.');
    return;
  }

  let recipient;
  try {
    recipient = await resolveAddress(sendRecipientInput.value);
  } catch (err) {
    showResult('error', decodeError(err));
    return;
  }

  const transferOptions = getGroupSendTransferOptions();
  let maxTransferableAmount = 0n;
  try {
    maxTransferableAmount = await activeGroupAvatar.transfer.getMaxAmountAdvanced(
      recipient,
      transferOptions
    );
  } catch (err) {
    showResult('error', `Could not calculate max transferable ${getActiveTokenSymbol()}: ${decodeError(err)}`);
    return;
  }

  if (maxTransferableAmount <= 0n) {
    showResult('error', `No routable ${getActiveTokenSymbol()} found for that recipient.`);
    return;
  }

  const requestedAmount = parseCirclesInputToAtto(sendAmountInput.value);
  const amount = requestedAmount === null || requestedAmount <= 0n ? maxTransferableAmount : requestedAmount;

  if (amount > maxTransferableAmount) {
    showResult(
      'error',
      `Amount exceeds the current max flow (${formatActiveTokenAmount(maxTransferableAmount)}).`
    );
    return;
  }

  sendGroupBtn.disabled = true;
  showResult('pending', `Routing ${getActiveTokenSymbol()} through the trust graph…`);

  try {
    lastTxHashes = [];
    await activeGroupAvatar.transfer.advanced(recipient, amount, transferOptions);
    const links = lastTxHashes.length ? `<br>${txLinks(lastTxHashes)}` : '';
    showResult(
      'success',
      `Sent ${formatActiveTokenAmount(amount)} to ${recipient} via max-flow routing.${links}`
    );
    sendAmountInput.value = '';
    sendRecipientInput.value = '';
    clearSendSearchResults();
    await loadTreasuryPanels();
  } catch (err) {
    showResult('error', `Could not send ${getActiveTokenSymbol()}: ${decodeError(err)}`);
  } finally {
    sendGroupBtn.disabled = false;
  }
}

async function openGroup(groupAddress, preserveResult = false) {
  if (!connectedAddress || !humanSdk || !isAddress(groupAddress)) return;

  let groupMeta = getResolvedGroupMeta(groupAddress);
  if (!groupMeta) {
    const lookupResults = await humanSdk.rpc.group.findGroups(1, {
      groupAddressIn: [getAddress(groupAddress)],
    });
    groupMeta = lookupResults[0] || null;
  }

  if (!groupMeta) {
    showResult('error', 'Could not find that group.');
    return;
  }

  hideAllSections();
  if (!preserveResult) showResult('pending', `Opening group ${groupAddress}…`);

  try {
    activeGroupMeta = normalizeGroupMeta(groupMeta);
    activeOwnerSafe =
      activeGroupMeta.owner && isAddress(activeGroupMeta.owner) ? getAddress(activeGroupMeta.owner) : null;

    const runner =
      activeOwnerSafe && activeOwnerSafe.toLowerCase() !== connectedAddress.toLowerCase()
        ? createSafeOwnerRunner(connectedAddress, activeOwnerSafe)
        : createRunner(activeOwnerSafe || connectedAddress);

    activeGroupSdk = new CirclesClient(undefined, runner);
    activeGroupAvatar = await activeGroupSdk.getBaseGroupAvatar(activeGroupMeta.group);

    groupSymbolDisplay.textContent = activeGroupMeta.symbol || 'GROUP';
    groupNameDisplay.textContent = activeGroupMeta.name || activeGroupMeta.group;
    updateTokenUiCopy();
    groupAddressDisplay.textContent = shortenAddress(activeGroupMeta.group);
    groupAddressDisplay.title = activeGroupMeta.group;
    groupAddressDisplay.href = explorerAvatarUrl(activeGroupMeta.group);
    setAddressLink(overviewGroupAddressEl, activeGroupMeta.group);
    setAddressLink(overviewOwnerSafeEl, activeOwnerSafe);
    setAddressLink(overviewTreasuryAddressEl, activeGroupMeta.treasury);
    setAddressLink(overviewMintHandlerEl, activeGroupMeta.mintHandler);
    setAddressLink(overviewServiceAddressEl, activeGroupMeta.service);
    setAddressLink(overviewFeeCollectionAddressEl, activeGroupMeta.feeCollection);
    ownerSafeInput.value = activeOwnerSafe || '';
    serviceAddressInput.value = activeGroupMeta.service || '';
    feeCollectionInput.value = activeGroupMeta.feeCollection || '';
    resetMembersState();
    resetOwnerSafeState();
    resetMembershipConditionsState();
    mintAmountInput.value = '';
    sendRecipientInput.value = '';
    sendAmountInput.value = '';
    clearSendSearchResults();

    showGroupView();
    await Promise.all([populateProfileEditor(), loadTreasuryPanels(), loadMembershipConditions()]);
    if (!preserveResult) hideResult();
  } catch (err) {
    showResult('error', `Could not open group: ${decodeError(err)}`);
  }
}

function fillMintMax() {
  if (cachedMintableAmount <= 0n) return;
  mintAmountInput.value = attoToCirclesString(cachedMintableAmount);
}

onWalletChange(async (address) => {
  try {
    connectedAddress = address ? getAddress(address) : null;
  } catch {
    connectedAddress = null;
  }

  humanSdk = null;
  activeGroupSdk = null;
  activeGroupAvatar = null;
  activeGroupMeta = null;
  activeOwnerSafe = null;
  activeGroups = [];
  cachedMembers = [];
  memberPages = [];
  memberNamesByAddress = new Map();
  membersQuery = null;
  currentMembersPageIndex = 0;
  membersHasMorePages = false;
  cachedMintableAmount = 0n;
  lastTxHashes = [];
  resetOwnerSafeState();
  resetMembershipConditionsState();
  clearMemberSearchResults();
  clearSendSearchResults();
  showGroupManagementMenu();

  if (!connectedAddress) {
    showDisconnectedState();
    return;
  }

  setStatus('Checking wallet…', 'pending');

  try {
    humanSdk = new CirclesClient(undefined, createRunner(connectedAddress));
    await loadAdminGroups();
  } catch (err) {
    if (isPasskeyAutoConnectError(err)) {
      setStatus('Reconnect required', 'warning');
      showResult(
        'error',
        'Passkey auto-connect failed in the host app. Re-open wallet connect and choose your wallet again.'
      );
    } else {
      setStatus('Connection error', 'error');
      showResult('error', `Wallet initialization failed: ${decodeError(err)}`);
    }
  }
});

if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    if (!isPasskeyAutoConnectError(event.reason)) return;
    setStatus('Reconnect required', 'warning');
    showResult(
      'error',
      'Passkey auto-connect failed in the host app. Re-open wallet connect and choose your wallet again.'
    );
  });

  window.addEventListener('error', (event) => {
    if (!isPasskeyAutoConnectError(event.error || event.message)) return;
    setStatus('Reconnect required', 'warning');
    showResult(
      'error',
      'Passkey auto-connect failed in the host app. Re-open wallet connect and choose your wallet again.'
    );
  });
}

startCreateGroupBtn.addEventListener('click', () => {
  hideResult();
  showCreateView();
});
createGroupBtn.addEventListener('click', createGroup);
createGroupNameInput.addEventListener('input', updateCreateButtonState);
createGroupSymbolInput.addEventListener('input', () => {
  createGroupSymbolInput.value = createGroupSymbolInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  updateCreateButtonState();
});
createGroupDescriptionInput.addEventListener('input', updateCreateButtonState);
createGroupImageInput?.addEventListener('change', handleCreateImageChange);
clearCreateImageBtn?.addEventListener('click', () => {
  clearCreateImageSelection();
  updateCreateButtonState();
});
createLinkLabelInput?.addEventListener('input', (event) => {
  handleExternalLinkInput('create', 'label', event.target.value);
});
createLinkUrlInput?.addEventListener('input', (event) => {
  handleExternalLinkInput('create', 'url', event.target.value);
});

refreshGroupBtn.addEventListener('click', async () => {
  if (!activeGroupMeta) return;
  await openGroup(activeGroupMeta.group, true);
});
switchGroupsBtn.addEventListener('click', navigateToGroups);
document.querySelectorAll('[data-management-view]').forEach((button) => {
  button.addEventListener('click', () => showGroupManagementPanel(button.dataset.managementView));
});
document.querySelectorAll('[data-management-back="1"]').forEach((button) => {
  button.addEventListener('click', showGroupManagementMenu);
});

profileImageInput?.addEventListener('change', handleProfileImageChange);
clearProfileImageBtn?.addEventListener('click', clearProfileImageSelection);
profileLinkLabelInput?.addEventListener('input', (event) => {
  handleExternalLinkInput('profile', 'label', event.target.value);
});
profileLinkUrlInput?.addEventListener('input', (event) => {
  handleExternalLinkInput('profile', 'url', event.target.value);
});
updateOwnerBtn.addEventListener('click', updateGroupOwner);
updateServiceBtn.addEventListener('click', updateGroupService);
updateFeeCollectionBtn.addEventListener('click', updateGroupFeeCollection);
enableMembershipConditionBtn.addEventListener('click', () => updateMembershipCondition(true));
disableMembershipConditionBtn.addEventListener('click', () => updateMembershipCondition(false));
addOwnerInput.addEventListener('input', updateOwnerSafeSearchResults);
addOwnerSafeBtn.addEventListener('click', addOwnerToOwnerSafe);
saveProfileBtn.addEventListener('click', saveProfile);

memberQueryInput.addEventListener('input', updateMemberSearchResults);
addMemberBtn.addEventListener('click', () => addMember());
membersPrevBtn.addEventListener('click', () => {
  if (currentMembersPageIndex === 0) return;
  goToMembersPage(currentMembersPageIndex - 1);
});
membersNextBtn.addEventListener('click', () => {
  goToMembersPage(currentMembersPageIndex + 1);
});

mintMaxBtn.addEventListener('click', fillMintMax);
sendRecipientInput.addEventListener('input', updateSendSearchResults);
mintGroupBtn.addEventListener('click', mintGroupCrc);
sendGroupBtn.addEventListener('click', sendGroupCrc);

syncExternalLinkInputs('create');
syncExternalLinkInputs('profile');
updateCreateButtonState();
showDisconnectedState();
