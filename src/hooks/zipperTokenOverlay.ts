import { SYSTEM_PATH } from '#system';
import {
	getCombatantZipperSide,
	getZipperActCounter,
	getZipperCurrentSide,
	hasZipperActed,
	isHesitantBlocked,
	isZipperAwaitingSelection,
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

// Resting opacity for the swords overlay; brightens to full (1.0) on hover.
const ZIPPER_OVERLAY_RESTING_ALPHA = 0.6;
// Hesitant-blocked tokens rest dimmer still to read as unavailable.
const ZIPPER_OVERLAY_HESITANT_ALPHA = 0.35;

// Bundled crossed-swords icon (game-icons.net, CC BY 3.0) rendered on eligible
// tokens. White-filled so it can be tinted per side via PIXI's sprite tint.
const CROSSED_SWORDS_TEXTURE_PATH = `${SYSTEM_PATH}/assets/icons/crossed-swords.svg`;

type TokenWithZipperOverlay = Token & {
	[ZIPPER_OVERLAY_KEY]?: PIXI.Container | null;
	[ZIPPER_OVERLAY_CLICK_KEY]?: (() => void) | null;
	[ZIPPER_PULSE_KEY]?: PIXI.Graphics | null;
	[ZIPPER_HIT_TARGET_KEY]?: PIXI.Container | null;
	[ZIPPER_MULTI_SELECT_KEY]?: boolean;
};

let didRegisterZipperTokenOverlay = false;
let lastNotifiedAwaitingSide: string | null = null;

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
	const isGM = Boolean(game.user?.isGM);

	const combatantsForScene = combat.combatants.contents.filter(
		(combatant) => getCombatantSceneId(combatant) === sceneId,
	);
	const groupSummaries = getMinionGroupSummaries(combatantsForScene);
	const seenGroupIds = new Set<string>();

	for (const combatant of combatantsForScene) {
		if (!combatant.tokenId) continue;
		if (isCombatantDead(combatant)) continue;
		if (hasZipperActed(combatant)) continue;
		if (getCombatantZipperSide(combatant) !== currentSide) continue;

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
			eligibleMap.set(combatant.tokenId, {
				combatantId: combatant.id,
				hesitantBlocked: isHesitantBlocked(combat, combatant.id),
				side: getCombatantZipperSide(combatant),
			});
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
): void {
	removeOverlay(token);

	const isMultiSelected = multiSelectedCombatantIds.has(combatantId);
	const tokenSize = Math.max(1, Number(token.w ?? 1));

	// --- Visual swords icon (non-interactive, rendered on the token) ---
	const container = new PIXI.Container();
	container.eventMode = 'none';
	container.zIndex = 1020;

	const tokenHeight = Math.max(1, Number(token.h ?? tokenSize));
	const centerX = Math.round(tokenSize / 2);
	const centerY = Math.round(tokenHeight / 2);

	// Tint: soft off-white for players, soft coral-red for GM/monsters, muted grey for hesitant
	const iconColor = hesitantBlocked ? 0x9ca3af : side === 'player' ? 0xe8edf3 : 0xfca5a5;
	const swordsSize = Math.max(20, Math.round(tokenSize * 0.5));

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
	}

	container.position.set(centerX, centerY);

	token.addChild(container);
	token[ZIPPER_OVERLAY_KEY] = container;

	// Dull at rest, full opacity on hover (see the hit-target handlers below).
	const restingAlpha = hesitantBlocked
		? ZIPPER_OVERLAY_HESITANT_ALPHA
		: ZIPPER_OVERLAY_RESTING_ALPHA;
	container.alpha = restingAlpha;

	// --- Interactive hit target on canvas.interface ---
	const interfaceLayer = (canvas as any).interface as PIXI.Container | undefined;
	let isHovered = false;
	if (interfaceLayer) {
		const hitTarget = new PIXI.Container();
		hitTarget.eventMode = 'static';
		hitTarget.cursor = hesitantBlocked ? 'not-allowed' : 'pointer';
		hitTarget.zIndex = 10000;

		const hitPad = 6;
		const hitBg = new PIXI.Graphics();
		hitBg.beginFill(0x000000, 0.001);
		hitBg.drawCircle(0, 0, Math.round(swordsSize / 2) + hitPad);
		hitBg.endFill();
		hitTarget.addChild(hitBg);

		const tokenX = Number(token.x ?? 0);
		const tokenY = Number(token.y ?? 0);
		hitTarget.position.set(Math.round(tokenX + centerX), Math.round(tokenY + centerY));

		// Hover: stop pulsing, snap to slightly larger than max pulse size,
		// and brighten to full opacity.
		hitTarget.on('pointerover', () => {
			isHovered = true;
			container.scale.set(1.15);
			container.alpha = 1;
		});
		hitTarget.on('pointerout', () => {
			isHovered = false;
			container.alpha = restingAlpha;
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

	createOverlay(token, info.combatantId, info.hesitantBlocked, info.side);
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

	const eligibleMap = buildEligibleTokenIds();
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
		const eligibleMap = buildEligibleTokenIds();
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
