import { SYSTEM_PATH } from '#system';
import {
	getCombatantZipperSide,
	getNextUnactedOccurrence,
	getRemainingOccurrenceCountForSide,
	getTotalOccurrencesForCombatant,
	getZipperActCounter,
	getZipperCurrentSide,
	hasAnyOccurrenceUnacted,
	isHesitantBlocked,
	isZipperAwaitingSelection,
	isZipperFirstSidePending,
	isZipperInitiativeActive,
} from '../documents/combat/zipperTurnState.js';
import { requestZipperCombatantSelection } from '../utils/combatTurnActions.js';
import { isCombatantDead } from '../utils/isCombatantDead.js';
import { isCombatStarted } from '../utils/isCombatStarted.js';
import {
	getEffectiveMinionGroupLeader,
	getMinionGroupId,
	getMinionGroupSummaries,
} from '../utils/minionGrouping.js';

const ZIPPER_OVERLAY_KEY = '_nimbleZipperSelectionOverlay';
const ZIPPER_OVERLAY_CLICK_KEY = '_nimbleZipperSelectionClickHandler';
const ZIPPER_PULSE_KEY = '_nimbleZipperPulseRing';
const ZIPPER_MULTI_SELECT_KEY = '_nimbleZipperMultiSelected';
const ZIPPER_HIT_TARGET_KEY = '_nimbleZipperHitTarget';
const ZIPPER_TOOLTIP_KEY = '_nimbleZipperTooltip';
const ZIPPER_OVERLAY_STATE_KEY = '_nimbleZipperOverlayState';

// Resting opacity for the swords overlay; brightens to full (1.0) on hover.
const ZIPPER_OVERLAY_RESTING_ALPHA = 0.8;
// Hesitant-blocked tokens rest dimmer still to read as unavailable.
const ZIPPER_OVERLAY_HESITANT_ALPHA = 0.55;

// Bundled crossed-swords icon (game-icons.net, CC BY 3.0) rendered on eligible
// tokens. White-filled so it can be tinted per side via PIXI's sprite tint.
const CROSSED_SWORDS_TEXTURE_PATH = `${SYSTEM_PATH}/assets/icons/crossed-swords.svg`;

type TokenWithZipperOverlay = Token & {
	[ZIPPER_OVERLAY_KEY]?: PIXI.Container | null;
	[ZIPPER_OVERLAY_CLICK_KEY]?: (() => void) | null;
	[ZIPPER_PULSE_KEY]?: PIXI.Graphics | null;
	[ZIPPER_HIT_TARGET_KEY]?: PIXI.Container | null;
	[ZIPPER_MULTI_SELECT_KEY]?: boolean;
	[ZIPPER_TOOLTIP_KEY]?: PIXI.Container | null;
	[ZIPPER_OVERLAY_STATE_KEY]?: string | null;
};

let didRegisterZipperTokenOverlay = false;
let lastNotifiedAwaitingSide: string | null = null;

// Memoized result of buildEligibleTokenIds for the current animation frame.
// refreshToken can fire dozens of times per tick (one per moving/animating
// token); without this cache each call would re-iterate combatants, group
// summaries, and occurrence counts. Invalidated whenever combat state changes.
let cachedEligibleMap: Map<string, EligibleTokenInfo> | null = null;

function invalidateEligibleMapCache(): void {
	cachedEligibleMap = null;
}

function getEligibleTokenIds(): Map<string, EligibleTokenInfo> {
	if (cachedEligibleMap) return cachedEligibleMap;
	const map = buildEligibleTokenIds();
	cachedEligibleMap = map;
	// Clear on the next animation frame: refreshToken fires can be interleaved
	// with other macrotasks within a single frame, so a microtask-scoped clear
	// would invalidate too eagerly. rAF clears strictly between frames, which
	// is the granularity at which the eligibility map can meaningfully change.
	requestAnimationFrame(() => {
		cachedEligibleMap = null;
	});
	return map;
}

// ---------------------------------------------------------------------------
// GM multi-select state for ad-hoc group turns
// ---------------------------------------------------------------------------

/** Set of combatant IDs the GM has shift-selected for a group turn. */
const multiSelectedCombatantIds = new Set<string>();

