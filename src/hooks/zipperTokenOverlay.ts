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

function blendColorSimple(base: number, accent: number, ratio: number): number {
	const br = (base >> 16) & 0xff,
		bg = (base >> 8) & 0xff,
		bb = base & 0xff;
	const ar = (accent >> 16) & 0xff,
		ag = (accent >> 8) & 0xff,
		ab = accent & 0xff;
	const r = Math.round(br + (ar - br) * ratio);
	const g = Math.round(bg + (ag - bg) * ratio);
	const b = Math.round(bb + (ab - bb) * ratio);
	return (r << 16) | (g << 8) | b;
}

const ZIPPER_OVERLAY_KEY = '_nimbleZipperSelectionOverlay';
const ZIPPER_OVERLAY_CLICK_KEY = '_nimbleZipperSelectionClickHandler';
const ZIPPER_PULSE_KEY = '_nimbleZipperPulseRing';
const ZIPPER_MULTI_SELECT_KEY = '_nimbleZipperMultiSelected';
const ZIPPER_HIT_TARGET_KEY = '_nimbleZipperHitTarget';

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

function createOverlay(
	token: TokenWithZipperOverlay,
	combatantId: string,
	hesitantBlocked = false,
): void {
	removeOverlay(token);

	const isMultiSelected = multiSelectedCombatantIds.has(combatantId);
	const tokenSize = Math.max(1, Number(token.w ?? 1));

	// --- Visual badge (non-interactive, on the token like turn-completed) ---
	const container = new PIXI.Container();
	container.eventMode = 'none';
	container.zIndex = 1020;

	// Green for normal, cyan for multi-selected, grey for hesitant-blocked
	const accentColor = hesitantBlocked ? 0x6b7280 : isMultiSelected ? 0x06b6d4 : 0x22c55e;

	// Rounded-rect badge matching the turn-completed icon style
	const fontSize = Math.max(12, Math.min(24, Math.round(tokenSize * 0.22)));
	const paddingX = Math.max(4, Math.round(fontSize * 0.35));
	const paddingY = Math.max(2, Math.round(fontSize * 0.2));

	const label = new PIXI.Text(isMultiSelected ? `${multiSelectedCombatantIds.size}` : '\u2713', {
		fontFamily: 'Signika',
		fontSize,
		fontWeight: '700',
		fill: 0xf6f9ff,
		align: 'center',
	});
	const rendererResolution = Number(
		canvas?.app?.renderer?.resolution ?? globalThis.devicePixelRatio ?? 1,
	);
	label.resolution = Math.max(2, Number.isFinite(rendererResolution) ? rendererResolution : 2);
	label.roundPixels = true;
	label.anchor.set(0, 0);

	const badgeWidth = Math.ceil(label.width + paddingX * 2);
	const badgeHeight = Math.ceil(label.height + paddingY * 2);
	const borderRadius = Math.max(4, Math.round(fontSize * 0.38));

	// Blend background color same way as the turn-completed badge
	const backgroundColor = blendColorSimple(0x0f1422, accentColor, 0.22);

	const background = new PIXI.Graphics();
	background.lineStyle({ width: 1, color: accentColor, alpha: 0.95 });
	background.beginFill(backgroundColor, 0.95);
	background.drawRoundedRect(0, 0, badgeWidth, badgeHeight, borderRadius);
	background.endFill();

	label.position.set(
		Math.round((badgeWidth - label.width) / 2),
		Math.round((badgeHeight - label.height) / 2),
	);

	container.addChild(background);
	container.addChild(label);

	// Position at top-right — same as the turn-completed badge
	const badgeLocalX = Math.round(tokenSize - badgeWidth / 2);
	const badgeLocalY = Math.round(-badgeHeight / 2);
	container.position.set(badgeLocalX, badgeLocalY);

	token.addChild(container);
	token[ZIPPER_OVERLAY_KEY] = container;

	// --- Separate interactive hit target on canvas.interface (not clipped by token) ---
	const interfaceLayer = (canvas as any).interface as PIXI.Container | undefined;
	if (interfaceLayer) {
		const hitTarget = new PIXI.Container();
		hitTarget.eventMode = 'static';
		hitTarget.cursor = hesitantBlocked ? 'not-allowed' : 'pointer';
		hitTarget.zIndex = 10000;

		const hitPad = 4;
		const hitBg = new PIXI.Graphics();
		hitBg.beginFill(0x000000, 0.001); // nearly invisible but needed for hit detection
		hitBg.drawRoundedRect(
			-hitPad,
			-hitPad,
			badgeWidth + hitPad * 2,
			badgeHeight + hitPad * 2,
			borderRadius,
		);
		hitBg.endFill();
		hitTarget.addChild(hitBg);

		// Position in world coordinates
		const tokenX = Number(token.x ?? 0);
		const tokenY = Number(token.y ?? 0);
		hitTarget.position.set(Math.round(tokenX + badgeLocalX), Math.round(tokenY + badgeLocalY));

		// Hover state — scale the visual badge and hit target together
		hitTarget.on('pointerover', () => {
			container.scale.set(1.2);
			hitTarget.scale.set(1.2);
		});
		hitTarget.on('pointerout', () => {
			container.scale.set(1);
			hitTarget.scale.set(1);
		});

		interfaceLayer.addChild(hitTarget);
		token[ZIPPER_HIT_TARGET_KEY] = hitTarget;
	}

	// Pulsing glow ring — sized to fit inside the dynamic token ring as a back-glow
	const tokenHeight = Math.max(1, Number(token.h ?? tokenSize));
	const centerX = Math.round(tokenSize / 2);
	const centerY = Math.round(tokenHeight / 2);
	// Shrink to ~80% of token bounds so it sits inside the dynamic ring frame
	const ringScale = 0.8;
	const radiusX = Math.round((tokenSize / 2) * ringScale);
	const radiusY = Math.round((tokenHeight / 2) * ringScale);
	const pulseRing = new PIXI.Graphics();

	// Outer soft glow layer (wider, more transparent)
	pulseRing.lineStyle({ width: isMultiSelected ? 6 : 5, color: accentColor, alpha: 0.2 });
	pulseRing.drawEllipse(centerX, centerY, radiusX + 3, radiusY + 3);

	// Main ring
	pulseRing.lineStyle({ width: isMultiSelected ? 3 : 2.5, color: accentColor, alpha: 0.5 });
	pulseRing.drawEllipse(centerX, centerY, radiusX, radiusY);

	pulseRing.eventMode = 'none';
	pulseRing.zIndex = 1019;
	token.addChild(pulseRing);
	token[ZIPPER_PULSE_KEY] = pulseRing;

	// Animate the pulse via the shared PIXI ticker (static low opacity for hesitant-blocked)
	const ticker = canvas?.app?.ticker as PIXI.Ticker | undefined;
	if (hesitantBlocked) {
		pulseRing.alpha = 0.2;
		container.alpha = 0.5;
	} else if (ticker) {
		const pulseCallback = () => {
			if (!pulseRing.parent) {
				ticker.remove(pulseCallback);
				return;
			}
			const time = performance.now() / 1000;
			pulseRing.alpha = 0.4 + Math.sin(time * 2.5) * 0.4;
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

	createOverlay(token, info.combatantId, info.hesitantBlocked);
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