function clearMultiSelection(): void {
	multiSelectedCombatantIds.clear();
	// Remove visual indicators from all tokens
	if (!canvas?.tokens) return;
	for (const token of canvas.tokens.placeables) {
		const t = token as TokenWithZipperOverlay;
		if (t[ZIPPER_MULTI_SELECT_KEY]) {
			t[ZIPPER_MULTI_SELECT_KEY] = false;
		}
	}
}

type CombatWithZipperGroupSelect = Combat & {
	selectZipperGroup?: (combatantIds: string[]) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Combat / scene helpers
// ---------------------------------------------------------------------------

function getCombatantSceneId(combatant: Combatant.Implementation): string | undefined {
	if (combatant.sceneId) return combatant.sceneId;
	if (combatant.token?.parent?.id) return combatant.token.parent.id;
	return undefined;
}

function getCombatForScene(sceneId: string): Combat | null {
	const activeCombat = game.combat;
	if (activeCombat?.active && activeCombat.scene?.id === sceneId) return activeCombat;

	const viewedCombat = game.combats.viewed ?? null;
	if (viewedCombat?.scene?.id === sceneId) return viewedCombat;

	return (
		game.combats.contents.find(
			(combat) =>
				combat.scene?.id === sceneId ||
				combat.combatants.contents.some((combatant) => getCombatantSceneId(combatant) === sceneId),
		) ?? null
	);
}

// ---------------------------------------------------------------------------
// Build set of token IDs eligible for selection overlay
// ---------------------------------------------------------------------------

interface EligibleTokenInfo {
	combatantId: string;
	hesitantBlocked: boolean;
	side: 'player' | 'gm';
	/** True when this combatant is the last eligible on their side — selecting
	 *  will pass the turn to the other side (Feature 7 end-of-side telegraph). */
	isLastOnSide: boolean;
	/** For solo monsters with N > 1 turns per round, an "X/N" label indicating
	 *  which occurrence is about to be selected. `undefined` for single-occurrence
	 *  combatants (label is hidden). */
	occurrenceLabel: string | undefined;
}

function buildEligibleTokenIds(): Map<string, EligibleTokenInfo> {
	// Returns Map<tokenId, EligibleTokenInfo>
	const eligibleMap = new Map<string, EligibleTokenInfo>();

	if (!isZipperInitiativeActive()) return eligibleMap;

	const sceneId = canvas.scene?.id;
	if (!sceneId) return eligibleMap;

	const combat = getCombatForScene(sceneId);
	if (!combat || !isCombatStarted(combat)) return eligibleMap;
	if (!isZipperAwaitingSelection(combat)) return eligibleMap;

	const currentSide = getZipperCurrentSide(combat);
	const firstSidePending = isZipperFirstSidePending(combat);
	const isGM = Boolean(game.user?.isGM);

	const combatantsForScene = combat.combatants.contents.filter(
		(combatant) => getCombatantSceneId(combatant) === sceneId,
	);
	const groupSummaries = getMinionGroupSummaries(combatantsForScene);
	const seenGroupIds = new Set<string>();

	for (const combatant of combatantsForScene) {
		if (!combatant.tokenId) continue;
		if (isCombatantDead(combatant)) continue;
		if (!hasAnyOccurrenceUnacted(combat, combatant)) continue;
		// Open first-side selection: either side can pick first, so show overlays
		// on every eligible token regardless of currentSide.
		if (!firstSidePending && getCombatantZipperSide(combatant) !== currentSide) continue;

		// For minion groups, only show overlay on the group leader
		const groupId = getMinionGroupId(combatant);
		if (groupId) {
			if (seenGroupIds.has(groupId)) continue;
			seenGroupIds.add(groupId);
			const summary = groupSummaries.get(groupId);
			if (summary) {
				const leader = getEffectiveMinionGroupLeader(summary, { aliveOnly: true });
				if (leader && leader.id !== combatant.id) continue;
			}
		}

		// Players can only select tokens they own; GM sees all eligible on their side
		if (!isGM && !combatant.actor?.isOwner) continue;

		if (combatant.id) {
			// For solos: show "X/N" badge so the GM knows which of N turns is up
			const totalOccurrences = getTotalOccurrencesForCombatant(combat, combatant);
			const nextOccurrence = getNextUnactedOccurrence(combat, combatant);
			const occurrenceLabel =
				totalOccurrences > 1 && nextOccurrence >= 0
					? `${nextOccurrence + 1}/${totalOccurrences}`
					: undefined;
			eligibleMap.set(combatant.tokenId, {
				combatantId: combatant.id,
				hesitantBlocked: isHesitantBlocked(combat, combatant.id),
				side: getCombatantZipperSide(combatant),
				isLastOnSide: false, // filled in below once we know the total
				occurrenceLabel,
			});
		}
	}

	// Feature 7 — last-on-side telegraph. Count remaining OCCURRENCES (not
	// combatants), so a solo with 2/3 turns left doesn't trigger the amber
	// "last on side" warning. Telegraph fires when literally one turn remains.
	// Skipped during firstSidePending — no side has been chosen yet, so the
	// "last on this side" concept doesn't apply.
	if (!firstSidePending) {
		const remainingOccurrencesOnCurrentSide = getRemainingOccurrenceCountForSide(
			combat,
			currentSide,
		);
		if (remainingOccurrencesOnCurrentSide === 1) {
			for (const info of eligibleMap.values()) {
				if (info.side === currentSide) info.isLastOnSide = true;
			}
		}
	}

	return eligibleMap;
}

// ---------------------------------------------------------------------------
// PIXI overlay rendering
// ---------------------------------------------------------------------------

function removeOverlay(token: TokenWithZipperOverlay): void {
	const overlay = token[ZIPPER_OVERLAY_KEY];
	if (overlay) {
		overlay.parent?.removeChild(overlay);
		overlay.destroy({ children: true });
		token[ZIPPER_OVERLAY_KEY] = null;
	}

	const cleanupClick = token[ZIPPER_OVERLAY_CLICK_KEY];
	if (cleanupClick) {
		cleanupClick();
		token[ZIPPER_OVERLAY_CLICK_KEY] = null;
	}

	const pulseRing = token[ZIPPER_PULSE_KEY];
	if (pulseRing) {
		pulseRing.parent?.removeChild(pulseRing);
		pulseRing.destroy();
		token[ZIPPER_PULSE_KEY] = null;
	}

	const hitTarget = token[ZIPPER_HIT_TARGET_KEY];
	if (hitTarget) {
		hitTarget.parent?.removeChild(hitTarget);
		hitTarget.destroy({ children: true });
		token[ZIPPER_HIT_TARGET_KEY] = null;
	}

	hideHesitantTooltip(token);
	token[ZIPPER_OVERLAY_STATE_KEY] = null;
}

/**
 * Feature 5 — show a small PIXI text overlay near the badge explaining why a
 * hesitant combatant can't be selected. Cleaned up on pointerout / overlay
 * removal. PIXI rather than DOM tooltip because the badge lives on the canvas.
 */
function showHesitantTooltip(token: TokenWithZipperOverlay, badgeX: number, badgeY: number): void {
	hideHesitantTooltip(token);
	const text =
		game.i18n?.localize?.('NIMBLE.zipperInitiative.hesitantBlocked') ??
		'Hesitant heroes must wait for non-hesitant heroes to act first';

	const label = new PIXI.Text(text, {
		fontFamily: 'Signika, sans-serif',
		fontSize: 14,
		fontWeight: '600',
		fill: 0xfde68a,
		stroke: 0x000000,
		strokeThickness: 4,
		align: 'center',
		wordWrap: true,
		wordWrapWidth: 280,
	});
	const renderer = canvas?.app?.renderer as { resolution?: number } | undefined;
	label.resolution = Math.max(2, Number(renderer?.resolution ?? 2));
	label.roundPixels = true;
	label.anchor.set(0.5, 1);
	// Position above the badge with a small gap.
	label.position.set(badgeX, badgeY - 24);
	token.addChild(label);
	token[ZIPPER_TOOLTIP_KEY] = label;
}

function hideHesitantTooltip(token: TokenWithZipperOverlay): void {
	const tooltip = token[ZIPPER_TOOLTIP_KEY];
	if (tooltip) {
		tooltip.parent?.removeChild(tooltip);
		tooltip.destroy();
		token[ZIPPER_TOOLTIP_KEY] = null;
	}
}

/**
 * Build a crossed-swords sprite from the bundled SVG, tinted and sized in px.
 * PIXI caches the texture by path; the size is (re)applied once the SVG has
 * rasterized so the sprite never lingers at the wrong scale on first load.
 */
function createSwordsSprite(sizePx: number, tint: number): PIXI.Sprite {
	const texture = PIXI.Texture.from(CROSSED_SWORDS_TEXTURE_PATH);
	const sprite = new PIXI.Sprite(texture);
	sprite.anchor.set(0.5, 0.5);
	sprite.tint = tint;

	const applySize = () => {
		// The SVG rasterizes asynchronously; by the time `loaded` fires the
		// sprite may already have been destroyed (a refresh burst on combat
		// start tears overlays down mid-load). A destroyed sprite has a null
		// transform, so the width setter would throw reading `scale`.
		if (sprite.destroyed || !sprite.transform) return;
		sprite.width = sizePx;
		sprite.height = sizePx;
	};
	applySize();
	if (!texture.baseTexture.valid) {
		texture.baseTexture.once('loaded', applySize);
	}
	return sprite;
}

function createOverlay(
	token: TokenWithZipperOverlay,
	combatantId: string,
	hesitantBlocked = false,
	side: 'player' | 'gm' = 'player',
	isLastOnSide = false,
	occurrenceLabel?: string,
): void {
	removeOverlay(token);

	const isMultiSelected = multiSelectedCombatantIds.has(combatantId);
	const tokenSize = Math.max(1, Number(token.w ?? 1));

	// --- Visual swords icon (non-interactive, rendered on the token) ---
	const container = new PIXI.Container();
	container.eventMode = 'none';
	container.zIndex = 1020;

	// Bug 3 — corner badge: position in the top-right corner of the token so
	// the token center stays clickable for opening the character sheet. The
	// badge sits slightly inset from the corner so it reads as part of the
	// token without overflowing the grid cell.
	const swordsSize = Math.max(16, Math.round(tokenSize * 0.32));
	const cornerMargin = Math.max(2, Math.round(swordsSize * 0.18));
	const badgeX = Math.round(tokenSize - swordsSize / 2 - cornerMargin);
	const badgeY = Math.round(swordsSize / 2 + cornerMargin);

	// Tint priority: hesitant grey > end-of-side amber > side default (player white / GM coral).
	// Feature 7 — amber telegraph: when this is the last eligible combatant on
	// the current side, the badge tints amber to warn that selecting will pass
	// the turn to the other side.
	const iconColor = hesitantBlocked
		? 0x9ca3af
		: isLastOnSide
			? 0xfbbf24
			: side === 'player'
				? 0xe8edf3
				: 0xfca5a5;

	// Soft dark shadow behind the icon for contrast against light maps.
	const shadowSprite = createSwordsSprite(Math.round(swordsSize * 1.06), 0x000000);
	shadowSprite.alpha = 0.45;
	container.addChild(shadowSprite);

	// Main crossed-swords icon.
	const iconSprite = createSwordsSprite(swordsSize, iconColor);
	container.addChild(iconSprite);

	// GM multi-select: show how many tokens are queued for the group turn.
	if (isMultiSelected) {
		const rendererResolution = Number(
			canvas?.app?.renderer?.resolution ?? globalThis.devicePixelRatio ?? 1,
		);
		const resolution = Math.max(2, Number.isFinite(rendererResolution) ? rendererResolution : 2);
		const countLabel = new PIXI.Text(String(multiSelectedCombatantIds.size), {
			fontFamily: 'Signika, sans-serif',
			fontSize: Math.max(12, Math.round(swordsSize * 0.42)),
			fontWeight: '900',
			fill: 0xffffff,
			stroke: 0x000000,
			strokeThickness: 4,
			align: 'center',
		});
		countLabel.resolution = resolution;
		countLabel.roundPixels = true;
		countLabel.anchor.set(0.5, 0.5);
		countLabel.position.set(Math.round(swordsSize * 0.45), Math.round(swordsSize * 0.45));
		container.addChild(countLabel);
	} else if (occurrenceLabel) {
		// Solo monster "X/N" badge — tells the GM which of N turns is about to
		// be taken. Anchored at the bottom-right of the swords sprite so it
		// reads as a counter underneath the icon.
		const rendererResolution = Number(
			canvas?.app?.renderer?.resolution ?? globalThis.devicePixelRatio ?? 1,
		);
		const resolution = Math.max(2, Number.isFinite(rendererResolution) ? rendererResolution : 2);
		const turnLabel = new PIXI.Text(occurrenceLabel, {
			fontFamily: 'Signika, sans-serif',
			fontSize: Math.max(10, Math.round(swordsSize * 0.36)),
			fontWeight: '700',
			fill: 0xfde68a,
			stroke: 0x000000,
			strokeThickness: 3,
			align: 'center',
		});
		turnLabel.resolution = resolution;
		turnLabel.roundPixels = true;
		turnLabel.anchor.set(0.5, 0);
		// Below the swords, slightly offset down from the icon center.
		turnLabel.position.set(0, Math.round(swordsSize * 0.42));
		container.addChild(turnLabel);
	}

	container.position.set(badgeX, badgeY);

	token.addChild(container);
	token[ZIPPER_OVERLAY_KEY] = container;

	// Dull at rest, full opacity on hover (see the hit-target handlers below).
	const restingAlpha = hesitantBlocked
		? ZIPPER_OVERLAY_HESITANT_ALPHA
		: ZIPPER_OVERLAY_RESTING_ALPHA;
	container.alpha = restingAlpha;

	// --- Interactive hit target on canvas.interface ---
	// Bug 3 — the hit target now sits over the corner badge only, NOT over the
	// token center. Token-center clicks reach the token's default click handler
	// (opens the character sheet) instead of being swallowed by this overlay.
	const interfaceLayer = (canvas as any).interface as PIXI.Container | undefined;
	let isHovered = false;
	if (interfaceLayer) {
		const hitTarget = new PIXI.Container();
		hitTarget.eventMode = 'static';
		hitTarget.cursor = hesitantBlocked ? 'not-allowed' : 'pointer';
		hitTarget.zIndex = 10000;

		// Tight hit area sized to the badge; small pad for easier targeting on
		// small tokens but never spilling onto the token center.
		const hitPad = 3;
		const hitBg = new PIXI.Graphics();
		hitBg.beginFill(0x000000, 0.001);
		hitBg.drawCircle(0, 0, Math.round(swordsSize / 2) + hitPad);
		hitBg.endFill();
		hitTarget.addChild(hitBg);

		const tokenX = Number(token.x ?? 0);
		const tokenY = Number(token.y ?? 0);
		hitTarget.position.set(Math.round(tokenX + badgeX), Math.round(tokenY + badgeY));

		// Hover: grow on hover (Bug 3 affordance for the smaller badge), full opacity.
		hitTarget.on('pointerover', () => {
			isHovered = true;
			container.scale.set(1.25);
			container.alpha = 1;
			// Feature 5 — hesitant tooltip on hover. Show the block reason at
			// the cursor instead of waiting for a misclick to fire a notification.
			if (hesitantBlocked) {
				showHesitantTooltip(token, badgeX, badgeY);
			}
		});
		hitTarget.on('pointerout', () => {
			isHovered = false;
			container.alpha = restingAlpha;
			hideHesitantTooltip(token);
		});

		interfaceLayer.addChild(hitTarget);
		token[ZIPPER_HIT_TARGET_KEY] = hitTarget;
	}

	// Pulsing animation — pauses on hover and snaps to hover scale.
	// Hesitant tokens don't pulse; their resting alpha is set above.
	token[ZIPPER_PULSE_KEY] = null;
	const ticker = canvas?.app?.ticker as PIXI.Ticker | undefined;
	if (!hesitantBlocked && ticker) {
		const pulseCallback = () => {
			if (!container.parent) {
				ticker.remove(pulseCallback);
				return;
			}
			if (isHovered) return; // hold at hover scale
			const time = performance.now() / 1000;
			const scale = 0.85 + Math.sin(time * 1) * 0.15; // gentle oscillation 0.7–1.0
			container.scale.set(scale);
		};
		ticker.add(pulseCallback);
	}

	// Click handler — attach to the hit target (on canvas.interface) so clicks work
	// even outside the token boundary. Falls back to visual container if no hit target.
	const combat = getCombatForScene(canvas.scene?.id ?? '');
	const clickTarget = token[ZIPPER_HIT_TARGET_KEY] ?? container;
	if (combat && clickTarget) {
		const clickHandler = (event: PIXI.FederatedPointerEvent) => {
			event.stopPropagation();

			// Block selection for hesitant-blocked combatants
			if (hesitantBlocked) {
				ui.notifications?.warn(
					game.i18n?.localize('NIMBLE.zipperInitiative.hesitantBlocked') ??
						'Hesitant heroes must wait for non-hesitant heroes to act first',
				);
				return;
			}

			const isGM = Boolean(game.user?.isGM);
			const currentSide = getZipperCurrentSide(combat);

			// GM shift-click: toggle multi-selection for group turns
			if (event.shiftKey && isGM && currentSide === 'gm') {
				if (multiSelectedCombatantIds.has(combatantId)) {
					multiSelectedCombatantIds.delete(combatantId);
					token[ZIPPER_MULTI_SELECT_KEY] = false;
				} else {
					multiSelectedCombatantIds.add(combatantId);
					token[ZIPPER_MULTI_SELECT_KEY] = true;
				}
				// Refresh all overlays to update visual indicators
				refreshAllTokenOverlays();
				return;
			}

			// GM normal click with multi-selection active: activate the group
			if (isGM && multiSelectedCombatantIds.size > 0) {
				// Include the clicked combatant in the group
				multiSelectedCombatantIds.add(combatantId);
				if (multiSelectedCombatantIds.size >= 2) {
					const ids = [...multiSelectedCombatantIds];
					clearMultiSelection();
					const combatWithGroup = combat as CombatWithZipperGroupSelect;
					if (typeof combatWithGroup.selectZipperGroup === 'function') {
						void combatWithGroup.selectZipperGroup(ids);
					}
					return;
				}
				// Only 1 in the set (the one just clicked) — fall through to single select
				clearMultiSelection();
			}

			void requestZipperCombatantSelection({ combat, combatantId });
		};
		clickTarget.on('pointerdown', clickHandler);
		token[ZIPPER_OVERLAY_CLICK_KEY] = () => {
			clickTarget.off('pointerdown', clickHandler);
		};
	}
}

// ---------------------------------------------------------------------------
// Refresh logic
// ---------------------------------------------------------------------------

function refreshTokenOverlay(
	token: TokenWithZipperOverlay,
	eligibleMap: Map<string, EligibleTokenInfo>,
): void {
	const tokenId = token.document?.id ?? '';
	const info = tokenId ? eligibleMap.get(tokenId) : undefined;

	if (!info) {
		removeOverlay(token);
		return;
	}

	// Skip rebuilding the PIXI tree when the visible state hasn't changed.
	// refreshToken fires every animation frame for moving tokens; without this
	// guard each frame would destroy + reallocate sprites, hit target, and ticker
	// callback, tanking canvas FPS during any token interaction.
	const isMultiSelected = multiSelectedCombatantIds.has(info.combatantId);
	const tokenSize = Math.max(1, Number(token.w ?? 1));
	// Include the group's total selected size, not just this token's membership:
	// the badge count label renders `multiSelectedCombatantIds.size`, so every
	// member's overlay needs to re-render when the set grows from 2 → 3.
	const multiSelectSize = isMultiSelected ? multiSelectedCombatantIds.size : 0;
	const stateHash = [
		info.combatantId,
		info.hesitantBlocked ? 1 : 0,
		info.side,
		info.isLastOnSide ? 1 : 0,
		info.occurrenceLabel ?? '',
		multiSelectSize,
		tokenSize,
	].join('|');
	if (token[ZIPPER_OVERLAY_KEY] && token[ZIPPER_OVERLAY_STATE_KEY] === stateHash) {
		return;
	}

	createOverlay(
		token,
		info.combatantId,
		info.hesitantBlocked,
		info.side,
		info.isLastOnSide,
		info.occurrenceLabel,
	);
	token[ZIPPER_OVERLAY_STATE_KEY] = stateHash;
}

function notifySelectionPhaseIfNeeded(): void {
	if (!isZipperInitiativeActive()) {
		lastNotifiedAwaitingSide = null;
		return;
	}

	const sceneId = canvas.scene?.id;
	if (!sceneId) return;
	const combat = getCombatForScene(sceneId);
	if (!combat || !isCombatStarted(combat)) {
		lastNotifiedAwaitingSide = null;
		return;
	}

	if (!isZipperAwaitingSelection(combat)) {
		lastNotifiedAwaitingSide = null;
		return;
	}

	const side = getZipperCurrentSide(combat);
	const actCounter = getZipperActCounter(combat);
	const notifyKey = `${combat.id}-${combat.round}-${side}-${actCounter}`;
	if (lastNotifiedAwaitingSide === notifyKey) return;
	lastNotifiedAwaitingSide = notifyKey;

	const notifications = ui?.notifications as { info?: (message: string) => void } | undefined;
	if (!notifications?.info) return;

	const isGM = Boolean(game.user?.isGM);
	if (side === 'player' && !isGM) {
		notifications.info(
			game.i18n?.localize?.('NIMBLE.zipperInitiative.yourTurn') ??
				'Your turn — select a hero to act',
		);
	}
}

function refreshAllTokenOverlays(): void {
	if (!canvas?.ready || !canvas?.tokens) return;

	// Force a fresh map for "all tokens" refreshes — these are called from
	// combat hooks where state has just changed, so any cached map is stale.
	invalidateEligibleMapCache();
	const eligibleMap = getEligibleTokenIds();
	for (const token of canvas.tokens.placeables) {
		refreshTokenOverlay(token as TokenWithZipperOverlay, eligibleMap);
	}
	notifySelectionPhaseIfNeeded();
}

function clearAllTokenOverlays(): void {
	if (!canvas?.tokens) return;
	for (const token of canvas.tokens.placeables) {
		removeOverlay(token as TokenWithZipperOverlay);
	}
}

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

export default function registerZipperTokenOverlay(): void {
	if (didRegisterZipperTokenOverlay) return;
	didRegisterZipperTokenOverlay = true;

	Hooks.on('canvasReady', () => {
		refreshAllTokenOverlays();
	});

	Hooks.on('canvasTearDown', () => {
		clearMultiSelection();
		clearAllTokenOverlays();
	});

	Hooks.on('refreshToken', (token: Token) => {
		// refreshToken fires per animation frame for moving tokens. Use the
		// per-tick memoized eligible map so a burst of refreshes shares one
		// O(combatants) computation, and let the state-hash check inside
		// refreshTokenOverlay skip the PIXI rebuild when nothing visible changed.
		const eligibleMap = getEligibleTokenIds();
		refreshTokenOverlay(token as TokenWithZipperOverlay, eligibleMap);
	});

	Hooks.on('updateCombat', (_combat: Combat, change: Record<string, unknown>) => {
		// Clear multi-selection when side changes or selection mode ends
		const flags = change?.flags as Record<string, Record<string, unknown>> | undefined;
		const nimbleFlags = flags?.nimble as Record<string, unknown> | undefined;
		if (nimbleFlags && ('currentSide' in nimbleFlags || 'awaitingSelection' in nimbleFlags)) {
			clearMultiSelection();
		}
		refreshAllTokenOverlays();
	});

	Hooks.on('deleteCombat', () => {
		clearMultiSelection();
		clearAllTokenOverlays();
	});

	Hooks.on('createCombatant', () => {
		refreshAllTokenOverlays();
	});

	Hooks.on('updateCombatant', () => {
		refreshAllTokenOverlays();
	});

	Hooks.on('deleteCombatant', () => {
		refreshAllTokenOverlays();
	});
}
